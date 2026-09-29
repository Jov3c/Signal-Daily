/**
 * Pipeline 测试用的内存替身。
 *
 * 与 Agent 02/03/04/06 的替身同一原则：**替身刻意复刻真实实现的关键约束**，
 * 否则测试就是自证。这里复刻的是：
 *
 * - `contents.raw_item_id` 的**唯一约束**（重复写入抛 P2002 形状的错误）；
 * - 「建 Content 与推进 RawItem 状态在**同一事务**」的原子性 ——
 *   若建 Content 失败，RawItem 状态**不得**被改动；
 * - 状态推进的**单向性**：已经 `NORMALIZED` 的 RawItem 不会被 `FAILED` 覆盖
 *  （真实实现里那是一次 `update`，但业务上不该发生，替身把它变成可见的错）。
 *
 * 真实 SQL 的等价断言由 `content-db.integration.spec.ts` 在真 MySQL 上再跑一遍。
 */

import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import {
  ContentPipelineStatus,
  RawItemStatus,
  SourceKind,
  SourceTier,
  SourceType,
  type ContentType,
  type EvidenceType,
} from '@signal/contracts';
import type { EventRelation, ExistingEvent } from '../../src/jobs/content/cluster/event-cluster';
import { pickPrimaryContent, type PrimaryCandidate } from '../../src/jobs/content/cluster/priority';
import type { ContentEnqueuer } from '../../src/jobs/content/content-enqueuer';
import type { ContentClock } from '../../src/jobs/content/content.service';
import type { DedupCandidate } from '../../src/jobs/content/dedup/exact';
import type { SimilarityCandidate } from '../../src/jobs/content/dedup/similarity';
import type { ContentTextRecord } from '../../src/jobs/content/ports';
import type {
  EvidenceCandidate,
  EvidencePlan,
  ExistingEvidence,
} from '../../src/jobs/content/evidence/evidence-plan';
import type {
  ContentRepository,
  NewContent,
  PersistOutcome,
  RawItemWithSource,
} from '../../src/jobs/content/ports';

/** 被记录的一次写入。 */
export type RecordedWrite = {
  table:
    | 'contents'
    | 'raw_items'
    | 'events'
    | 'event_contents'
    | 'editorial_reviews'
    | 'content_topics';
  id: string;
  data: Record<string, unknown>;
};

/** 种子：一条 RawItem（含它的 Source 类型）。 */
export type SeedRawItem = Partial<Omit<RawItemWithSource, 'rawItemId'>> & { rawItemId: string };

export class InMemoryContentRepository implements ContentRepository {
  readonly rawItems = new Map<string, RawItemWithSource>();
  readonly contents = new Map<string, { contentId: string; data: NewContent }>();
  readonly writes: RecordedWrite[] = [];

  private nextContentId = 500;

  /** 让测试能注入「写库直接失败」，用于验证事务原子性。 */
  failCreate: Error | null = null;

  /**
   * 种一条 RawItem。
   *
   * ⚠ **必须用 `Object.hasOwn` 而不是 `??` 填默认值。**
   * `item.titleRaw ?? '默认'` 在调用方**显式传 `null`** 时也会命中默认值 ——
   * 于是「把标题设为空」根本传不进替身，测试会以为自己验了空标题路径、
   * 实际验的是有标题的路径（本文件的「数据失败」那三条第一版就是这么假绿的）。
   * 显式传入的值（**包括 `null`**）一律优先，只有真的没传才用默认。
   */
  seedRawItem(item: SeedRawItem): void {
    const pick = <K extends keyof RawItemWithSource>(
      key: K,
      fallback: RawItemWithSource[K],
    ): RawItemWithSource[K] =>
      Object.hasOwn(item, key) ? (item[key] as RawItemWithSource[K]) : fallback;

    this.rawItems.set(item.rawItemId, {
      rawItemId: item.rawItemId,
      status: pick('status', RawItemStatus.FETCHED),
      sourceId: pick('sourceId', '7'),
      sourceType: pick('sourceType', SourceType.RSS),
      payload: pick('payload', { feedFormat: 'rss2' }),
      externalId: pick('externalId', 'post-1'),
      originalUrl: pick('originalUrl', 'https://example.com/posts/1'),
      titleRaw: pick('titleRaw', 'Anthropic 发布新的评测报告'),
      bodyRaw: pick('bodyRaw', '<p>报告指出推理成本下降了约 40%。</p>'),
      language: pick('language', 'en'),
      publishedAt: pick('publishedAt', new Date('2026-09-29T02:00:00.000Z')),
      contentHash: pick('contentHash', null),
    });
  }

  async findRawItemWithSource(rawItemId: string): Promise<RawItemWithSource | null> {
    return this.rawItems.get(rawItemId) ?? null;
  }

  async findContentIdByRawItemId(rawItemId: string): Promise<string | null> {
    for (const [contentId, row] of this.contents) {
      if (row.data.rawItemId === rawItemId) return contentId;
    }
    return null;
  }

  async createContentAndAdvance(input: NewContent): Promise<PersistOutcome> {
    if (this.failCreate !== null) throw this.failCreate;

    // 复刻 `contents.raw_item_id` 的唯一约束。
    const existing = await this.findContentIdByRawItemId(input.rawItemId);
    if (existing !== null) {
      throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: 'test',
        meta: { target: ['raw_item_id'] },
      });
    }

    const contentId = String((this.nextContentId += 1));
    this.contents.set(contentId, { contentId, data: input });
    this.createdAt.set(contentId, InMemoryContentRepository.CONTENT_EPOCH + (this.seq += 1));
    this.writes.push({ table: 'contents', id: contentId, data: { ...input } });

    // 同一「事务」内推进 RawItem 状态。
    const rawItem = this.rawItems.get(input.rawItemId);
    if (rawItem !== undefined) {
      rawItem.status = RawItemStatus.NORMALIZED;
      this.writes.push({
        table: 'raw_items',
        id: input.rawItemId,
        data: { status: RawItemStatus.NORMALIZED, failureCode: null },
      });
    }

    return { contentId, alreadyExisted: false };
  }

  async markRawItemFailed(rawItemId: string, failureCode: string): Promise<void> {
    const rawItem = this.rawItems.get(rawItemId);
    if (rawItem === undefined) return;
    rawItem.status = RawItemStatus.FAILED;
    this.writes.push({
      table: 'raw_items',
      id: rawItemId,
      data: { status: RawItemStatus.FAILED, failureCode },
    });
  }

  async advanceRawItemStatus(rawItemId: string, status: RawItemStatus): Promise<void> {
    const rawItem = this.rawItems.get(rawItemId);
    if (rawItem === undefined) return;
    rawItem.status = status;
    this.writes.push({ table: 'raw_items', id: rawItemId, data: { status } });
  }

  /**
   * 复刻真实实现的哈希查询。
   *
   * 真实实现走 `raw_items.content_hash` 索引并按 `createdAt` 升序；
   * 替身用同一个 `seq` 单调递增数模拟 `createdAt`，
   * 这样「正本 = 最早入库的那条」在替身里也可以被断言。
   */
  async findContentsByContentHash(
    contentHash: string,
    excludeRawItemId: string,
  ): Promise<DedupCandidate[]> {
    const found: DedupCandidate[] = [];
    for (const [contentId, row] of this.contents) {
      const rawItem = this.rawItems.get(row.data.rawItemId);
      if (rawItem === undefined) continue;
      if (rawItem.rawItemId === excludeRawItemId) continue;
      if (rawItem.contentHash !== contentHash) continue;

      found.push({
        contentId,
        rawItemId: rawItem.rawItemId,
        contentHash: rawItem.contentHash,
        sourceId: row.data.sourceId,
        createdAt: new Date(this.createdAtOf(contentId)),
      });
    }
    return found.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  async findSimilarityCandidates(input: {
    since: Date;
    limit: number;
    excludeContentId: string;
  }): Promise<SimilarityCandidate[]> {
    const found: SimilarityCandidate[] = [];
    for (const [contentId, row] of this.contents) {
      if (contentId === input.excludeContentId) continue;
      if (new Date(this.createdAtOf(contentId)) < input.since) continue;
      found.push({
        contentId,
        sourceId: row.data.sourceId,
        text: row.data.bodyOriginal ?? row.data.title,
      });
      if (found.length >= input.limit) break;
    }
    return found;
  }

  async findRawItemIdByContentId(contentId: string): Promise<string | null> {
    return this.contents.get(contentId)?.data.rawItemId ?? null;
  }

  /* ---------------------------------------------------------------- */
  /* Event Cluster（S4）                                              */
  /* ---------------------------------------------------------------- */

  /** 事件表：eventId → 成员 contentId。 */
  readonly events = new Map<string, { primaryContentId: string | null; contentIds: string[] }>();

  async findEventsContaining(contentIds: readonly string[]): Promise<ExistingEvent[]> {
    const wanted = new Set(contentIds);
    const found: ExistingEvent[] = [];
    for (const [eventId, event] of this.events) {
      const members = event.contentIds.filter((id) => wanted.has(id));
      if (members.length > 0) found.push({ eventId, contentIds: members });
    }
    return found;
  }

  async findEventContentCandidates(eventId: string): Promise<PrimaryCandidate[]> {
    const event = this.events.get(eventId);
    if (event === undefined) return [];
    return event.contentIds.map((contentId) => ({
      contentId,
      // 替身没有真实的 Source 表，用测试种子里的来源属性。
      source: this.sourceOf(contentId),
      createdAt: new Date(this.createdAtOf(contentId)),
    }));
  }

  /**
   * 替身的来源属性表。
   *
   * 真实实现从 `contents → source` join 出来；替身用一张显式的表，
   * 让「主来源优先级」的用例可以精确控制每个内容的来源身份。
   */
  readonly sourcePriorities = new Map<string, { tier: SourceTier; kind: SourceKind; official: boolean }>();

  /** 设置某个 sourceId 的来源属性（供主来源用例使用）。 */
  setSourcePriority(
    sourceId: string,
    priority: { tier: SourceTier; kind: SourceKind; official: boolean },
  ): void {
    this.sourcePriorities.set(sourceId, priority);
  }

  private sourceOf(contentId: string): { tier: SourceTier; kind: SourceKind; official: boolean } {
    const sourceId = this.contents.get(contentId)?.data.sourceId ?? '';
    return (
      this.sourcePriorities.get(sourceId) ?? {
        tier: SourceTier.C,
        kind: SourceKind.MEDIA,
        official: false,
      }
    );
  }

  async createEventWithContent(input: {
    contentId: string;
    canonicalTitle: string;
    relation: EventRelation;
    now: Date;
  }): Promise<{ eventId: string }> {
    const eventId = String((this.nextEventId += 1));
    this.events.set(eventId, { primaryContentId: input.contentId, contentIds: [input.contentId] });
    this.writes.push({
      table: 'events',
      id: eventId,
      data: { canonicalTitle: input.canonicalTitle, primaryContentId: input.contentId },
    });
    this.writes.push({
      table: 'event_contents',
      id: `${eventId}:${input.contentId}`,
      data: { relation: input.relation },
    });
    return { eventId };
  }

  async attachContentToEvent(input: {
    eventId: string;
    contentId: string;
    relation: EventRelation;
    now: Date;
  }): Promise<{ eventId: string; primaryContentId: string | null }> {
    const event = this.events.get(input.eventId);
    if (event === undefined) throw new Error(`unknown event: ${input.eventId}`);

    // 复刻真实实现的唯一约束（EventContent.contentId 唯一）。
    for (const [eventId, other] of this.events) {
      if (other.contentIds.includes(input.contentId)) {
        throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
          code: 'P2002',
          clientVersion: 'test',
          meta: { target: ['content_id'] },
        });
      }
      void eventId;
    }

    event.contentIds.push(input.contentId);
    this.writes.push({
      table: 'event_contents',
      id: `${input.eventId}:${input.contentId}`,
      data: { relation: input.relation },
    });

    // 重算主来源（与真实实现同一套优先级规则）。
    const primaryContentId = pickPrimaryContent(
      event.contentIds.map((contentId) => ({
        contentId,
        source: this.sourceOf(contentId),
        createdAt: new Date(this.createdAtOf(contentId)),
      })),
    );
    event.primaryContentId = primaryContentId;

    return { eventId: input.eventId, primaryContentId };
  }

  private nextEventId = 900;

  /* ---------------------------------------------------------------- */
  /* Evidence Attach（S5）                                            */
  /* ---------------------------------------------------------------- */

  /** 证据表：eventId → 证据行。 */
  readonly evidence = new Map<
    string,
    {
      evidenceId: string;
      urlHash: string;
      evidenceType: EvidenceType;
      isPrimary: boolean;
      url: string;
      publishedAt: Date | null;
    }[]
  >();

  private nextEvidenceId = 700;

  async findEventEvidence(eventId: string): Promise<ExistingEvidence[]> {
    return (this.evidence.get(eventId) ?? []).map((row) => ({
      evidenceId: row.evidenceId,
      urlHash: row.urlHash,
      evidenceType: row.evidenceType,
      isPrimary: row.isPrimary,
      publishedAt: row.publishedAt,
    }));
  }

  async findEvidenceCandidates(eventId: string): Promise<EvidenceCandidate[]> {
    const event = this.events.get(eventId);
    if (event === undefined) return [];
    return event.contentIds.map((contentId) => {
      const row = this.contents.get(contentId);
      const url = row?.data.originalUrl ?? '';
      return {
        contentId,
        sourceId: row?.data.sourceId ?? '',
        source: this.sourceOf(contentId),
        title: row?.data.title ?? null,
        url,
        urlHash: createHash('sha256').update(url).digest('hex'),
        publishedAt: row?.data.publishedAt ?? null,
      };
    });
  }

  async applyEvidencePlan(
    eventId: string,
    plan: EvidencePlan,
  ): Promise<{ inserted: number; primaryUrlHash: string | null; independentSourceCount: number }> {
    const rows = this.evidence.get(eventId) ?? [];

    // 复刻真实实现的事务语义：**先清旧的 Primary**，再插，再设新的。
    if (plan.reassignPrimary) {
      for (const row of rows) row.isPrimary = false;
    }

    let inserted = 0;
    const known = new Set(rows.map((row) => row.urlHash));
    for (const draft of plan.toInsert) {
      // 复刻 `@@unique([eventId, urlHash])`。
      if (known.has(draft.urlHash)) continue;
      known.add(draft.urlHash);
      rows.push({
        evidenceId: String((this.nextEvidenceId += 1)),
        urlHash: draft.urlHash,
        evidenceType: draft.evidenceType,
        isPrimary: false,
        url: draft.url,
        publishedAt: draft.publishedAt,
      });
      inserted += 1;
    }

    if (plan.primaryUrlHash !== null && plan.reassignPrimary) {
      for (const row of rows) {
        if (row.urlHash === plan.primaryUrlHash) row.isPrimary = true;
      }
    }

    this.evidence.set(eventId, rows);
    return {
      inserted,
      primaryUrlHash: plan.primaryUrlHash,
      independentSourceCount: plan.independentSourceCount,
    };
  }

  /** 某事件的 Primary 证据条数（不变量断言用：必须 ≤ 1）。 */
  primaryEvidenceCount(eventId: string): number {
    return (this.evidence.get(eventId) ?? []).filter((row) => row.isPrimary).length;
  }

  /* ---------------------------------------------------------------- */
  /* AI 衔接 + Review Queue（S6）                                     */
  /* ---------------------------------------------------------------- */

  /** contentId → 当前 pipelineStatus。 */
  readonly statuses = new Map<string, ContentPipelineStatus>();

  /** contentId → AiRun 状态列表（模拟 `ai_runs`）。 */
  readonly aiRuns = new Map<string, string[]>();

  /** contentId → 主题。 */
  readonly contentTopics = new Map<string, { topicId: string; confidence: number }[]>();

  /** contentId → 是否已有审核行。 */
  readonly reviews = new Set<string>();

  /** 主题 slug → id（模拟 `topics` 表）。 */
  readonly topics = new Map<string, string>();

  setAiRuns(contentId: string, statuses: string[]): void {
    this.aiRuns.set(contentId, statuses);
  }

  setTopic(slug: string, topicId: string): void {
    this.topics.set(slug, topicId);
  }

  async markAnalyzing(contentId: string): Promise<void> {
    this.statuses.set(contentId, ContentPipelineStatus.ANALYZING);
    this.writes.push({
      table: 'contents',
      id: contentId,
      data: { pipelineStatus: ContentPipelineStatus.ANALYZING },
    });
  }

  async findContentsAwaitingReview(limit: number): Promise<{ contentId: string }[]> {
    const found: { contentId: string }[] = [];
    for (const [contentId, status] of this.statuses) {
      if (status !== ContentPipelineStatus.ANALYZING) continue;
      if (this.reviews.has(contentId)) continue;
      const runs = this.aiRuns.get(contentId) ?? [];
      if (runs.length === 0) continue; // 至少一条 AiRun
      if (runs.some((s) => s === 'QUEUED' || s === 'RUNNING')) continue; // 有在途
      found.push({ contentId });
      if (found.length >= limit) break;
    }
    return found;
  }

  /** contentId → Agent 06 写下的主题 slug（模拟读 `ai_analysis`）。 */
  readonly analyzedTopics = new Map<string, string[]>();

  async findAnalyzedTopicSlugs(contentId: string): Promise<string[]> {
    return this.analyzedTopics.get(contentId) ?? [];
  }

  async findTopicIdsBySlugs(slugs: readonly string[]): Promise<Map<string, string>> {
    const found = new Map<string, string>();
    for (const slug of slugs) {
      const id = this.topics.get(slug);
      if (id !== undefined) found.set(slug, id);
    }
    return found;
  }

  async finalizeForReview(input: {
    contentId: string;
    topics: readonly { topicId: string; confidence: number }[];
  }): Promise<void> {
    // 复刻真实实现的幂等：upsert 而不是 insert。
    const existing = this.contentTopics.get(input.contentId) ?? [];
    for (const topic of input.topics) {
      const index = existing.findIndex((item) => item.topicId === topic.topicId);
      if (index >= 0) existing[index] = topic;
      else existing.push(topic);
    }
    this.contentTopics.set(input.contentId, existing);

    this.reviews.add(input.contentId);
    this.statuses.set(input.contentId, ContentPipelineStatus.REVIEW_PENDING);
    this.writes.push({
      table: 'contents',
      id: input.contentId,
      data: { pipelineStatus: ContentPipelineStatus.REVIEW_PENDING },
    });
    this.writes.push({ table: 'editorial_reviews', id: input.contentId, data: {} });
    for (const topic of input.topics) {
      this.writes.push({
        table: 'content_topics',
        id: `${input.contentId}:${topic.topicId}`,
        data: { confidence: topic.confidence },
      });
    }
  }

  /** 当前状态（未设置时按 INGESTED 处理）。 */
  statusOfContent(contentId: string): ContentPipelineStatus {
    return this.statuses.get(contentId) ?? ContentPipelineStatus.INGESTED;
  }

  async findContentText(contentId: string): Promise<ContentTextRecord | null> {
    const row = this.contents.get(contentId);
    if (row === undefined) return null;
    return {
      contentId,
      sourceId: row.data.sourceId,
      title: row.data.title,
      text: row.data.bodyOriginal ?? row.data.title,
    };
  }

  /**
   * 记录每一条 content 的「入库时刻」。
   *
   * ⚠ 必须是**真实的 `Date` 时间戳**，不能是单调计数器。
   * 第一版用的是 `seq++`（1, 2, 3…），做「正本 = 最早入库」的排序测试没问题，
   * 但近似判重的候选查询要按**时间窗**过滤（`createdAt >= since`），
   * 而 `new Date(1)` 是 1970 年 —— 所有候选都会被窗口筛掉，
   * 表现成「跨源近似一条都找不到」。**替身的形态必须与真实实现一致**。
   *
   * 基准时刻取一个固定值（不用 `Date.now()`），这样测试不随运行时间漂移。
   */
  private static readonly CONTENT_EPOCH = new Date('2026-09-29T01:00:00.000Z').getTime();

  private readonly createdAt = new Map<string, number>();
  private seq = 0;

  private createdAtOf(contentId: string): number {
    return this.createdAt.get(contentId) ?? 0;
  }

  /** 某条 RawItem 的当前状态。 */
  statusOf(rawItemId: string): RawItemStatus | undefined {
    return this.rawItems.get(rawItemId)?.status;
  }

  /** 已写入的 contents 行数。 */
  contentCount(): number {
    return this.contents.size;
  }

  /** 所有被写过的表名（供「写入范围」断言使用）。 */
  writtenTables(): string[] {
    return [...new Set(this.writes.map((write) => write.table))];
  }

  /** 某条 content 的写入数据。 */
  contentById(contentId: string): NewContent | undefined {
    return this.contents.get(contentId)?.data;
  }
}

/** 记录入队调用的替身。 */
export class RecordingContentEnqueuer implements ContentEnqueuer {
  readonly normalized: string[] = [];
  readonly deduped: string[] = [];

  /** 让测试能注入「入队失败」，验证流水线不会静默断掉。 */
  failDedup: Error | null = null;

  async enqueueNormalize(rawItemId: string): Promise<void> {
    this.normalized.push(rawItemId);
  }

  async enqueueDedup(contentId: string): Promise<void> {
    if (this.failDedup !== null) throw this.failDedup;
    this.deduped.push(contentId);
  }

  /** 记录事件聚合的入队。 */
  readonly clustered: string[] = [];

  async enqueueEventCluster(contentId: string): Promise<void> {
    this.clustered.push(contentId);
  }

  /** 记录交给 AI 阶段的入队。 */
  readonly aiTranslation: string[] = [];
  readonly aiScoring: string[] = [];

  async enqueueAiTranslation(contentId: string): Promise<void> {
    this.aiTranslation.push(contentId);
  }

  async enqueueAiScoring(contentId: string): Promise<void> {
    this.aiScoring.push(contentId);
  }
}

/** 固定时刻的时钟（近似判重的候选窗口需要「现在」）。 */
export class FakeContentClock implements ContentClock {
  constructor(private current: Date = new Date('2026-09-29T02:00:00.000Z')) {}

  now(): Date {
    return new Date(this.current.getTime());
  }

  set(instant: Date | string): void {
    this.current = typeof instant === 'string' ? new Date(instant) : instant;
  }
}

/** 一份合法的 `NewContent`（各用例只覆盖自己关心的字段）。 */
export function newContent(overrides: Partial<NewContent> = {}): NewContent {
  return {
    sourceId: '7',
    rawItemId: '42',
    type: 'ARTICLE' as ContentType,
    title: '标题',
    bodyOriginal: '<p>正文</p>',
    language: 'en',
    originalUrl: 'https://example.com/posts/1',
    imageUrl: null,
    publishedAt: null,
    pipelineStatus: ContentPipelineStatus.INGESTED,
    ...overrides,
  };
}
