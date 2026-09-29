/**
 * `PublishingRepository` 的 Prisma 实现。
 *
 * ⚠ 只写 `daily_editions` / `daily_sections` / `daily_items`。
 * 它**读** `contents` / `editorial_reviews` / `sources`（候选与快照）
 * 但**从不写** —— 内容状态归 Agent 05/07。
 */

import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  ContentPipelineStatus,
  DailyEditionStatus,
  type ContentType,
  type DailyDisplayStyle,
  type SourceKind,
  type SourceTier,
} from '@signal/contracts';
import type { DraftCandidate } from './draft-compiler';
import type { EditionSnapshot } from './preflight';
import type {
  PublishingEditionRow,
  PublishingRepository,
  PublishingSectionInput,
} from './publishing.repository';
import { PublishingPrismaService } from './prisma.service';

/** 期号分配的并发重试次数（与 api 侧同一手法，理由见那边的注释）。 */
export const MAX_EDITION_NO_ATTEMPTS = 3;

/** 一次候选查询最多取多少条 —— 防止一次把整库读进内存。 */
export const CANDIDATE_QUERY_LIMIT = 300;

const iso = (value: Date | null): string | null => (value === null ? null : value.toISOString());

/** `@db.Date` → 业务日字符串（UTC 午夜，与 Prisma 的表示一致）。 */
const toBusinessDate = (value: Date): string => value.toISOString().slice(0, 10);

/** 业务日字符串 → `@db.Date` 的 `Date`（⚠ 不要掺本地时区偏移）。 */
const fromBusinessDate = (value: string): Date => new Date(`${value}T00:00:00.000Z`);

const EDITION_SELECT = {
  id: true,
  businessDate: true,
  editionNo: true,
  status: true,
  scheduledAt: true,
  publishedAt: true,
} as const;

function isEditionNoConflict(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002' &&
    JSON.stringify(error.meta?.target ?? '').includes('edition_no')
  );
}

@Injectable()
export class PrismaPublishingRepository implements PublishingRepository {
  constructor(@Inject(PublishingPrismaService) private readonly prisma: PublishingPrismaService) {}

  private toRow(row: {
    id: bigint;
    businessDate: Date;
    editionNo: number | null;
    status: string;
    scheduledAt: Date | null;
    publishedAt: Date | null;
  }): PublishingEditionRow {
    return {
      editionId: String(row.id),
      businessDate: toBusinessDate(row.businessDate),
      editionNo: row.editionNo,
      status: row.status as DailyEditionStatus,
      scheduledAt: iso(row.scheduledAt),
      publishedAt: iso(row.publishedAt),
    };
  }

  async findEdition(businessDate: string): Promise<PublishingEditionRow | null> {
    const row = await this.prisma.dailyEdition.findUnique({
      where: { businessDate: fromBusinessDate(businessDate) },
      select: EDITION_SELECT,
    });
    return row === null ? null : this.toRow(row);
  }

  async ensureDraft(businessDate: string): Promise<PublishingEditionRow> {
    const existing = await this.findEdition(businessDate);
    if (existing !== null) return existing;

    try {
      const created = await this.prisma.dailyEdition.create({
        data: { businessDate: fromBusinessDate(businessDate), status: DailyEditionStatus.DRAFT },
        select: EDITION_SELECT,
      });
      return this.toRow(created);
    } catch (error) {
      // 并发下别人刚建了同一期（`business_date` 唯一）→ 读回来即可。
      const again = await this.findEdition(businessDate);
      if (again !== null) return again;
      throw error;
    }
  }

  async replaceSections(
    editionId: string,
    sections: readonly PublishingSectionInput[],
  ): Promise<void> {
    const id = BigInt(editionId);

    // **同一事务**：先删旧版块（`items` 随 `DailySection` 级联），再建新的。
    // 分开做会出现「旧版块没了、新的一边建一边失败」的半截状态。
    await this.prisma.$transaction(async (tx) => {
      await tx.dailySection.deleteMany({ where: { editionId: id } });

      for (const section of sections) {
        const created = await tx.dailySection.create({
          data: {
            editionId: id,
            type: section.type as never,
            title: section.title,
            sortOrder: section.sortOrder,
          },
          select: { id: true },
        });

        if (section.items.length === 0) continue;

        await tx.dailyItem.createMany({
          data: section.items.map((item) => ({
            sectionId: created.id,
            contentId: BigInt(item.contentId),
            displayStyle: item.displayStyle as never,
            sortOrder: item.sortOrder,
          })),
        });
      }
    });
  }

  async findCandidates(input: {
    startUtc: Date;
    endUtc: Date;
    limit: number;
  }): Promise<DraftCandidate[]> {
    const rows = await this.prisma.content.findMany({
      where: {
        // `docs/10` 的候选口径。
        pipelineStatus: ContentPipelineStatus.APPROVED,
        review: { is: { includeDailyCandidate: true, status: 'APPROVED' } },
        OR: [
          { publishedAt: { gte: input.startUtc, lt: input.endUtc } },
          // `publishedAt` 可空（部分来源不给）—— 用 `createdAt` 兜底，
          // 否则这些内容**永远进不了日报**，而且静默无错。
          { publishedAt: null, createdAt: { gte: input.startUtc, lt: input.endUtc } },
        ],
      },
      select: {
        id: true,
        title: true,
        summary: true,
        finalScore: true,
        publishedAt: true,
        createdAt: true,
        type: true,
        eventId: true,
        event: { select: { primaryContentId: true } },
        source: { select: { id: true, name: true, kind: true, tier: true, official: true } },
      },
      // ⚠ 顺序必须与 `compareCandidates` 的决胜键一致，否则「SQL 的顺序」
      // 与「编译器的顺序」会在同分时给出不同结果 —— 而编译器已经用
      // contentId 兜了底，所以这里给出主序就够。
      orderBy: [{ finalScore: 'desc' }, { publishedAt: 'desc' }],
      take: Math.min(input.limit, CANDIDATE_QUERY_LIMIT),
    });

    return rows.map((row) => ({
      contentId: String(row.id),
      title: row.title,
      summary: row.summary,
      sourceId: String(row.source.id),
      sourceName: row.source.name,
      sourceKind: row.source.kind as SourceKind,
      sourceTier: row.source.tier as SourceTier,
      official: row.source.official,
      finalScore: row.finalScore === null ? null : Number(row.finalScore),
      // `publishedAt` 缺失时用 `createdAt` 兜底：编译器要用它排序，
      // 而 `null` 会让同分内容之间的顺序失去一个决胜键。
      publishedAt: (row.publishedAt ?? row.createdAt).toISOString(),
      eventId: row.eventId === null ? null : String(row.eventId),
      isEventPrimary:
        row.event === null || row.event.primaryContentId === null
          ? true
          : String(row.event.primaryContentId) === String(row.id),
      contentType: row.type as ContentType,
    }));
  }

  async snapshot(editionId: string): Promise<EditionSnapshot | null> {
    const edition = await this.prisma.dailyEdition.findUnique({
      where: { id: BigInt(editionId) },
      select: {
        businessDate: true,
        status: true,
        sections: {
          select: {
            id: true,
            type: true,
            title: true,
            sortOrder: true,
            items: {
              select: {
                id: true,
                contentId: true,
                displayStyle: true,
                sortOrder: true,
                content: {
                  select: {
                    pipelineStatus: true,
                    originalUrl: true,
                    source: { select: { name: true } },
                  },
                },
              },
              orderBy: { sortOrder: 'asc' },
            },
          },
          orderBy: { sortOrder: 'asc' },
        },
      },
    });
    if (edition === null) return null;

    return {
      businessDate: toBusinessDate(edition.businessDate),
      status: String(edition.status),
      sections: edition.sections.map((section) => ({
        sectionId: String(section.id),
        type: String(section.type),
        title: section.title,
        sortOrder: section.sortOrder,
        items: section.items.map((item) => ({
          itemId: String(item.id),
          contentId: String(item.contentId),
          displayStyle: item.displayStyle as DailyDisplayStyle,
          sortOrder: item.sortOrder,
          contentExists: item.content !== null,
          contentStatus: item.content === null ? null : String(item.content.pipelineStatus),
          sourceName: item.content?.source.name ?? null,
          originalUrl: item.content?.originalUrl ?? null,
        })),
      })),
    };
  }

  async countPublished(): Promise<number> {
    return this.prisma.dailyEdition.count({ where: { status: DailyEditionStatus.PUBLISHED } });
  }

  async markPublished(
    editionId: string,
    input: { editionNo: number; publishedAt: Date },
  ): Promise<PublishingEditionRow | null> {
    const id = BigInt(editionId);
    let editionNo = input.editionNo;

    for (let attempt = 1; attempt <= MAX_EDITION_NO_ATTEMPTS; attempt += 1) {
      try {
        const row = await this.prisma.$transaction(async (tx) => {
          // 条件更新：只有**还没发布**的那一期能被占用（原子 UPDATE）。
          const claimed = await tx.dailyEdition.updateMany({
            where: { id, NOT: { status: DailyEditionStatus.PUBLISHED } },
            data: {
              status: DailyEditionStatus.PUBLISHED,
              editionNo,
              publishedAt: input.publishedAt,
            },
          });
          if (claimed.count === 0) return null;

          return tx.dailyEdition.findUnique({ where: { id }, select: EDITION_SELECT });
        });

        return row === null ? null : this.toRow(row);
      } catch (error) {
        if (isEditionNoConflict(error) && attempt < MAX_EDITION_NO_ATTEMPTS) {
          editionNo = (await this.countPublished()) + 1;
          continue;
        }
        throw error;
      }
    }
    return null;
  }
}
