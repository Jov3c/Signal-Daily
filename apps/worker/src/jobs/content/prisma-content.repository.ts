/**
 * `ContentRepository` 的 Prisma 实现。
 *
 * ⚠ 本文件是 Pipeline 里**唯一**写 `contents` / `raw_items` 的地方。
 * 特别地：它**从不写 `event_evidence` 之外的事件表**（事件归 S4/S5），
 * 也从不写他人模块的列。
 */

import { Inject, Injectable } from '@nestjs/common';
import { Prisma, type PrismaClient } from '@prisma/client';
import { createHash } from 'node:crypto';
import {
  ContentPipelineStatus,
  RawItemStatus,
  SOURCE_KINDS,
  SOURCE_TIERS,
} from '@signal/contracts';
import { toBindableId } from './bigint-id';
import { toContractEnum, toContractEvidenceType } from './contract-enum';
import {
  toContractRawItemStatus,
  toContractSourceType,
  toPrismaContentType,
  toPrismaPipelineStatus,
  toPrismaRawItemStatus,
} from './contract-enum';
import type { DedupCandidate } from './dedup/exact';
import { htmlToPlainText } from './html/plain-text';
import type { SimilarityCandidate } from './dedup/similarity';
import type { ContentTextRecord } from './ports';
import type { EvidenceCandidate, EvidencePlan, ExistingEvidence } from './evidence/evidence-plan';

/** `EventEvidence.urlHash` 是 `Char(64)`，约定存 SHA-256 十六进制小写。 */
function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
import {
  EVENT_RELATION,
  EVENT_STATUS_ACTIVE,
  type EventRelation,
  type ExistingEvent,
} from './cluster/event-cluster';
import { pickPrimaryContent, type PrimaryCandidate } from './cluster/priority';
import type { ContentRepository, NewContent, PersistOutcome, RawItemWithSource } from './ports';
import { ContentPrismaService } from './prisma.service';

/** 只取本模块需要的列 —— 不要为了省一次查询把 `body_raw` 也拉出来。 */
const RAW_ITEM_SELECT = {
  id: true,
  status: true,
  sourceId: true,
  payload: true,
  externalId: true,
  originalUrl: true,
  titleRaw: true,
  bodyRaw: true,
  language: true,
  publishedAt: true,
  contentHash: true,
  source: { select: { type: true } },
} as const;

@Injectable()
export class PrismaContentRepository implements ContentRepository {
  constructor(@Inject(ContentPrismaService) private readonly prisma: ContentPrismaService) {}

  async findRawItemWithSource(rawItemId: string): Promise<RawItemWithSource | null> {
    const id = toBindableId(rawItemId);
    // 超界 / 畸形 id 当作不存在（见 bigint-id.ts 的说明），不抛错。
    if (id === null) return null;

    const row = await this.prisma.rawItem.findUnique({
      where: { id },
      select: RAW_ITEM_SELECT,
    });
    if (row === null) return null;

    return {
      rawItemId: String(row.id),
      status: toContractRawItemStatus(row.status),
      sourceId: String(row.sourceId),
      sourceType: toContractSourceType(row.source.type),
      payload: isPlainRecord(row.payload) ? row.payload : null,
      externalId: row.externalId,
      originalUrl: row.originalUrl,
      titleRaw: row.titleRaw,
      bodyRaw: row.bodyRaw,
      language: row.language,
      publishedAt: row.publishedAt,
      contentHash: row.contentHash,
    };
  }

  async findContentIdByRawItemId(rawItemId: string): Promise<string | null> {
    const id = toBindableId(rawItemId);
    if (id === null) return null;

    const row = await this.prisma.content.findUnique({
      where: { rawItemId: id },
      select: { id: true },
    });
    return row === null ? null : String(row.id);
  }

  async createContentAndAdvance(input: NewContent): Promise<PersistOutcome> {
    const rawItemId = toBindableId(input.rawItemId);
    const sourceId = toBindableId(input.sourceId);
    if (rawItemId === null || sourceId === null) {
      throw new Error(
        `Cannot persist content for a non-bindable id (rawItemId=${input.rawItemId}, sourceId=${input.sourceId})`,
      );
    }

    // ── ⚠ 写这两张表的**顺序是刻意的**（别调换）────────────────────
    //
    // 这里是**外键 + 唯一键的经典死锁**，2026-09-30 由用户/审查者发现的
    // 偶发失败定位到（`content-db.integration.spec.ts` 的并发用例，
    // 报 `Transaction failed due to a write conflict or a deadlock`）。
    //
    // 机制：`contents.raw_item_id` 有 FK 指向 `raw_items.id`，所以
    // **`INSERT contents` 会对 `raw_items` 的那一行取 S 锁**（外键检查）。
    // 原来的顺序是「先 INSERT contents、再 UPDATE raw_items」，于是：
    //
    // ```text
    // T1: INSERT contents  → 持 raw_items[R] 的 S 锁
    // T2: INSERT contents  → FK 检查也取 raw_items[R] 的 S 锁（S 与 S 兼容）
    //                      → 唯一键查重需要 S 锁 T1 尚未提交的索引记录 → 等 T1
    // T1: UPDATE raw_items → 需要 raw_items[R] 的 X 锁，但 T2 持着 S → 等 T2
    // ```
    //
    // T1 等 T2、T2 等 T1 → 死锁。InnoDB 会挑一个回滚，于是**偶发**失败
    //（取决于两个事务的交错时机，单跑 6 次可能一次都不出现）。
    //
    // **修法：统一加锁顺序** —— 先 `UPDATE raw_items`（拿 X 锁），
    // 再 `INSERT contents`。两个事务按同一个顺序取锁，环就不存在了：
    // T2 会在第一步就阻塞在 raw_items 的 X 锁上，**不会**同时持有
    // raw_items 的 S 锁去等 contents 的记录。
    //
    // 原子性不受影响：两步仍在同一个事务里，第二步失败照样全部回滚
    //（`content-db.integration.spec.ts` 的「Content 建失败时 RawItem 状态
    // 不被推进」盯着这一点）。
    const attempt = async (): Promise<{ contentId: string; alreadyExisted: boolean }> =>
      this.prisma.$transaction(async (tx) => {
        // 1) 先推进 RawItem 状态：否则会出现「Content 建好了、
        //    RawItem 还是 FETCHED」，调度器下一轮又把它捞起来。
        await tx.rawItem.update({
          where: { id: rawItemId },
          data: {
            status: toPrismaRawItemStatus(RawItemStatus.NORMALIZED),
            // 归一化成功后清掉上一次的失败码，避免「成功但还挂着旧错误」。
            failureCode: null,
          },
          select: { id: true },
        });

        // 2) 再建 Content（FK 检查会取 raw_items 的 S 锁 —— 我们已持有 X 锁，
        //    同事务内重入没有问题）。
        const created = await tx.content.create({
          data: {
            sourceId,
            rawItemId,
            type: toPrismaContentType(input.type),
            title: input.title,
            bodyOriginal: input.bodyOriginal,
            language: input.language,
            originalUrl: input.originalUrl,
            imageUrl: input.imageUrl,
            publishedAt: input.publishedAt,
            pipelineStatus: toPrismaPipelineStatus(input.pipelineStatus),
          },
          select: { id: true },
        });

        return { contentId: String(created.id), alreadyExisted: false };
      });

    try {
      return await attempt();
    } catch (error) {
      // 并发下别人先写入了同一条 RawItem 的 Content（`contents.raw_item_id`
      // 是唯一约束）。这**不是错误** —— 「同一份事实只归一化一次」正是我们要的，
      // 第二次执行本就该是空操作。
      if (isRawItemIdConflict(error)) {
        const existing = await this.findContentIdByRawItemId(input.rawItemId);
        if (existing !== null) return { contentId: existing, alreadyExisted: true };
      }

      // ⚠ **死锁/写冲突（P2034）是可重试的**：统一加锁顺序之后本模块不该
      // 再自己造出死锁，但 InnoDB 仍可能因为**别的事务**（例如
      // `content_dedup` / 证据挂接 / 人工操作）持有交集而选中本事务回滚。
      // Prisma 的官方指引就是「请重试你的 transaction」，所以重试一次。
      // 重试是安全的：`attempt` 是幂等的（要么建成、要么撞唯一约束）。
      if (isTransactionConflict(error)) {
        try {
          return await attempt();
        } catch (second) {
          if (isRawItemIdConflict(second)) {
            const existing = await this.findContentIdByRawItemId(input.rawItemId);
            if (existing !== null) return { contentId: existing, alreadyExisted: true };
          }
          throw second;
        }
      }
      throw error;
    }
  }

  async markRawItemFailed(rawItemId: string, failureCode: string): Promise<void> {
    const id = toBindableId(rawItemId);
    if (id === null) return;

    await this.prisma.rawItem.update({
      where: { id },
      data: {
        status: toPrismaRawItemStatus(RawItemStatus.FAILED),
        failureCode,
      },
      select: { id: true },
    });
  }

  async advanceRawItemStatus(rawItemId: string, status: RawItemStatus): Promise<void> {
    const id = toBindableId(rawItemId);
    if (id === null) return;

    await this.prisma.rawItem.update({
      where: { id },
      data: { status: toPrismaRawItemStatus(status) },
      select: { id: true },
    });
  }

  async findContentsByContentHash(
    contentHash: string,
    excludeRawItemId: string,
  ): Promise<DedupCandidate[]> {
    const excludeId = toBindableId(excludeRawItemId);

    // 走 `raw_items.content_hash` 的索引。
    // `rawItem` 关系是 `Content.rawItemId`（可空、唯一）的反向。
    const rows = await this.prisma.content.findMany({
      where: {
        rawItem: {
          contentHash,
          // 排除自己：否则一条记录会被判成它自己的重复。
          ...(excludeId === null ? {} : { id: { not: excludeId } }),
        },
      },
      select: {
        id: true,
        sourceId: true,
        createdAt: true,
        rawItemId: true,
        rawItem: { select: { contentHash: true } },
      },
      orderBy: { createdAt: 'asc' },
    });

    return rows.map((row) => ({
      contentId: String(row.id),
      rawItemId: row.rawItemId === null ? '' : String(row.rawItemId),
      contentHash: row.rawItem?.contentHash ?? null,
      sourceId: String(row.sourceId),
      createdAt: row.createdAt,
    }));
  }

  async findSimilarityCandidates(input: {
    since: Date;
    limit: number;
    excludeContentId: string;
  }): Promise<SimilarityCandidate[]> {
    const excludeId = toBindableId(input.excludeContentId);

    const rows = await this.prisma.content.findMany({
      where: {
        createdAt: { gte: input.since },
        ...(excludeId === null ? {} : { id: { not: excludeId } }),
      },
      select: { id: true, sourceId: true, title: true, bodyOriginal: true },
      // 新的在前：同一事件的报道几乎都在几天内出现，越新越可能是同一事件。
      orderBy: { createdAt: 'desc' },
      take: input.limit,
    });

    return rows.map((row) => ({
      contentId: String(row.id),
      sourceId: String(row.sourceId),
      text: compareText(row.title, row.bodyOriginal),
    }));
  }

  async findEventsContaining(contentIds: readonly string[]): Promise<ExistingEvent[]> {
    const ids = contentIds.map(toBindableId).filter((id): id is bigint => id !== null);
    if (ids.length === 0) return [];

    const rows = await this.prisma.eventContent.findMany({
      where: { contentId: { in: ids } },
      select: { eventId: true, contentId: true },
    });

    const byEvent = new Map<string, string[]>();
    for (const row of rows) {
      const eventId = String(row.eventId);
      const list = byEvent.get(eventId) ?? [];
      list.push(String(row.contentId));
      byEvent.set(eventId, list);
    }

    return [...byEvent].map(([eventId, contentIdsOfEvent]) => ({
      eventId,
      contentIds: contentIdsOfEvent,
    }));
  }

  async findEventContentCandidates(eventId: string): Promise<PrimaryCandidate[]> {
    const id = toBindableId(eventId);
    if (id === null) return [];

    const rows = await this.prisma.content.findMany({
      where: { eventId: id },
      select: {
        id: true,
        createdAt: true,
        source: { select: { tier: true, kind: true, official: true } },
      },
    });

    return rows.map((row) => ({
      contentId: String(row.id),
      createdAt: row.createdAt,
      source: {
        tier: toContractEnum(SOURCE_TIERS, row.source.tier, 'SourceTier'),
        kind: toContractEnum(SOURCE_KINDS, row.source.kind, 'SourceKind'),
        official: row.source.official,
      },
    }));
  }

  async createEventWithContent(input: {
    contentId: string;
    canonicalTitle: string;
    relation: EventRelation;
    now: Date;
  }): Promise<{ eventId: string }> {
    const contentId = toBindableId(input.contentId);
    if (contentId === null) throw new Error(`Non-bindable contentId: ${input.contentId}`);

    return this.prisma.$transaction(async (tx) => {
      const event = await tx.event.create({
        data: {
          canonicalTitle: input.canonicalTitle,
          status: EVENT_STATUS_ACTIVE,
          primaryContentId: contentId,
          firstSeenAt: input.now,
          lastSeenAt: input.now,
        },
        select: { id: true },
      });

      await tx.eventContent.create({
        data: { eventId: event.id, contentId, relation: input.relation },
        select: { eventId: true },
      });

      await tx.content.update({
        where: { id: contentId },
        data: { eventId: event.id },
        select: { id: true },
      });

      return { eventId: String(event.id) };
    });
  }

  async attachContentToEvent(input: {
    eventId: string;
    contentId: string;
    relation: EventRelation;
    now: Date;
  }): Promise<{ eventId: string; primaryContentId: string | null }> {
    const eventId = toBindableId(input.eventId);
    const contentId = toBindableId(input.contentId);
    if (eventId === null || contentId === null) {
      throw new Error(`Non-bindable ids: event=${input.eventId} content=${input.contentId}`);
    }

    return this.prisma.$transaction(async (tx) => {
      // `EventContent` 的 `(eventId, contentId)` 是复合主键且 contentId 唯一 ——
      // 重复挂同一个内容会抛 P2002。**不吞**：那意味着服务层没做好幂等，
      // 是一个应该被看见的缺陷，而不是正常路径。
      await tx.eventContent.create({
        data: { eventId, contentId, relation: input.relation },
        select: { eventId: true },
      });

      await tx.content.update({
        where: { id: contentId },
        data: { eventId },
        select: { id: true },
      });

      await tx.event.update({
        where: { id: eventId },
        data: { lastSeenAt: input.now },
        select: { id: true },
      });

      // 重算主来源：新加入的这条可能来自优先级更高的来源。
      const members = await tx.content.findMany({
        where: { eventId },
        select: {
          id: true,
          createdAt: true,
          source: { select: { tier: true, kind: true, official: true } },
        },
      });

      const primaryContentId = pickPrimaryContent(
        members.map((member) => ({
          contentId: String(member.id),
          createdAt: member.createdAt,
          source: {
            tier: toContractEnum(SOURCE_TIERS, member.source.tier, 'SourceTier'),
            kind: toContractEnum(SOURCE_KINDS, member.source.kind, 'SourceKind'),
            official: member.source.official,
          },
        })),
      );

      if (primaryContentId !== null) {
        await tx.event.update({
          where: { id: eventId },
          data: { primaryContentId: toBindableId(primaryContentId) },
          select: { id: true },
        });

        // 同步 `EventContent.relation`，让「哪条是主稿」在关系表上也读得出来。
        await tx.eventContent.updateMany({
          where: { eventId },
          data: { relation: EVENT_RELATION.RELATED },
        });
        await tx.eventContent.updateMany({
          where: { eventId, contentId: toBindableId(primaryContentId) ?? undefined },
          data: { relation: EVENT_RELATION.PRIMARY },
        });
      }

      return { eventId: String(eventId), primaryContentId };
    });
  }

  async findEventEvidence(eventId: string): Promise<ExistingEvidence[]> {
    const id = toBindableId(eventId);
    if (id === null) return [];

    const rows = await this.prisma.eventEvidence.findMany({
      where: { eventId: id },
      select: { id: true, urlHash: true, evidenceType: true, isPrimary: true, publishedAt: true },
      orderBy: { id: 'asc' },
    });

    return rows.map((row) => ({
      evidenceId: String(row.id),
      urlHash: row.urlHash,
      evidenceType: toContractEvidenceType(row.evidenceType),
      isPrimary: row.isPrimary,
      publishedAt: row.publishedAt,
    }));
  }

  async findEvidenceCandidates(eventId: string): Promise<EvidenceCandidate[]> {
    const id = toBindableId(eventId);
    if (id === null) return [];

    const rows = await this.prisma.content.findMany({
      where: { eventId: id },
      select: {
        id: true,
        sourceId: true,
        title: true,
        originalUrl: true,
        publishedAt: true,
        source: { select: { tier: true, kind: true, official: true } },
      },
    });

    return rows.map((row) => ({
      contentId: String(row.id),
      sourceId: String(row.sourceId),
      source: {
        tier: toContractEnum(SOURCE_TIERS, row.source.tier, 'SourceTier'),
        kind: toContractEnum(SOURCE_KINDS, row.source.kind, 'SourceKind'),
        official: row.source.official,
      },
      title: row.title,
      url: row.originalUrl,
      urlHash: sha256Hex(row.originalUrl),
      publishedAt: row.publishedAt,
    }));
  }

  async applyEvidencePlan(
    eventId: string,
    plan: EvidencePlan,
  ): Promise<{ inserted: number; primaryUrlHash: string | null; independentSourceCount: number }> {
    const id = toBindableId(eventId);
    if (id === null) {
      throw new Error(`Non-bindable eventId: ${eventId}`);
    }

    return this.prisma.$transaction(async (tx) => {
      // 1) 先清掉旧的 Primary —— 必须在插入之前，否则中间态会出现两个 primary。
      if (plan.reassignPrimary) {
        await tx.eventEvidence.updateMany({
          where: { eventId: id, isPrimary: true },
          data: { isPrimary: false },
        });
      }

      // 2) 插入新证据。`(eventId, urlHash)` 唯一；并发下靠 skipDuplicates
      //    兜底（另一个 worker 刚插了同一条），不报错。
      let inserted = 0;
      if (plan.toInsert.length > 0) {
        const result = await tx.eventEvidence.createMany({
          data: plan.toInsert.map((draft) => ({
            eventId: id,
            contentId: toBindableId(draft.contentId),
            sourceId: toBindableId(draft.sourceId),
            evidenceType: draft.evidenceType as never,
            title: draft.title,
            url: draft.url,
            urlHash: draft.urlHash,
            publishedAt: draft.publishedAt,
            isPrimary: false,
          })),
          skipDuplicates: true,
        });
        inserted = result.count;
      }

      // 3) 设置新的 Primary（用 urlHash 而不是「草稿里的那条」——
      //    选中的可能是**已存在**的证据，它不在 toInsert 里）。
      if (plan.primaryUrlHash !== null && plan.reassignPrimary) {
        await tx.eventEvidence.updateMany({
          where: { eventId: id, urlHash: plan.primaryUrlHash },
          data: { isPrimary: true },
        });
      }

      return {
        inserted,
        primaryUrlHash: plan.primaryUrlHash,
        independentSourceCount: plan.independentSourceCount,
      };
    });
  }

  async markAnalyzing(contentId: string): Promise<void> {
    const id = toBindableId(contentId);
    if (id === null) return;

    await this.prisma.content.update({
      where: { id },
      data: { pipelineStatus: toPrismaPipelineStatus(ContentPipelineStatus.ANALYZING) },
      select: { id: true },
    });
  }

  async findContentsAwaitingReview(limit: number): Promise<{ contentId: string }[]> {
    const rows = await this.prisma.content.findMany({
      where: {
        pipelineStatus: toPrismaPipelineStatus(ContentPipelineStatus.ANALYZING),
        // 还没有审核行
        review: { is: null },
        // 至少有一条 AiRun
        aiRuns: { some: {} },
        // 没有任何在途的 AiRun
        AND: [{ aiRuns: { none: { status: { in: ['QUEUED', 'RUNNING'] } } } }],
      },
      select: { id: true },
      orderBy: { id: 'asc' },
      take: limit,
    });
    return rows.map((row) => ({ contentId: String(row.id) }));
  }

  async findTopicIdsBySlugs(slugs: readonly string[]): Promise<Map<string, string>> {
    if (slugs.length === 0) return new Map();

    const rows = await this.prisma.topic.findMany({
      where: { slug: { in: [...slugs] } },
      select: { id: true, slug: true },
    });
    return new Map(rows.map((row) => [row.slug, String(row.id)]));
  }

  async findAnalyzedTopicSlugs(contentId: string): Promise<string[]> {
    const id = toBindableId(contentId);
    if (id === null) return [];

    const row = await this.prisma.content.findUnique({
      where: { id },
      select: { aiAnalysis: true },
    });
    if (row === null) return [];

    return extractTopicSlugs(row.aiAnalysis);
  }

  async finalizeForReview(input: {
    contentId: string;
    topics: readonly { topicId: string; confidence: number }[];
  }): Promise<void> {
    const contentId = toBindableId(input.contentId);
    if (contentId === null) throw new Error(`Non-bindable contentId: ${input.contentId}`);

    await this.prisma.$transaction(async (tx) => {
      for (const topic of input.topics) {
        const topicId = toBindableId(topic.topicId);
        if (topicId === null) continue;
        // 复合主键幂等：重复收尾不会产生第二行。
        await tx.contentTopic.upsert({
          where: { contentId_topicId: { contentId, topicId } },
          create: { contentId, topicId, confidence: topic.confidence },
          update: { confidence: topic.confidence },
          select: { contentId: true },
        });
      }

      // `EditorialReview.contentId` 有唯一约束 —— 重复收尾靠 upsert 幂等。
      await tx.editorialReview.upsert({
        where: { contentId },
        create: { contentId, status: 'PENDING' },
        update: {},
        select: { id: true },
      });

      await tx.content.update({
        where: { id: contentId },
        data: { pipelineStatus: toPrismaPipelineStatus(ContentPipelineStatus.REVIEW_PENDING) },
        select: { id: true },
      });
    });
  }

  async findRawItemIdByContentId(contentId: string): Promise<string | null> {
    const id = toBindableId(contentId);
    if (id === null) return null;

    const row = await this.prisma.content.findUnique({
      where: { id },
      select: { rawItemId: true },
    });
    return row?.rawItemId === null || row?.rawItemId === undefined ? null : String(row.rawItemId);
  }

  async findContentText(contentId: string): Promise<ContentTextRecord | null> {
    const id = toBindableId(contentId);
    if (id === null) return null;

    const row = await this.prisma.content.findUnique({
      where: { id },
      select: { id: true, sourceId: true, title: true, bodyOriginal: true },
    });
    if (row === null) return null;

    return {
      contentId: String(row.id),
      sourceId: String(row.sourceId),
      title: row.title,
      text: compareText(row.title, row.bodyOriginal),
    };
  }

  /** 便于测试与工具代码构造（`PrismaClient` 的别名）。 */
  static forClient(prisma: PrismaClient): PrismaContentRepository {
    return new PrismaContentRepository(prisma as ContentPrismaService);
  }
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

/** `Json?` 列读出来是 `JsonValue`；只有普通对象才对 `content-type` 推导有意义。 */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 组装「待比较文本」：标题 + 正文纯文本。
 *
 * ⚠ 在**仓储边界**做 HTML → 纯文本的转换，而不是让调用方自己转：
 * 库里 `body_original` 存的是 HTML，而相似度比较要的是文字。
 * 这个转换在别处再写一遍就会与 `htmlToPlainText` 漂移。
 */
function compareText(title: string, bodyOriginal: string | null): string | null {
  const body = htmlToPlainText(bodyOriginal);
  const combined = body === null ? title : `${title}\n${body}`;
  return combined.trim() === '' ? null : combined;
}

/**
 * 从 `contents.ai_analysis` 里取出主题 slug 列表。
 *
 * 结构由 Agent 06 定义（见其 HANDOFF 的《补遗》）：按任务分区，
 * 主题在 `score.topics` 下。这里**防御式地**逐层检查类型 ——
 * 它是另一个模块写下的 JSON，本模块不能用 `as` 假定形状。
 */
function extractTopicSlugs(aiAnalysis: Prisma.JsonValue | null): string[] {
  if (!isPlainRecord(aiAnalysis)) return [];

  const score = aiAnalysis['score'];
  if (!isPlainRecord(score)) return [];

  const topics = score['topics'];
  if (!Array.isArray(topics)) return [];

  return topics.filter((topic): topic is string => typeof topic === 'string' && topic !== '');
}

/**
 * 判断异常是不是「`contents.raw_item_id` 唯一约束冲突」。
 *
 * 只看 `P2002` 不够：`contents` 上还有别的唯一约束（例如将来可能加的
 * `(source_id, canonical_url)`），把别的冲突误判成「已存在」会让一条
 * 本该失败的写入被静默吞掉。所以同时检查 `meta.target` 里提到了这个字段。
 */
function isRawItemIdConflict(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (error.code !== 'P2002') return false;

  const target = error.meta?.['target'];
  const fields = Array.isArray(target) ? target.map(String) : [String(target ?? '')];
  return fields.some((field) => field.includes('raw_item_id') || field.includes('rawItemId'));
}

/**
 * 该错误是不是「事务因写冲突 / 死锁被回滚」。
 *
 * Prisma 把 InnoDB 的 `ER_LOCK_DEADLOCK`（1213）与
 * `ER_LOCK_WAIT_TIMEOUT`（1205）都收敛成 **`P2034`**，错误信息是
 * 「Transaction failed due to a write conflict or a deadlock.
 * Please retry your transaction」—— **它自己就在说「重试」**。
 *
 * ⚠ 与 `isRawItemIdConflict` 的区别很重要：那个是**业务结论**
 *（「别人已经建好了」→ 返回已有 id，不重试也不必重试）；
 * 这个是**瞬时故障**（回滚了、什么都没留下 → 重试是安全的）。
 * 把两者混为一谈会让「死锁」被当成「已存在」而**静默返回一个不存在的 id**。
 */
function isTransactionConflict(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034';
}
