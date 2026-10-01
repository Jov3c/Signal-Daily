/**
 * `ContentRepository` 端口 —— Pipeline 的持久化契约。
 *
 * 端口化的理由与 Agent 02/03/04/06 一致：单元测试可以用内存替身完整验证
 * 服务层行为（幂等、状态推进、失败标记），不需要 MySQL；
 * 真实 SQL 语义再由 `content-db.integration.spec.ts` 在真库上跑一遍。
 *
 * ⚠ 端口一律使用**契约枚举**（`@signal/contracts`），由
 * `prisma-content.repository.ts` 在边界做带校验的收敛 —— Prisma 的枚举
 * 与契约的枚举是两套互不兼容的 nominal 类型。
 */

import type {
  ContentPipelineStatus,
  ContentType,
  RawItemStatus,
  SourceType,
} from '@signal/contracts';
import type { DedupCandidate } from './dedup/exact';
import type { SimilarityCandidate } from './dedup/similarity';
import type { EventRelation, ExistingEvent } from './cluster/event-cluster';
import type { PrimaryCandidate } from './cluster/priority';
import type {
  EvidenceCandidate,
  EvidencePlan,
  ExistingEvidence,
} from './evidence/evidence-plan';

/** 注入 token。 */
export const CONTENT_REPOSITORY = 'CONTENT_REPOSITORY';

/** 读一条 RawItem 时同时把 Source 的类型带出来（Normalize 需要它推 ContentType）。 */
export type RawItemWithSource = {
  rawItemId: string;
  status: RawItemStatus;
  sourceId: string;
  sourceType: SourceType;
  payload: Record<string, unknown> | null;
  externalId: string | null;
  originalUrl: string;
  titleRaw: string | null;
  bodyRaw: string | null;
  language: string | null;
  publishedAt: Date | null;
  /** 采集端算好的「原始 title+body」哈希（Exact Dedup 的判据）。 */
  contentHash: string | null;
};

/** `findContentText` 的返回：相似度比较用的文本 + 用于事件标题的原始标题。 */
export type ContentTextRecord = SimilarityCandidate & { title: string };

/** 待写入的 `contents` 行。 */
export type NewContent = {
  sourceId: string;
  rawItemId: string;
  type: ContentType;
  title: string;
  bodyOriginal: string | null;
  language: string;
  originalUrl: string;
  imageUrl: string | null;
  publishedAt: Date | null;
  pipelineStatus: ContentPipelineStatus;
};

/** 落库结果。 */
export type PersistOutcome = {
  contentId: string;
  /** `true` 表示这条 RawItem 之前已经归一化过（幂等命中，不是错误）。 */
  alreadyExisted: boolean;
};

export interface ContentRepository {
  /** 读 RawItem + 它的 Source 类型。不存在返回 `null`。 */
  findRawItemWithSource(rawItemId: string): Promise<RawItemWithSource | null>;

  /** 该 RawItem 是否已经有 Content（幂等的快速路径）。 */
  findContentIdByRawItemId(rawItemId: string): Promise<string | null>;

  /**
   * 找出「已经落库、但还没有进内容流水线」的 RawItem id。
   *
   * 判据：`raw_items.status = FETCHED` 且**没有对应的 Content**
   *（`contents.raw_item_id` 是唯一约束，一条 RawItem 最多一条 Content）。
   *
   * 这是 normalize 入口的**兜底取数口**（`ContentService.sweepForNormalize`），
   * 存在两个理由：
   *   - 采集器直接入队那一步失败（Redis 抖动 / 队列故障）时，数据不会永远卡住；
   *   - 本入口补上之前已经积压在 `FETCHED` 的历史数据能被一次性收走。
   *
   * ⚠ **只挑 `FETCHED`**：`NORMALIZED` / `DUPLICATE` / `READY_FOR_ANALYSIS` /
   * `FAILED` 都是已经处理过的终态，再入队只会重复跑一遍（虽然
   * `content.normalize` 本身幂等，但那是白烧的查询与队列额度）。
   *
   * 返回十进制字符串（BIGINT 出库即 `String()`，与契约一致），按 id 升序 ——
   * 先进先出，历史积压先被收走。
   */
  findRawItemsAwaitingNormalize(limit: number): Promise<string[]>;

  /**
   * 创建 Content 并**在同一事务里**把 `raw_items.status` 推进到 `NORMALIZED`。
   *
   * 同一事务是必需的：否则可能出现「Content 建好了，RawItem 还是 FETCHED」，
   * 于是调度器下一轮又把它捞起来、再建一次（虽然 `raw_item_id` 的唯一约束
   * 会挡住第二条，但那是一次**可见的错误**而不是干净的重跑）。
   *
   * 并发下若 `raw_item_id` 已被别人写入（唯一约束 P2002），
   * **不报错** —— 返回 `alreadyExisted: true`，因为「同一份事实只归一化一次」
   * 正是我们想要的语义，第二次执行本就该是空操作。
   */
  createContentAndAdvance(input: NewContent): Promise<PersistOutcome>;

  /**
   * 把 RawItem 标成 `FAILED` 并记下原因。
   *
   * 用于「这条事实本身有问题」的情况（例如清洗后既没有标题也没有正文）。
   * 与「任务执行失败」不同：那是 job 层的事（重试 / DEAD），
   * 这里是**数据层**的终态 —— 重试一百次结果都一样，所以要如实记下来让人看见。
   */
  markRawItemFailed(rawItemId: string, failureCode: string): Promise<void>;

  /** 推进 RawItem 状态（`DUPLICATE` / `READY_FOR_ANALYSIS`），供后续阶段使用。 */
  advanceRawItemStatus(rawItemId: string, status: RawItemStatus): Promise<void>;

  /**
   * 按 `content_hash` 找**已经落库**的 Content（Exact Dedup 用）。
   *
   * 走 `raw_items.content_hash` 的索引（Agent 01 建的 `@@index([contentHash])`）。
   * `excludeRawItemId` 用来排除自己 —— 否则一条记录会被判成自己的重复。
   *
   * 返回按 `createdAt` 升序，调用方仍然用 `pickExactDuplicate()` 决定正本
   *（排序只是减少歧义，判定规则只有一处）。
   */
  findContentsByContentHash(
    contentHash: string,
    excludeRawItemId: string,
  ): Promise<DedupCandidate[]>;

  /**
   * 取「近似判重」的候选内容（Near Dedup 用）。
   *
   * ⚠ **必须限定窗口与条数** —— 相似度计算是 O(候选数 × shingle 数)，
   * 拿全库比会随库增长而变慢。窗口与上限的取值见 `dedup/similarity.ts`。
   *
   * 返回的 `text` 是「标题 + 正文纯文本」，由仓储侧就地转换
   *（读 `body_original` 的 HTML 再转文本）—— 调用方拿到就是可直接比对的形态，
   * 不需要知道库里存的是 HTML。
   */
  findSimilarityCandidates(input: {
    since: Date;
    limit: number;
    excludeContentId: string;
  }): Promise<SimilarityCandidate[]>;

  /**
   * 读一条 Content 的待比较文本（标题 + 正文纯文本），以及它的原始标题。
   *
   * 多返回一个 `title` 是因为事件聚合需要它做 `Event.canonicalTitle` ——
   * 而 `text` 是「标题 + 正文」的拼接，直接拿来当事件标题会把整篇文章塞进去。
   */
  findContentText(contentId: string): Promise<ContentTextRecord | null>;

  /** Content → 它的 RawItem id（推进 `RawItem.status` 时用）。 */
  findRawItemIdByContentId(contentId: string): Promise<string | null>;

  /* ---------------------------------------------------------------- */
  /* Event Cluster（S4）                                              */
  /* ---------------------------------------------------------------- */

  /**
   * 这些 Content 分别属于哪些 Event。
   *
   * 只返回**至少包含其中一个**的 Event；一个 Content 只属于一个 Event
   *（`EventContent.contentId` 是唯一约束）。
   */
  findEventsContaining(contentIds: readonly string[]): Promise<ExistingEvent[]>;

  /** 某个 Event 里现有内容的「来源优先级」信息（用于重算主来源）。 */
  findEventContentCandidates(eventId: string): Promise<PrimaryCandidate[]>;

  /**
   * 新建一个事件并把这条内容作为它的第一篇。
   *
   * **同一事务**里：建 `Event` + 建 `EventContent(relation=primary)`
   * + 把 `contents.event_id` 指过去。
   */
  createEventWithContent(input: {
    contentId: string;
    canonicalTitle: string;
    relation: EventRelation;
    now: Date;
  }): Promise<{ eventId: string }>;

  /**
   * 把一条内容挂到已有事件上，并**重算主来源**。
   *
   * **同一事务**里：建 `EventContent(relation=related)` + 更新 `contents.event_id`
   * + 推后 `Event.lastSeenAt` + 按优先级重算 `Event.primaryContentId`
   *（并把 `EventContent.relation` 同步成 primary/related）。
   *
   * 「重算主来源」是必需的而不是可选的：新加入的这条**可能**来自
   * 优先级更高的来源（例如媒体先报、官方随后发公告），
   * 那时主稿应当换成官方那篇 —— 否则前台会一直引用二手报道。
   */
  attachContentToEvent(input: {
    eventId: string;
    contentId: string;
    relation: EventRelation;
    now: Date;
  }): Promise<{ eventId: string; primaryContentId: string | null }>;

  /* ---------------------------------------------------------------- */
  /* Evidence Attach（S5）                                            */
  /* ---------------------------------------------------------------- */

  /** 该事件已有的证据（规划时要避开已存在的 URL）。 */
  findEventEvidence(eventId: string): Promise<ExistingEvidence[]>;

  /** 该事件里各内容对应的「证据原料」（含 URL 与它的哈希）。 */
  findEvidenceCandidates(eventId: string): Promise<EvidenceCandidate[]>;

  /**
   * 应用证据计划。**必须在同一事务内**完成三件事：
   *
   * 1. 需要切换时，把该事件现有的 `isPrimary` 全部置 false；
   * 2. 插入新证据（`(eventId, urlHash)` 唯一，并发下靠 `skipDuplicates` 兜底）；
   * 3. 把 `primaryUrlHash` 指向的那条置为 `isPrimary = true`。
   *
   * 三件事分开做会出现「两个 Primary」或「一个都没有」的中间态 ——
   * 而 `docs/03` 明确这个唯一性 **DB 层不强制、必须靠事务**。
   */
  applyEvidencePlan(
    eventId: string,
    plan: EvidencePlan,
  ): Promise<{ inserted: number; primaryUrlHash: string | null; independentSourceCount: number }>;

  /* ---------------------------------------------------------------- */
  /* AI 衔接 + Review Queue（S6）                                     */
  /* ---------------------------------------------------------------- */

  /** 把内容推进到 `ANALYZING`（AI 任务已入队）。 */
  markAnalyzing(contentId: string): Promise<void>;

  /**
   * 找出「AI 已经跑完、可以进审核队列」的内容。
   *
   * 判据：`pipelineStatus = ANALYZING`、**没有任何在途的 AiRun**
   *（`QUEUED` / `RUNNING`）、且**至少有一条 AiRun**、且还没有 `EditorialReview`。
   *
   * ⚠ **失败的 AiRun 也算「跑完」**：翻译失败不应该让内容永远进不了审核队列 ——
   * 那会让一条内容既不在审核队列、也不会被重试，彻底消失。
   * 失败的痕迹留在 `ai_runs` 里，管理员看得见。
   */
  findContentsAwaitingReview(limit: number): Promise<{ contentId: string }[]>;

  /** 按 slug 查出 Topic id（把 AI 返回的主题落成 `ContentTopic` 用）。 */
  findTopicIdsBySlugs(slugs: readonly string[]): Promise<Map<string, string>>;

  /**
   * 读出 Agent 06 写进 `contents.ai_analysis` 的主题 slug。
   *
   * Agent 06 的 HANDOFF 明确把「落 `ContentTopic`」交给本模块
   *（它的原话：「分类结果通过返回值给你 …… 由你把它们与 Content 的创建
   * 放在一起写，避免两个 Agent 争同一张关联表」）。
   * 由于作业之间没有回调，本模块只能从它写下的 `ai_analysis` 里读回来 ——
   * 结构是 `{ score: { topics: [...] } }`（Agent 06 的分区结构）。
   *
   * 读不到（没有 AI 结果 / 结构不符）时返回空数组，**不抛错** ——
   * 「模型没给主题」是正常情况，不该让整条收尾失败。
   */
  findAnalyzedTopicSlugs(contentId: string): Promise<string[]>;

  /**
   * 收尾：落主题 + 建审核队列行 + 推进状态。**同一事务**。
   *
   * 三件事必须原子：否则会出现「状态已是 REVIEW_PENDING 但没有审核行」
   *（管理员在后台看不到它）或「有审核行但状态还是 ANALYZING」。
   */
  finalizeForReview(input: {
    contentId: string;
    topics: readonly { topicId: string; confidence: number }[];
  }): Promise<void>;
}
