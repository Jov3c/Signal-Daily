/**
 * 单来源采集编排。
 *
 * ── 一次采集的完整步骤 ──────────────────────────────────────────────
 * ```
 * ① 取锁 source-fetch:{sourceId}        ← 幂等的前提，见 source-lock.ts
 * ② 读 Source（不存在 / 已停用 → 跳过）
 * ③ 从 raw_items 推导增量游标
 * ④ 交给适配器 fetch
 * ⑤ 去重（批内 + 库内）
 * ⑥ 落 RawItem
 * ⑦ 推进 next_fetch_at / last_* 状态
 * ⑧ 记 JobRun
 * ```
 *
 * ── 为什么 `runCollect` **不向调用方抛预期内的失败** ────────────────
 * 「上游超时」「来源被删了」「锁被占」都不是程序缺陷，而是**采集的常态**。
 * 如果它们都以异常形式冒出服务层，调用方就只能靠 `catch` + 猜
 * 来区分「这轮跳过」与「代码坏了」。
 *
 * 因此这里返回一个**显式的结论对象**（`CollectOutcome`），
 * 由 BullMQ 处理器按 `retryable` 决定重试还是终止（见 `collector.worker.ts`）。
 * 这样「失败后到底会不会重试」是一行可读的代码，而不是散落各处的
 * `instanceof` 判断。
 *
 * ── 失败隔离 ────────────────────────────────────────────────────────
 * 一个来源 = 一个 BullMQ 任务，因此**天然隔离**：一个来源失败
 * 不会影响其它来源在队列里的任务。这一点由测试钉住，不靠推理。
 */

import { Inject, Injectable } from '@nestjs/common';
import { JobName } from '@signal/contracts';
import { serializeError, type Logger } from '@signal/logger';
import { computeNextFetchAt } from '@signal/source-core';
import { adapterFor, type AdapterRegistry } from './adapters';
import { COLLECTOR_CONFIG, type CollectorConfig } from './collector.config';
import { CLOCK, type Clock } from './clock';
import { payloadContractViolated, toCollectorError, type CollectorError } from './errors';
import { contentHashOf, sha256Hex } from './hashing';
import { WORKER_LOGGER } from './logger';
import {
  JOB_RUN_REPOSITORY,
  RAW_ITEM_REPOSITORY,
  SOURCE_LOCK,
  SOURCE_REPOSITORY,
  sourceFetchLockKey,
  type CollectorFetchSourcePayload,
  type CollectorSource,
  type CollectorSourceRepository,
  type JobRunRepository,
  type NewRawItem,
  type RawItemRepository,
  type SourceLock,
} from './ports';
import { collectorLockTtlMs } from './source-lock';
import { type CollectedItem } from './types';
import { assertPayloadShape } from './payload-keys';
import { fitItemToColumns } from './field-limits';
import { canonicalizeUrl } from './url/canonical';

/** 注入 token。 */
export const ADAPTER_REGISTRY = 'COLLECTOR_ADAPTER_REGISTRY';

/** 一次采集的结论。 */
export type CollectOutcome =
  | {
      status: 'succeeded';
      sourceId: string;
      /** 适配器返回的条目数。 */
      collected: number;
      /** 去掉重复后真正写入库的条数。 */
      stored: number;
      /** 适配器因为「追溯不到原始来源」跳过的条数。 */
      skippedByAdapter: number;
      /** 被去重挡掉的条数（批内重复 + 库里已有）。 */
      duplicates: number;
    }
  | { status: 'skipped'; sourceId: string; reason: 'locked' | 'not-found' | 'disabled' }
  | { status: 'failed'; sourceId: string; errorCode: string; message: string; retryable: boolean };

/** 运行上下文：BullMQ 处理器能提供的重试信息。 */
export type CollectRunContext = {
  /** 第几次尝试（从 1 开始）。 */
  attempt: number;
  /** 是否已是最后一次尝试（决定 JobRun 记 FAILED 还是 DEAD，`docs/13` 的 dead-letter）。 */
  isFinalAttempt: boolean;
};

@Injectable()
export class CollectorService {
  constructor(
    @Inject(COLLECTOR_CONFIG) private readonly config: CollectorConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(SOURCE_REPOSITORY) private readonly sources: CollectorSourceRepository,
    @Inject(RAW_ITEM_REPOSITORY) private readonly rawItems: RawItemRepository,
    @Inject(JOB_RUN_REPOSITORY) private readonly jobRuns: JobRunRepository,
    @Inject(SOURCE_LOCK) private readonly lock: SourceLock,
    @Inject(ADAPTER_REGISTRY) private readonly adapters: AdapterRegistry,
    @Inject(WORKER_LOGGER) private readonly logger: Logger,
  ) {}

  /**
   * 采集一个来源。**任何**失败都收敛成三种结论之一，不向上抛。
   *
   * 包括「某个 `SourceType` 没有注册适配器」这类程序缺陷：它会被收敛成
   * 一条 `SOURCE_FETCH_FAILED` 的失败结论，而不是让整个任务以堆栈结束。
   * 理由与代价写在 `adapters/index.ts` 的 `adapterFor()` 注释里 ——
   * 简单说：数据问题（库里有个没人处理的类型）管理员能自己处理，
   * 而堆栈结束会让 `last_error_code` 空着，后台无从下手。
   * 原异常仍通过 `cause` 保留在日志里，代码缺陷一样可见。
   */
  async runCollect(
    payload: CollectorFetchSourcePayload,
    run: CollectRunContext,
  ): Promise<CollectOutcome> {
    const sourceId = payload.sourceId;
    const lockKey = sourceFetchLockKey(sourceId);
    const startedAt = this.clock.now();

    // ① 取锁。拿不到说明同来源已经有人在抓（见 source-lock.ts：跳过，不等待）。
    let token: string | null;
    try {
      token = await this.lock.acquire(lockKey, collectorLockTtlMs(this.config.fetchTimeoutMs));
    } catch (error) {
      // Redis 不可用 —— 基础设施故障，可重试。
      // 此时还没有 JobRun，直接记一次失败（不写 sources 状态：
      // 连锁都拿不到时去写库，只会在 Redis 也挂的时候放大故障）。
      const collectorError = toCollectorError(error, 'acquire source lock');
      this.logger.error(
        { sourceId, errorCode: collectorError.code, err: serializeError(collectorError) },
        'collector could not acquire the source lock',
      );
      return this.failureOf(sourceId, collectorError);
    }
    if (token === null) {
      this.logger.warn(
        { sourceId },
        'collector skipped: another fetch for this source is already in flight',
      );
      return { status: 'skipped', sourceId, reason: 'locked' };
    }

    const jobRunId = await this.jobRuns.start(startedAt, {
      jobType: JobName.COLLECTOR_FETCH_SOURCE,
      // `JobId.*` 是唯一的幂等键构造点；但 payload 里没有 window，
      // 而 jobKey 只用于运维查询（不参与幂等），因此用 sourceId 标记。
      jobKey: null,
      metadata: { sourceId, trigger: payload.trigger, attempt: run.attempt },
    });

    try {
      return await this.collectUnderLock(payload, run, startedAt, jobRunId);
    } finally {
      // 锁必须在**所有**出口释放，包括异常路径 —— 否则该来源会被卡到
      // TTL 到期为止，症状是「这个源莫名其妙一段时间不更新」。
      await this.lock.release(lockKey, token);
    }
  }

  private async collectUnderLock(
    payload: CollectorFetchSourcePayload,
    run: CollectRunContext,
    startedAt: Date,
    jobRunId: string | null,
  ): Promise<CollectOutcome> {
    const sourceId = payload.sourceId;

    // ② 读 Source。
    const source = await this.sources.findById(sourceId);
    if (source === null) {
      // 来源在入队之后被删了（或 id 超出可绑定范围）。这是竞态，不是错误 ——
      // 记 SUCCEEDED 而不是 FAILED，否则会给运维制造一个假的失败告警。
      await this.jobRuns.finish(jobRunId, this.clock.now(), {
        status: 'SUCCEEDED',
        errorCode: null,
        attempts: run.attempt,
      });
      this.logger.warn({ sourceId }, 'collector skipped: source no longer exists');
      return { status: 'skipped', sourceId, reason: 'not-found' };
    }

    // 防御纵深：`docs/06`「停用后停止产生新抓取任务」。
    // 到期查询已经过滤过一层，但那层依赖查询条件写对；这里再判一次
    // 是**行为**层面的保证。手动触发（manual）刻意不受此限 ——
    // 见 Agent 03 HANDOFF 的 Known Limitations 第 5 条（disable 的语义是
    // 「停止调度」，管理员手动触发仍应可用）。
    if (payload.trigger === 'schedule' && !source.enabled) {
      await this.jobRuns.finish(jobRunId, this.clock.now(), {
        status: 'SUCCEEDED',
        errorCode: null,
        attempts: run.attempt,
      });
      this.logger.warn({ sourceId }, 'collector skipped: source is disabled');
      return { status: 'skipped', sourceId, reason: 'disabled' };
    }

    try {
      // ③ 游标（从库里已有事实推导，见 types.ts 的 CollectorCursor）
      const cursor = await this.sources.latestCursor(sourceId);

      // ④ 采集
      const adapter = adapterFor(this.adapters, source.type);
      const batch = await adapter.fetch(source, cursor, {
        timeoutMs: this.config.fetchTimeoutMs,
        maxBytes: this.config.fetchMaxBytes,
        credentials: {
          xApiBearerToken: this.config.xApiBearerToken,
          githubToken: this.config.githubToken,
        },
        // ⚠ 必须把这两个**透传**下去。原先 service 不传，于是
        // 「真适配器 + 真 service」这种测试在结构上写不出来（会打真网），
        // 而正是那条路径上藏着「X 适配器的 payload 被守卫拦下」的 P0。
        fetchImpl: this.config.fetchImpl,
        lookup: this.config.lookup,
      });

      // ⑤⑥ 去重 + 落库
      const { stored, duplicates, skippedByLength, truncatedFields, deferred } = await this.persist(
        source,
        batch.items,
        startedAt,
        batch.roundLimit,
      );
      if (deferred > 0) {
        // 「留到下一轮」不是丢失 —— 窗口会随轮次向下推进（见 types.ts 的
        // `roundLimit` 说明）。但管理员应当知道这一轮的 `maxItems` 把
        // 多少条推迟了，以及为什么（feed 比窗口长）。
        this.logger.info(
          { sourceId, deferred, stored },
          'collector deferred the rest of the window to the next round',
        );
      }
      if (skippedByLength > 0 || truncatedFields.length > 0) {
        this.logger.warn(
          { sourceId, skippedByLength, truncatedFields },
          'collector dropped or truncated items to fit database column widths',
        );
      }

      // ⑦ 推进状态。基准是**本轮开始时刻**，不是结束时刻 ——
      // 用结束时刻会让实际周期变成 `interval + 耗时`，慢源会持续退化。
      await this.sources.recordFetchOutcome(sourceId, {
        at: startedAt,
        nextFetchAt: computeNextFetchAt(source.fetchIntervalSeconds, startedAt),
        errorCode: null,
      });

      // ⑧ JobRun
      await this.jobRuns.finish(jobRunId, this.clock.now(), {
        status: 'SUCCEEDED',
        errorCode: null,
        attempts: run.attempt,
      });

      if (!batch.complete) {
        // 「上游给的没取完」必须是一条**可行动**的日志，而不是恒为 true 的字段。
        // 见 `CollectorBatch.complete` 的说明与各适配器的窗口上限。
        this.logger.warn(
          {
            sourceId,
            sourceType: source.type,
            collected: batch.items.length,
            skippedByAdapter: batch.skippedCount,
          },
          'collector did not take everything the upstream offered',
        );
      }

      if (batch.warnings.length > 0) {
        // 不致命的解析问题（例如未转义的 `&`）。记 warn 而不是 error：
        // 数据是完整的，采集成功了；但它确实说明上游的 feed 有问题。
        this.logger.warn(
          { sourceId, warnings: batch.warnings },
          'collector finished with warnings',
        );
      }

      this.logger.info(
        {
          sourceId,
          sourceType: source.type,
          collected: batch.items.length,
          stored,
          duplicates,
          skippedByAdapter: batch.skippedCount,
          durationMs: this.clock.now().getTime() - startedAt.getTime(),
        },
        'collector fetch succeeded',
      );

      return {
        status: 'succeeded',
        sourceId,
        collected: batch.items.length,
        stored,
        skippedByAdapter: batch.skippedCount,
        duplicates,
      };
    } catch (error) {
      return this.recordFailure(
        source,
        toCollectorError(error, `source ${source.slug}`),
        run,
        startedAt,
        jobRunId,
      );
    }
  }

  /**
   * 记录失败。
   *
   * 两件事都必须做：
   *   1. 把错误码写到 `sources.last_error_code` 并**推进 `next_fetch_at`**
   *      —— 否则一个一直失败的来源会被每一轮反复取出来，吃掉全部队列额度；
   *   2. 记 JobRun，让后台看得到。
   */
  private async recordFailure(
    source: CollectorSource,
    error: CollectorError,
    run: CollectRunContext,
    startedAt: Date,
    jobRunId: string | null,
  ): Promise<CollectOutcome> {
    this.logger.error(
      {
        sourceId: source.id,
        sourceType: source.type,
        errorCode: error.code,
        attempt: run.attempt,
        err: serializeError(error),
        // 把原异常单独带上：`toCollectorError` 会把它挂在 `cause` 上，
        // 而 `serializeError` 默认只展开最外层 —— 少了这一项，
        // 「没有注册适配器」这类代码缺陷在日志里只剩下一条被包装过的消息。
        cause: error.cause === undefined ? null : serializeError(error.cause),
      },
      'collector fetch failed',
    );

    try {
      await this.sources.recordFetchOutcome(source.id, {
        at: startedAt,
        nextFetchAt: computeNextFetchAt(source.fetchIntervalSeconds, startedAt),
        errorCode: error.code,
      });
    } catch (updateError) {
      // 状态推进失败不能掩盖真正的失败原因 —— 两个都记。
      this.logger.error(
        { sourceId: source.id, err: serializeError(updateError) },
        'failed to record the fetch outcome',
      );
    }

    await this.jobRuns.finish(jobRunId, this.clock.now(), {
      // ⚠ 不可重试的失败**立刻**是终态。
      // 原来只按 `run.isFinalAttempt` 判断，于是「令牌没配」这类失败
      // （第 1 次尝试就被 `UnrecoverableError` 终止，永远不会有第 3 次）
      // 的 JobRun 会**永远停在 FAILED，never DEAD** ——
      // 而它恰恰是唯一需要人去动手的那一类（`docs/13` 的 dead-letter
      // 视图会漏掉它们）。
      status: run.isFinalAttempt || !error.retryable ? 'DEAD' : 'FAILED',
      errorCode: error.code,
      attempts: run.attempt,
    });

    return this.failureOf(source.id, error);
  }

  private failureOf(sourceId: string, error: CollectorError): CollectOutcome {
    return {
      status: 'failed',
      sourceId,
      errorCode: error.code,
      message: error.message,
      retryable: error.retryable,
    };
  }

  /**
   * 去重 + 落库。返回真正写入的条数与被去重挡掉的数量。
   *
   * **两层去重，缺一不可**：
   *   - **批内**：同一个 feed 里出现两次同一条目（聚合型 feed 确实会这样）时
   *     只保留第一条。不处理的话这一批自己就会插两遍 —— 而「先查后写」
   *     查的是**库里**已有的事实，看不到同批的另一条。
   *   - **库内**：`docs/06` 的幂等第 1、2 条（source+externalId、canonical URL hash）。
   *
   * 第 3 条（content hash）**刻意不参与去重** —— 同一篇文章换了标题、
   * 或正文被上游修订，都应作为新事实入库；Near Dedup 是 `docs/07`
   * 里 Pipeline（Agent 05）的判断，采集端越权会把有用信息提前丢掉。
   */
  private async persist(
    source: CollectorSource,
    items: CollectedItem[],
    fetchedAt: Date,
    roundLimit: number | null | undefined,
  ): Promise<{
    stored: number;
    duplicates: number;
    skippedByLength: number;
    truncatedFields: string[];
    /** 因为每轮上限而**留到下一轮**的条数（不是丢失 —— 下一轮会继续取）。 */
    deferred: number;
  }> {
    if (items.length === 0) {
      return {
        stored: 0,
        duplicates: 0,
        skippedByLength: 0,
        truncatedFields: [],
        deferred: 0,
      };
    }

    const seenExternalIds = new Set<string>();
    const seenHashes = new Set<string>();
    const unique: NewRawItem[] = [];
    let duplicates = 0;
    /** 因为 URL 不可入库（过长 / 非绝对）被丢掉的条数。 */
    let skippedByLength = 0;
    /** 被截断的字段（进日志，让「数据不是原样入库」可见）。 */
    const truncatedFields: string[] = [];

    for (const item of items) {
      // 适配器已经归一化过一次，这里再归一化是**幂等的**，
      // 同时也把「适配器忘了归一化」这类缺陷挡在库外
      // （canonicalUrlHash 是去重的唯一依据，格式必须稳定）。
      const canonicalUrl = canonicalizeUrl(item.canonicalUrl) ?? item.canonicalUrl;
      const canonicalUrlHash = sha256Hex(canonicalUrl);

      // 外部输入的字段长度收敛到列宽以内。
      // 不做的话**一条坏条目会让整批失败**（`createMany` 是全有或全无），
      // 而且这个来源此后每一轮都失败 —— 症状只是「这个来源一直是空的」。
      //
      // ⚠ 顺序很重要：**先**把字段收敛到列宽，**再**做批内去重。
      //
      // 反过来的话，两条只在第 513 个字符上不同的 guid 会各自通过批内去重
      // （判的是未截断的值），却在落库时撞成同一个 `external_id` ——
      // 库里出现两行同 id 的记录（`raw_items` 上没有唯一约束，不会报错），
      // `docs/06` 的幂等键在写入那一刻被绕过。
      // 只在 guid 超长时触发，但顺序本身没有理由反过来。
      const fitted = fitItemToColumns({
        externalId: item.externalId,
        originalUrl: item.originalUrl,
        canonicalUrl,
        title: item.title,
      });
      if (fitted.dropped) {
        // URL 过长或不是绝对地址。截断一个 URL 会得到 404 链接，
        // 而 `docs/00` 要求「任何公开内容必须可追溯到原始来源」——
        // 与其编一个假链接，不如丢掉这一条并计数。
        skippedByLength += 1;
        continue;
      }
      if (fitted.truncated.length > 0) truncatedFields.push(...fitted.truncated);

      if (
        (fitted.externalId !== null && seenExternalIds.has(fitted.externalId)) ||
        seenHashes.has(canonicalUrlHash)
      ) {
        duplicates += 1;
        continue;
      }
      if (fitted.externalId !== null) seenExternalIds.add(fitted.externalId);
      seenHashes.add(canonicalUrlHash);

      // 「Source 元数据不得进 payload」的守卫，按类型白名单
      // （`tasks/agent-04` 要求；黑名单会误杀也会漏网，见 payload-keys.ts）。
      // ⚠ 用 `payloadContractViolated` 而不是让普通 Error 冒泡：
      // 否则它会被收敛成**可重试**的 `SOURCE_FETCH_FAILED`，
      // 而这是代码缺陷，重试 3 次只会延迟暴露 + 写 3 条同样的日志。
      try {
        assertPayloadShape(
          source.type,
          item.payload,
          `source ${source.slug} item ${item.externalId ?? canonicalUrl}`,
        );
      } catch (error) {
        throw payloadContractViolated(error instanceof Error ? error.message : String(error));
      }

      unique.push({
        sourceId: source.id,
        externalId: fitted.externalId,
        originalUrl: fitted.originalUrl,
        canonicalUrl: fitted.canonicalUrl,
        canonicalUrlHash,
        titleRaw: fitted.title,
        bodyRaw: item.body,
        payload: item.payload,
        language: item.language,
        publishedAt: item.publishedAt,
        fetchedAt,
        contentHash: contentHashOf(fitted.title, item.body),
        status: 'FETCHED',
      });
    }

    if (unique.length === 0) {
      return {
        stored: 0,
        duplicates,
        skippedByLength,
        truncatedFields: [...new Set(truncatedFields)],
        deferred: 0,
      };
    }

    const existing = await this.rawItems.findExistingKeys({
      sourceId: source.id,
      externalIds: unique
        .map((item) => item.externalId)
        .filter((value): value is string => value !== null),
      canonicalUrlHashes: unique.map((item) => item.canonicalUrlHash),
    });

    const freshAll = unique.filter(
      (item) =>
        !existing.canonicalUrlHashes.has(item.canonicalUrlHash) &&
        (item.externalId === null || !existing.externalIds.has(item.externalId)),
    );
    duplicates += unique.length - freshAll.length;

    // ⚠ 「每轮上限」必须在这里施加（**去重之后**），不能在适配器解析时施加。
    // 施加在解析时 → 每轮都取同一批最新条目，第 N+1 条之后永远轮不到
    // （feed 顺序稳定）→ 永久丢失。施加在这里 → 已经采到的被去重挡掉，
    // 下一轮自然从上次停下的地方继续，窗口**随轮次向下推进**。
    const limit = roundLimit ?? null;
    const fresh = limit === null ? freshAll : freshAll.slice(0, limit);
    const deferred = freshAll.length - fresh.length;

    return {
      stored: await this.rawItems.insertMany(fresh),
      duplicates,
      skippedByLength,
      truncatedFields: [...new Set(truncatedFields)],
      deferred,
    };
  }
}
