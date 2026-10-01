/**
 * `ContentService` —— Normalize 阶段的编排。
 *
 * 职责链（顺序不能换）：
 *
 * ```text
 * 读 RawItem + Source
 *   → 不存在 → 抛 CONTENT_RAW_ITEM_NOT_FOUND（不可重试）
 *   → 已经归一化过 → 幂等返回（重试安全）
 *   → normalizeRawItem()   ← 纯函数，全部判断在这里
 *       ├─ 失败（既无标题也无正文）→ 标 RawItem FAILED + 返回 failed（不抛）
 *       └─ 成功 → 事务内建 Content + 推进 RawItem = NORMALIZED
 * ```
 *
 * ── 「数据失败」不抛异常，是刻意的 ──────────────────────────────────
 * 「这条事实清洗完什么都没剩」是一个**数据结论**，不是「这次执行出了故障」。
 * 抛异常会让 BullMQ 重试三次（每次得到同样的结论、多写三条日志），
 * 而正确的处置是把它记成 `raw_items.status = FAILED`，
 * 让它在后台可见、由人去查为什么某个来源一直在给空条目。
 * 真正该重试的是**基础设施故障**（连不上库、写库超时），那类仍然抛。
 */

import { Inject, Injectable } from '@nestjs/common';
import { ContentPipelineStatus, ContentType, DomainErrorCode, RawItemStatus } from '@signal/contracts';
import type { Logger } from '@signal/logger';
import { AppError } from '@signal/contracts';
import { CONTENT_ENQUEUER, type ContentEnqueuer } from './content-enqueuer';
import {
  EVENT_RELATION,
  canonicalTitleOf,
  decideEventAssignment,
} from './cluster/event-cluster';
import { pickExactDuplicate } from './dedup/exact';
import { planEvidenceAttach } from './evidence/evidence-plan';
import {
  DEFAULT_SIMILARITY_THRESHOLD,
  NEAR_DUP_CANDIDATE_WINDOW_DAYS,
  findNearDuplicates,
  type NearDuplicateVerdict,
} from './dedup/similarity';
import { CONTENT_REPOSITORY, type ContentRepository, type RawItemWithSource } from './ports';
import { normalizeRawItem, type NormalizedContent } from './normalize/normalize';

/**
 * 近似判重的候选条数上限。
 *
 * ⚠ 这是本模块**最贵的一次查询**：要读回候选的 title + body_original
 *（正文是 LongText）。取 50 是在「足够找到同一事件的其他报道」与
 *「不要为了一个候选列表读回几十 MB 正文」之间取的折中。
 *
 * 真正的规模化方案是持久化指纹（MinHash/LSH 或向量检索），
 * V1 明确不做（docs/07：「V1 不因为 Evidence 引入向量数据库」），已记入 HANDOFF。
 */
export const NEAR_DUP_CANDIDATE_LIMIT = 50;

/** 注入 token。 */
export const CONTENT_CLOCK = 'CONTENT_CLOCK';

/** 可注入时钟（近似判重的候选窗口需要「现在」）。 */
export interface ContentClock {
  now(): Date;
}

/** 注入 token。 */
export const CONTENT_LOGGER = 'CONTENT_LOGGER';

/** Normalize 的结果。 */
export type NormalizeOutcome =
  | {
      status: 'NORMALIZED';
      rawItemId: string;
      contentId: string;
      /** `true` 表示这次是幂等命中（Content 之前就存在）。 */
      alreadyExisted: boolean;
      content: NormalizedContent;
    }
  | {
      /** 精确重复：库里已有同一份内容（`content_hash` 相同），**不建 Content**。 */
      status: 'DUPLICATE';
      rawItemId: string;
      /** 正本（最早入库的那条 Content）。 */
      canonicalContentId: string;
      sameSource: boolean;
    }
  | {
      status: 'FAILED';
      rawItemId: string;
      code: string;
      reason: string;
    };

/** 事件聚合的结果。 */
export type ClusterOutcome = {
  action: 'join' | 'create';
  eventId: string;
  primaryContentId: string | null;
  /**
   * `true` 表示**幂等命中**：这条内容本来就在那个事件里，
   * 本次没有写任何东西。调用方据此区分「真的加入了」与「早就加入了」。
   */
  alreadyMember?: boolean;
  /** 仅幂等命中时给出：该事件当前有多少条内容。 */
  candidateCount?: number;
  /** 证据挂接的结果（幂等命中路径下不含）。 */
  evidence?: { inserted: number; primaryUrlHash: string | null; independentSourceCount: number };
};

/** RawItem / Source 不存在 —— 不可重试。 */
export class RawItemNotFoundError extends AppError {
  constructor(rawItemId: string) {
    super({
      code: DomainErrorCode.CONTENT_RAW_ITEM_NOT_FOUND,
      safeMessage: `RawItem not found: ${rawItemId}`,
      details: { rawItemId },
    });
    this.name = 'RawItemNotFoundError';
  }
}

@Injectable()
export class ContentService {
  constructor(
    @Inject(CONTENT_REPOSITORY) private readonly repository: ContentRepository,
    @Inject(CONTENT_LOGGER) private readonly logger: Logger,
    @Inject(CONTENT_ENQUEUER) private readonly enqueuer: ContentEnqueuer,
    @Inject(CONTENT_CLOCK) private readonly clock: ContentClock,
  ) {}

  /** 把一条原始事实归一成内容。 */
  async normalize(rawItemId: string): Promise<NormalizeOutcome> {
    const rawItem = await this.repository.findRawItemWithSource(rawItemId);
    if (rawItem === null) {
      // 上游传错 id，或记录在入队与执行之间被删掉了。重试同一个 id 没有意义。
      throw new RawItemNotFoundError(rawItemId);
    }

    // 幂等快速路径：`content.normalize` 会因为重试、或归一化规则升版本而重复入队。
    // `contents.raw_item_id` 有唯一约束，但先查一次能省掉一次注定失败的写入。
    const existingContentId = await this.repository.findContentIdByRawItemId(rawItemId);
    if (existingContentId !== null) {
      this.logger.info(
        { rawItemId, contentId: existingContentId },
        'raw item was already normalized; skipping',
      );
      // 注意：这里**不返回** `content`（那需要再查一次库）。
      // 调用方关心的是「有没有归一化成功」，而不是内容本身。
      // ⚠ 幂等命中**也要接下一阶段**：上一次尝试可能在「Content 已建好、
      // 但入队失败」的窗口里挂掉，那时 RawItem 已是 NORMALIZED、
      // Content 也已存在 —— 只有再入队一次才能把链条补上。
      await this.enqueuer.enqueueDedup(existingContentId);

      return {
        status: 'NORMALIZED',
        rawItemId,
        contentId: existingContentId,
        alreadyExisted: true,
        content: EMPTY_CONTENT_PLACEHOLDER,
      };
    }

    const result = normalizeRawItem({
      rawItemId: rawItem.rawItemId,
      sourceId: rawItem.sourceId,
      sourceType: rawItem.sourceType,
      payload: rawItem.payload,
      externalId: rawItem.externalId,
      originalUrl: rawItem.originalUrl,
      titleRaw: rawItem.titleRaw,
      bodyRaw: rawItem.bodyRaw,
      language: rawItem.language,
      publishedAt: rawItem.publishedAt,
    });

    if (!result.ok) {
      // 数据结论，不抛 —— 见文件头。标 FAILED 让它可见。
      await this.repository.markRawItemFailed(rawItemId, result.code);
      this.logger.warn(
        { rawItemId, sourceId: rawItem.sourceId, errorCode: result.code },
        'raw item cannot be normalized',
      );
      return { status: 'FAILED', rawItemId, code: result.code, reason: result.reason };
    }

    // ── Exact Dedup（`docs/06` 幂等键 ③）────────────────────────────
    // 在**落库之前**判：先建再归档会在库里留下一条永远不该被展示的
    // Content，而 `contents` 上既没有「我是重复」的列、也没有指向正本的指针。
    const duplicate = await this.findExactDuplicate(rawItem);
    if (duplicate !== null) {
      await this.repository.advanceRawItemStatus(rawItemId, RawItemStatus.DUPLICATE);
      this.logger.info(
        {
          rawItemId,
          sourceId: rawItem.sourceId,
          canonicalContentId: duplicate.canonicalContentId,
          sameSource: duplicate.sameSource,
        },
        'raw item is an exact duplicate; content not created',
      );
      return {
        status: 'DUPLICATE',
        rawItemId,
        canonicalContentId: duplicate.canonicalContentId,
        sameSource: duplicate.sameSource,
      };
    }

    return this.persistAndChain(result.content, rawItem);
  }

  /**
   * 落库并**把流水线接到下一阶段**。
   *
   * ⚠ 入队失败**不吞**：那一阶段的成果已经写进库了，但下一阶段不会发生。
   * 抛出去让 BullMQ 重试 —— `content.normalize` 是幂等的（第二次会走
   * `alreadyExisted` 分支），所以重试的代价只是一次多余的查询，
   * 换来的是一条**不会静默断掉的流水线**。
   */
  private async persistAndChain(
    content: NormalizedContent,
    rawItem: RawItemWithSource,
  ): Promise<NormalizeOutcome> {
    const persisted = await this.repository.createContentAndAdvance(content);

    await this.enqueuer.enqueueDedup(persisted.contentId);

    this.logger.info(
      {
        rawItemId: rawItem.rawItemId,
        contentId: persisted.contentId,
        sourceId: rawItem.sourceId,
        contentType: content.type,
        bodySource: content.bodySource,
        bodyChars: content.bodyOriginal?.length ?? 0,
      },
      'content normalized',
    );

    return {
      status: 'NORMALIZED',
      rawItemId: rawItem.rawItemId,
      contentId: persisted.contentId,
      alreadyExisted: persisted.alreadyExisted,
      content,
    };
  }

  /**
   * 找出一条 Content 的**近似重复候选**（Near Dedup，S3）。
   *
   * 返回值只描述「哪些像」，**不含任何删除/标记语义** ——
   * 同一事件被多家媒体报道是 `docs/22` 里**有价值**的独立来源，
   * 不是要被消掉的噪声。「它们是不是同一个事件」由 Event Cluster（S4）决定。
   *
   * ⚠ 候选来自一个**有界的窗口**（最近 N 天、最多 M 条），
   * 而不是全库。这是 V1 的成本取舍 —— 见 `dedup/similarity.ts` 的说明。
   */
  async findNearDuplicates(
    contentId: string,
    threshold: number = DEFAULT_SIMILARITY_THRESHOLD,
  ): Promise<NearDuplicateVerdict | null> {
    const probe = await this.repository.findContentText(contentId);
    if (probe === null) return null;

    const since = new Date(
      this.clock.now().getTime() - NEAR_DUP_CANDIDATE_WINDOW_DAYS * 24 * 3600 * 1000,
    );
    const candidates = await this.repository.findSimilarityCandidates({
      since,
      limit: NEAR_DUP_CANDIDATE_LIMIT,
      excludeContentId: contentId,
    });

    return findNearDuplicates(
      { contentId: probe.contentId, sourceId: probe.sourceId, text: probe.text },
      candidates,
      threshold,
    );
  }

  /**
   * `content.event-cluster` 作业的主体：把内容归到一个事件里。
   *
   * `docs/07`：「同一事件只形成一个 Event，多个 Content 可以属于该 Event。」
   *
   * 复用 S3 的近似判重结果做归属决策（不重复算相似度），归属规则见
   * `cluster/event-cluster.ts`。**幂等**：已经在某个事件里的内容
   * 会直接返回那个事件，不会新建重复事件（重试是正常路径）。
   */
  async clusterContent(contentId: string): Promise<ClusterOutcome | null> {
    const content = await this.repository.findContentText(contentId);
    if (content === null) return null;

    const verdict = await this.findNearDuplicates(contentId);
    if (verdict === null) return null;

    const matches = [...verdict.crossSourceMatches, ...verdict.sameSourceMatches];

    // ⚠ 查询里**必须带上 `contentId` 自己**。
    // 第一版只查了匹配项的 id，于是「这条内容已经在某个事件里」这个事实
    // 从来没被读出来 —— `decideEventAssignment` 里的幂等自检永远不触发，
    // 每次重跑都会**新建一个重复的 Event**（而重试是正常路径）。
    const events = await this.repository.findEventsContaining([
      contentId,
      ...matches.map((match) => match.contentId),
    ]);
    const decision = decideEventAssignment({ contentId }, matches, events);

    if (decision.action === 'join') {
      // 幂等命中：它本来就在这个事件里，**不要再挂一次**
      //（ 有唯一约束，重挂会抛 P2002）。
      if (decision.alreadyMember) {
        // 幂等命中也可能需要**补证据 / 补交给 AI** —— 上一次可能停在
        // 挂接、挂证据、或入队 AI 之间的任意一步。
        await this.attachEvidence(decision.eventId);
        await this.startAnalysis(contentId);
        const primary = await this.repository.findEventContentCandidates(decision.eventId);
        return {
          action: 'join',
          eventId: decision.eventId,
          primaryContentId: null,
          alreadyMember: true,
          candidateCount: primary.length,
        };
      }

      const attached = await this.repository.attachContentToEvent({
        eventId: decision.eventId,
        contentId,
        relation: EVENT_RELATION.RELATED,
        now: this.clock.now(),
      });
      this.logger.info(
        {
          contentId,
          eventId: attached.eventId,
          primaryContentId: attached.primaryContentId,
          viaContentId: decision.viaContentId,
          viaScore: decision.viaScore,
        },
        'content joined an existing event',
      );
      const evidence = await this.attachEvidence(attached.eventId);
      await this.startAnalysis(contentId);
      return {
        action: 'join',
        eventId: attached.eventId,
        primaryContentId: attached.primaryContentId,
        evidence,
      };
    }

    // 新建事件：用本条内容的标题作为事件标题（`docs/00`：
    // AI 是编辑助理不是主编，标题由人改，这里不自动生成一个更中性的）。
    const created = await this.repository.createEventWithContent({
      contentId,
      canonicalTitle: canonicalTitleOf(content.title),
      relation: EVENT_RELATION.PRIMARY,
      now: this.clock.now(),
    });
    this.logger.info({ contentId, eventId: created.eventId }, 'new event created');
    const evidence = await this.attachEvidence(created.eventId);
    await this.startAnalysis(contentId);
    return {
      action: 'create',
      eventId: created.eventId,
      primaryContentId: contentId,
      evidence,
    };
  }

  /**
   * `content.dedup` 作业的主体：跑近似判重并推进状态。
   *
   * 与 `findNearDuplicates()` 的区别是**它有副作用**：
   * 把 RawItem 推进到 `READY_FOR_ANALYSIS`（`docs/06` 留下的最后一个状态值），
   * 表示「这条原始事实已经走完清洗 + 判重，可以进入事件聚合」。
   *
   * ⚠ 判重结果**只记日志、不落库** —— `Event Cluster`（S4）会重新算一遍，
   * 因为候选集会随时间变化（今天像的两条，明天可能被更多报道包进来）。
   * 把候选写进库等于固化一个会过期的快照，而 `docs/22` 要的
   * 「独立来源数」是**查询时**算的（`docs/03` 明写不冗余存储）。
   *
   * @returns 判重结果；Content 不存在时 `null`
   */
  /**
   * Evidence Attach —— 为一个事件重建/补齐证据链（`docs/07` / `docs/22`）。
   *
   * 幂等：已存在的 URL 不会重复插入（`(eventId, urlHash)` 唯一 + 计划里先挡一次）。
   * **Primary 的唯一性靠事务**（`docs/03` 明确 DB 层不强制）。
   *
   * ⚠ 这里**没有独立的 Job 名** —— `docs/13` 的 Job 清单里 content-pipeline
   * 只有 `content.normalize` / `content.dedup` / `content.event-cluster` 三个。
   * 证据挂接是「事件聚合」的最后一步（事件定了才谈得上它的证据链），
   * 所以作为 `content.event-cluster` 的一部分执行，而不是自造一个 Job 名
   *（§9 禁止自造近义 Queue / Job）。已记入 HANDOFF。
   */
  async attachEvidence(
    eventId: string,
  ): Promise<{ inserted: number; primaryUrlHash: string | null; independentSourceCount: number }> {
    const [candidates, existing] = await Promise.all([
      this.repository.findEvidenceCandidates(eventId),
      this.repository.findEventEvidence(eventId),
    ]);

    const plan = planEvidenceAttach({ candidates, existing });
    const result = await this.repository.applyEvidencePlan(eventId, plan);

    this.logger.info(
      {
        eventId,
        inserted: result.inserted,
        skippedExistingUrls: plan.skippedExistingUrls,
        independentSourceCount: result.independentSourceCount,
        primaryUrlHash: result.primaryUrlHash,
      },
      'evidence attached',
    );

    return result;
  }

  /**
   * 把内容交给 AI 阶段（`docs/07` 的「AI Analysis」）。
   *
   * 两件事：把状态推进到 `ANALYZING`，然后入队 Agent 06 的
   * `ai.translate` + `ai.classify-score`。
   *
   * ⚠ **先改状态再入队**（顺序不能反）：反过来的话，AI 任务可能在状态还是
   * `INGESTED` 时就跑完了，而收尾扫描只认 `ANALYZING` —— 那条内容会永远
   * 卡在待分析、进不了审核队列。
   *
   * ⚠ 入队失败**不吞**：抛出去让作业重试。`startAnalysis` 是幂等的
   *（重复设状态 + JobId 去重），重试不会产生重复的 AI 任务。
   */
  async startAnalysis(contentId: string): Promise<void> {
    await this.repository.markAnalyzing(contentId);
    await this.enqueuer.enqueueAiTranslation(contentId);
    await this.enqueuer.enqueueAiScoring(contentId);

    this.logger.info({ contentId }, 'content handed to the AI stage');
  }

  /**
   * 入口兜底扫描：把「已落库、但还没进流水线」的 RawItem 重新入队 normalize。
   *
   * ── 为什么需要它（流水线的**主**入口在采集器那边）──────────────────
   * 正常路径是采集器存完 RawItem 后立刻 `enqueueNormalize`
   *（`collector.service.ts` 的 `enqueueForPipeline`）—— 低延迟，
   * 不需要等扫描。但那条路有它的盲区：
   *   - 入队那一步失败（Redis 抖动 / 队列故障）时，采集已经成功、
   *     数据已经落库，那条 RawItem 就**不会**再有人来推它；
   *   - 本入口补上之前，库里已经积压的 `FETCHED` 数据没有任何触发者。
   *
   * 所以这里按「status = FETCHED 且没有对应 Content」扫一遍补上。
   * 语义与 `sweepForReview` 一致：**兜底**，不是主路径；调用频率见
   * `module.ts`（`NORMALIZE_SWEEP_INTERVAL_MS`）。
   *
   * ── 幂等与「重复入队不是 bug」──────────────────────────────────────
   * 两条路（采集器直投 + 本扫描）会重复入队同一批 raw item ——
   * 这是**设计上允许的**，不要加锁：
   *   - `normalizeJobId(rawItemId)` 保证同一条的 jobId 相同，BullMQ 会去重；
   *   - 即便 JobId 因归一化规则升版本而不同，`normalize` 本身也是幂等的
   *    （已有 Content 时走 `alreadyExisted` 分支，不重复写库）。
   * 所以重复入队的代价是一次队列去重，而不是重复建 Content。
   *
   * @returns 本次入队的条数
   */
  async sweepForNormalize(limit = 50): Promise<number> {
    const pending = await this.repository.findRawItemsAwaitingNormalize(limit);

    for (const rawItemId of pending) {
      // 入队失败**不吞**（与 `persistAndChain` 同一策略）：抛出去让调用方
      //（`module.ts` 的定时器）记一条 error。失败的那条仍是 FETCHED，
      // 下一个周期会再被扫到 —— 兜底扫描天生就是可重试的。
      await this.enqueuer.enqueueNormalize(rawItemId);
    }

    if (pending.length > 0) {
      this.logger.info({ count: pending.length }, 'normalize sweep queued raw items');
    }

    return pending.length;
  }

  /**
   * 收尾扫描：把「AI 已跑完」的内容推进到审核队列。
   *
   * ── 为什么需要一个扫描，而不是 AI 完成时回调 ──────────────────────
   * `docs/13` 固定了 10 个 Job 名，其中 content-pipeline 只有三个
   *（normalize / dedup / event-cluster）—— **没有「AI 完成」这一类**。
   * 而 Agent 06 的作业在 `ai` 队列上，它跑完时不会回调本模块
   *（§9：不越界改别人的模块，也不自造近义 Job 名）。
   *
   * 所以本模块用**扫描**来收敛：找出「状态是 ANALYZING、AiRun 都不在途、
   * 还没有审核行」的内容，把它们推进到 `REVIEW_PENDING` 并建审核行。
   * 由谁按什么频率调用见 `module.ts` 的说明（Agent 11 / 14 定调度）。
   *
   * @returns 本次收尾的条数
   */
  async sweepForReview(limit = 50): Promise<number> {
    const pending = await this.repository.findContentsAwaitingReview(limit);
    let finalized = 0;

    for (const { contentId } of pending) {
      const slugs = await this.repository.findAnalyzedTopicSlugs(contentId);
      const topicIds = await this.repository.findTopicIdsBySlugs(slugs);

      await this.repository.finalizeForReview({
        contentId,
        topics: [...topicIds.values()].map((topicId) => ({
          topicId,
          // ⚠ 模型没有为每个主题给出置信度（Agent 06 的输出契约里没有这个字段）。
          // 写 1.0 表示「这是模型选定的主题」，**不编造一个小数** ——
          // 编出来的 0.87 会被下游当成有依据的数字。
          confidence: 1,
        })),
      });

      finalized += 1;
      this.logger.info({ contentId, topics: topicIds.size }, 'content queued for review');
    }

    return finalized;
  }

  async runNearDedup(contentId: string): Promise<NearDuplicateVerdict | null> {
    const verdict = await this.findNearDuplicates(contentId);
    if (verdict === null) return null;

    const rawItemId = await this.repository.findRawItemIdByContentId(contentId);
    if (rawItemId !== null) {
      await this.repository.advanceRawItemStatus(rawItemId, RawItemStatus.READY_FOR_ANALYSIS);
    }

    this.logger.info(
      {
        contentId,
        rawItemId,
        crossSource: verdict.crossSourceMatches.length,
        sameSource: verdict.sameSourceMatches.length,
        compared: verdict.comparedCount,
      },
      'near dedup finished',
    );

    // 判重完就接下一阶段（事件聚合）。入队失败抛出去让作业重试 ——
    // 与 normalize → dedup 同一策略，且 `clusterContent` 也是幂等的。
    await this.enqueuer.enqueueEventCluster(contentId);

    return verdict;
  }

  /**
   * 判这条 RawItem 是不是某条已存在 Content 的精确重复。
   *
   * ⚠ **只查 `content_hash`（幂等键 ③），不查 ①②** ——
   * 那两条由采集端在落库前拦截（`(source_id, external_id)` 与
   * `canonical_url_hash`），到这里时同源重抓与同 URL 换参数已经没有机会进来。
   * 在 Pipeline 里再查一遍是多余的一次往返。
   *
   * @returns 重复时的判定结果；不重复时 `null`
   */
  private async findExactDuplicate(
    rawItem: RawItemWithSource,
  ): Promise<{ canonicalContentId: string; sameSource: boolean } | null> {
    if (rawItem.contentHash === null || rawItem.contentHash === '') {
      // 没有 hash 就没法判「精确」。**不猜**（不退回「标题相同就算」——
      // 那是 Near Dedup 的模糊逻辑，放这里会让 Exact 变得不准）。
      return null;
    }

    const candidates = await this.repository.findContentsByContentHash(
      rawItem.contentHash,
      rawItem.rawItemId,
    );
    const verdict = pickExactDuplicate(
      { rawItemId: rawItem.rawItemId, contentHash: rawItem.contentHash },
      candidates,
      rawItem.sourceId,
    );

    return verdict.duplicate
      ? { canonicalContentId: verdict.canonicalContentId, sameSource: verdict.sameSource }
      : null;
  }
}

/**
 * 幂等命中时返回的占位内容。
 *
 * ⚠ 它是**空的**，不是真实内容 —— 调用方若需要内容本身，应当另查库。
 * 之所以不在这里再查一次：幂等命中是重试路径上的**热路径**
 *（每次重试都会走到），为它多付一次读取不划算，而绝大多数调用方
 *（worker）只关心「成功了吗」。
 */
const EMPTY_CONTENT_PLACEHOLDER: NormalizedContent = {
  sourceId: '',
  rawItemId: '',
  type: ContentType.ARTICLE,
  title: '',
  bodyOriginal: null,
  language: '',
  originalUrl: '',
  imageUrl: null,
  publishedAt: null,
  pipelineStatus: ContentPipelineStatus.INGESTED,
  bodySource: 'none',
};
