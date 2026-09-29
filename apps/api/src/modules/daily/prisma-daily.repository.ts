/**
 * `DailyRepository` 的 Prisma 实现。
 *
 * ⚠ 只写 `daily_editions` / `daily_sections` / `daily_items`。
 * 它**读** `contents`（快照与条目预览）但**从不写** —— 内容状态归 Agent 05/07。
 */

import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  DailyEditionStatus,
  type ContentPipelineStatus,
  type ContentType,
  type DailyDisplayStyle,
  type DailySectionType,
  type SourceKind,
  type SourceTier,
} from '@signal/contracts';
import { PrismaService } from '../../common/prisma/prisma.service';
import { toReviewId } from '../admin-review/bigint-id';
import type {
  DailyItemContent,
  DailyItemRow,
  DailyRepository,
  DailySectionRow,
  EditionDetail,
  EditionRow,
  SectionInput,
} from './repository';
import type { EditionSnapshot } from './preflight';

/**
 * 期号分配的并发重试次数。
 *
 * 为什么可能冲突：期号是「已发布期数 + 1」算出来的，
 * 两个**不同**期次同时发布（例如管理员手动补发昨天那一期、
 * 而定时任务正在发今天这一期）可能算出同一个号。
 * `daily_editions.edition_no` 的唯一约束是最后一道防线，撞上就重新数一次。
 *
 * 队列并发度是 1（`QUEUE_CONCURRENCY.publishing`），所以这条路径只在
 * 「手动 + 定时同时发生」时才会走到，3 次绰绰有余。
 */
export const MAX_EDITION_NO_ATTEMPTS = 3;

/** 该错误是不是「期号已被占用」。 */
function isEditionNoConflict(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002' &&
    // `meta.target` 在 MySQL 上是约束名或列名数组，两种形态都认。
    JSON.stringify(error.meta?.target ?? '').includes('edition_no')
  );
}

/** `businessDate` 是 `@db.Date`：Prisma 给的是 UTC 午夜的 `Date`，取 ISO 前 10 位即业务日。 */
const toBusinessDate = (value: Date): string => value.toISOString().slice(0, 10);

const iso = (value: Date | null): string | null => (value === null ? null : value.toISOString());

/**
 * `YYYY-MM-DD` → `Date`（UTC 午夜，与 `@db.Date` 的存储形态一致）。
 *
 * ⚠ 不要掺入本地时区偏移：`@db.Date` 存的是**日期本身**，
 * Prisma 读写都用 UTC 午夜表示它。一旦加了偏移，业务日会整体偏一天 ——
 * 而这是最难发现的一类错（东八区 +8 小时写出来的日期仍是「对的那天」，
 * 只有跨月/跨年边界与 UTC 侧的比较会露馅）。
 */
const fromBusinessDate = (value: string): Date => new Date(`${value}T00:00:00.000Z`);

const EDITION_SELECT = {
  id: true,
  businessDate: true,
  editionNo: true,
  status: true,
  headline: true,
  scheduledAt: true,
  publishedAt: true,
} as const;

/**
 * 条目预览用的内容字段。
 *
 * ⚠ Prisma 的 `orderBy` 是 `select` 的**兄弟**，不是它的成员 ——
 * 写成 `select: { orderBy: ... }` 不会报错但**完全无效**（它会被当成一个
 * 名为 `orderBy` 的字段而静默忽略）。因此下面把「字段」与「查询参数」分开定义。
 */
const ITEM_CONTENT_SELECT = {
  title: true,
  summary: true,
  originalUrl: true,
  imageUrl: true,
  publishedAt: true,
  type: true,
  pipelineStatus: true,
  source: { select: { name: true, slug: true, kind: true, tier: true, official: true } },
} as const;

const ITEM_SELECT = {
  contentId: true,
  displayStyle: true,
  sortOrder: true,
  customHeadline: true,
  customExcerpt: true,
  content: { select: ITEM_CONTENT_SELECT },
} as const;

/** `sections` 关系的查询参数（`select` 与 `orderBy` 平级）。 */
const SECTIONS_ARGS = {
  select: {
    id: true,
    type: true,
    title: true,
    sortOrder: true,
    items: { select: ITEM_SELECT, orderBy: { sortOrder: 'asc' } },
  },
  orderBy: { sortOrder: 'asc' },
} as const;

type SectionRow = {
  id: bigint;
  type: string;
  title: string;
  sortOrder: number;
  items: {
    contentId: bigint;
    displayStyle: string;
    sortOrder: number;
    customHeadline: string | null;
    customExcerpt: string | null;
    content: {
      title: string;
      summary: string | null;
      originalUrl: string;
      imageUrl: string | null;
      publishedAt: Date | null;
      type: string;
      pipelineStatus: string;
      source: { name: string; slug: string; kind: string; tier: string; official: boolean };
    } | null;
  }[];
};

@Injectable()
export class PrismaDailyRepository implements DailyRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  private toEditionRow(row: {
    id: bigint;
    businessDate: Date;
    editionNo: number | null;
    status: string;
    headline: string | null;
    scheduledAt: Date | null;
    publishedAt: Date | null;
  }): EditionRow {
    return {
      editionId: String(row.id),
      businessDate: toBusinessDate(row.businessDate),
      editionNo: row.editionNo,
      status: row.status as DailyEditionStatus,
      headline: row.headline,
      scheduledAt: iso(row.scheduledAt),
      publishedAt: iso(row.publishedAt),
    };
  }

  async findByBusinessDate(businessDate: string): Promise<EditionRow | null> {
    const row = await this.prisma.dailyEdition.findUnique({
      where: { businessDate: fromBusinessDate(businessDate) },
      select: EDITION_SELECT,
    });
    return row === null ? null : this.toEditionRow(row);
  }

  async ensureDraft(businessDate: string): Promise<EditionRow> {
    const existing = await this.findByBusinessDate(businessDate);
    if (existing !== null) return existing;

    try {
      const created = await this.prisma.dailyEdition.create({
        data: { businessDate: fromBusinessDate(businessDate), status: DailyEditionStatus.DRAFT },
        select: EDITION_SELECT,
      });
      return this.toEditionRow(created);
    } catch (error) {
      // 并发下别人（定时任务或另一个请求）刚建了同一期
      //（`business_date` 唯一）→ 读回来即可，这不是错误。
      const again = await this.findByBusinessDate(businessDate);
      if (again !== null) return again;
      throw error;
    }
  }

  async detail(editionId: string): Promise<EditionDetail | null> {
    const id = toReviewId(editionId);
    if (id === null) return null;

    const edition = await this.prisma.dailyEdition.findUnique({
      where: { id },
      select: { ...EDITION_SELECT, sections: SECTIONS_ARGS },
    });
    if (edition === null) return null;

    return {
      edition: this.toEditionRow(edition),
      sections: edition.sections.map((section) => toSectionRow(section)),
    };
  }

  async replaceSections(editionId: string, sections: readonly SectionInput[]): Promise<void> {
    const id = toReviewId(editionId);
    if (id === null) throw new Error(`Non-bindable editionId: ${editionId}`);

    // **同一事务**：先删旧版块（`items` 随 `DailySection` 级联），再建新的。
    // 分开做会出现「旧版块没了、新的一边建一边失败」的半截状态，
    // 而那一期的管理员会看到一份空日报且不知道为什么。
    await this.prisma.$transaction(async (tx) => {
      await tx.dailySection.deleteMany({ where: { editionId: id } });

      for (const section of sections) {
        const created = await tx.dailySection.create({
          data: {
            editionId: id,
            type: section.type,
            title: section.title,
            sortOrder: section.sortOrder,
          },
          select: { id: true },
        });

        if (section.items.length === 0) continue;

        // 一条 `createMany` 而不是 N 次 `create`：一次往返，且**全有或全无**。
        await tx.dailyItem.createMany({
          data: section.items.map((item) => ({
            sectionId: created.id,
            contentId: requireId(item.contentId),
            displayStyle: item.displayStyle,
            sortOrder: item.sortOrder,
            customHeadline: item.customHeadline,
            customExcerpt: item.customExcerpt,
          })),
        });
      }
    });
  }

  async updateEdition(
    editionId: string,
    patch: {
      headline?: string | null;
      status?: DailyEditionStatus;
      scheduledAt?: Date | null;
      publishedAt?: Date | null;
    },
  ): Promise<EditionRow | null> {
    const id = toReviewId(editionId);
    if (id === null) return null;

    const affected = await this.prisma.dailyEdition.updateMany({
      where: { id },
      data: {
        ...(patch.headline === undefined ? {} : { headline: patch.headline }),
        ...(patch.status === undefined ? {} : { status: patch.status }),
        ...(patch.scheduledAt === undefined ? {} : { scheduledAt: patch.scheduledAt }),
        ...(patch.publishedAt === undefined ? {} : { publishedAt: patch.publishedAt }),
      },
    });
    if (affected.count === 0) return null;

    const row = await this.prisma.dailyEdition.findUnique({
      where: { id },
      select: EDITION_SELECT,
    });
    return row === null ? null : this.toEditionRow(row);
  }

  async countPublished(): Promise<number> {
    return this.prisma.dailyEdition.count({ where: { status: DailyEditionStatus.PUBLISHED } });
  }

  async markPublished(
    editionId: string,
    input: { editionNo: number; publishedAt: Date },
  ): Promise<EditionRow | null> {
    const id = toReviewId(editionId);
    if (id === null) return null;

    let editionNo = input.editionNo;

    for (let attempt = 1; attempt <= MAX_EDITION_NO_ATTEMPTS; attempt += 1) {
      try {
        const row = await this.prisma.$transaction(async (tx) => {
          // 条件更新：**只有还没发布的那一期**能被占用。
          // `updateMany` 带 WHERE 在 MySQL 里是一条原子 UPDATE，
          // 两个并发事务只有一个能拿到这行（另一个 count = 0），
          // 因此不会出现「两期拿到同一个号」或「同一期被发布两次」。
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

        return row === null ? null : this.toEditionRow(row);
      } catch (error) {
        // 期号撞车（手动发布与定时发布同时发生）→ 重新数一次再试。
        if (isEditionNoConflict(error) && attempt < MAX_EDITION_NO_ATTEMPTS) {
          editionNo = (await this.countPublished()) + 1;
          continue;
        }
        throw error;
      }
    }
    return null;
  }

  async snapshot(editionId: string): Promise<EditionSnapshot | null> {
    const id = toReviewId(editionId);
    if (id === null) return null;

    const edition = await this.prisma.dailyEdition.findUnique({
      where: { id },
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

  async listByDateRange(input: {
    from: string;
    to: string;
    status?: DailyEditionStatus;
  }): Promise<EditionRow[]> {
    const rows = await this.prisma.dailyEdition.findMany({
      where: {
        businessDate: { gte: fromBusinessDate(input.from), lt: fromBusinessDate(input.to) },
        ...(input.status === undefined ? {} : { status: input.status }),
      },
      select: EDITION_SELECT,
      orderBy: { businessDate: 'desc' },
    });
    return rows.map((row) => this.toEditionRow(row));
  }

  async listArchive(input: { from: string; to: string }): Promise<EditionRow[]> {
    // `docs/10`：**前台日历只展示 PUBLISHED**。
    return this.listByDateRange({
      from: input.from,
      to: input.to,
      status: DailyEditionStatus.PUBLISHED,
    });
  }

  async findPublishedDetail(businessDate: string): Promise<EditionDetail | null> {
    const row = await this.prisma.dailyEdition.findUnique({
      where: { businessDate: fromBusinessDate(businessDate) },
      select: { id: true, status: true },
    });
    if (row === null) return null;
    // ⚠ **未发布的期次对外不存在**（`docs/10`「未审核保持草稿」；`docs/17` 第 10 条）。
    // 返回 404 而不是「空日报」：后者会让前台渲染出一个看起来正常的空白日报页，
    // 而真相是「今天还没发」。
    if (row.status !== DailyEditionStatus.PUBLISHED) return null;

    return this.detail(String(row.id));
  }

  async findContentStatuses(
    contentIds: readonly string[],
  ): Promise<Map<string, ContentPipelineStatus>> {
    const result = new Map<string, ContentPipelineStatus>();

    const ids = contentIds.map(toReviewId).filter((id): id is bigint => id !== null);
    if (ids.length === 0) return result;

    // 去重后一次查完。`in` 的规模由 `MAX_SECTIONS * MAX_ITEMS_PER_SECTION` 封顶
    //（7 × 40 = 280），远在 MySQL 的包大小之内。
    const unique = [...new Set(ids.map(String))].map((value) => BigInt(value));

    const rows = await this.prisma.content.findMany({
      where: { id: { in: unique } },
      select: { id: true, pipelineStatus: true },
    });

    for (const row of rows) {
      result.set(String(row.id), row.pipelineStatus as ContentPipelineStatus);
    }
    return result;
  }
}

/**
 * 写入前的 id 收敛。
 *
 * ⚠ **不要用 `toReviewId(x) ?? 0n`** —— 那会把一个非法 id 静默写成 `0`，
 * 然后由外键抛出「content 0 不存在」这种指向错误位置的错误
 *（看起来像数据问题，实际是入参问题）。这里直接抛，让错误指回调用方。
 */
function requireId(value: string): bigint {
  const id = toReviewId(value);
  if (id === null) throw new Error(`Non-bindable BIGINT id: ${value}`);
  return id;
}

/** Prisma 的 section 行 → 端口形状。 */
function toSectionRow(section: SectionRow): DailySectionRow {
  return {
    sectionId: String(section.id),
    type: section.type as DailySectionType,
    title: section.title,
    sortOrder: section.sortOrder,
    items: section.items.map((item): DailyItemRow => {
      const content: DailyItemContent | null =
        item.content === null
          ? null
          : {
              title: item.content.title,
              summary: item.content.summary,
              originalUrl: item.content.originalUrl,
              imageUrl: item.content.imageUrl,
              publishedAt: iso(item.content.publishedAt),
              type: item.content.type as ContentType,
              pipelineStatus: item.content.pipelineStatus as ContentPipelineStatus,
              source: {
                name: item.content.source.name,
                slug: item.content.source.slug,
                kind: item.content.source.kind as SourceKind,
                tier: item.content.source.tier as SourceTier,
                official: item.content.source.official,
              },
            };

      return {
        contentId: String(item.contentId),
        displayStyle: item.displayStyle as DailyDisplayStyle,
        sortOrder: item.sortOrder,
        customHeadline: item.customHeadline,
        customExcerpt: item.customExcerpt,
        content,
      };
    }),
  };
}
