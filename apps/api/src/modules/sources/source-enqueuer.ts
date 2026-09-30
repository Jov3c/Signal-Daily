/**
 * 采集任务入队 —— `POST /admin/sources/:id/fetch-now` 的落点。
 *
 * ── 为什么这里必须有真实的 Redis 依赖 ────────────────────────────────
 * `docs/13` 规定采集走 BullMQ 的 `collector` 队列。`fetch-now` 的语义是
 * 「**现在**让 Collector 抓一次」，唯一忠实的实现就是往那个队列里放一个
 * `collector.fetch-source` 任务。如果这里只写个空壳返回 `{queued:true}`，
 * 管理员点完「立即抓取」什么都不会发生 —— 那比报错更糟。
 *
 * 因此 **Redis 是本端点的硬依赖**：Redis 不可用时返回 503
 * `SOURCE_ENQUEUE_FAILED`，而不是静默成功。（与 Agent 02 在登录限流上
 * 的 fail-closed 取舍一致，见 HANDOFF 给 Agent 11 的说明。）
 *
 * ── JobId 幂等 ─────────────────────────────────────────────────
 * 用契约里的 `JobId.collectorFetchSource(sourceId, window)`，
 * 其中 window 是**按分钟**的时间桶。于是同一分钟内连点两下「立即抓取」
 * 只会入队一次 —— 这正是 `docs/13` 要的幂等语义，
 * 也避免管理员误触把队列刷满。
 */

import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { Queue, type ConnectionOptions } from 'bullmq';
import {
  AppError,
  COLLECTOR_RETRY,
  DomainErrorCode,
  JobId,
  JobName,
  QueueName,
} from '@signal/contracts';
import { serializeError, type Logger } from '@signal/logger';
import { APP_LOGGER } from '../../common/logger/app-logger';
import { SOURCE_CONFIG, type SourceConfig } from './source.config';

/** 注入 token。 */
export const SOURCE_FETCH_ENQUEUER = 'SOURCE_FETCH_ENQUEUER';

/** 入队选项的可注入替身（测试用）。 */
export const SOURCE_ENQUEUER_OPTIONS = 'SOURCE_ENQUEUER_OPTIONS';

export type SourceEnqueuerOptions = {
  /** 单次入队的等待上限（毫秒）。 */
  timeoutMs?: number;
};

/**
 * 入队等待上限。
 *
 * ⚠ 为什么必须有这个超时：
 * BullMQ 要求连接使用 `maxRetriesPerRequest: null`（否则 Worker 侧会在网络
 * 抖动时抛「max retries per request」）。副作用是 **Redis 挂掉时 ioredis 会
 * 无限重试**，`queue.add()` 于是永远不 resolve ——
 * 管理员点「立即抓取」会看到请求一直挂着，直到网关超时，
 * 而且连一条错误日志都不会留下（没有异常可记）。
 *
 * 加上这个上限之后，Redis 不可用会在 5 秒内变成 503 `SOURCE_ENQUEUE_FAILED`，
 * 语义明确、可告警、可重试。
 */
export const ENQUEUE_TIMEOUT_MS = 5_000;

/**
 * `collector.fetch-source` 的任务载荷。
 *
 * ⚠ 这个形状**尚未写入 `docs/13`**（那里只固定了 Queue 名 / Job 名 / JobId 格式）。
 * 本模块先定下来，已提交 CONTRACT_CHANGE_REQUEST 请求固化 ——
 * Agent 04 的 Worker 消费端必须与此对齐。
 */
export type CollectorFetchSourcePayload = {
  /** BIGINT → string（`docs/02`）。 */
  sourceId: string;
  /** 谁触发的：管理员手动 vs 调度器到期。 */
  trigger: 'manual' | 'schedule';
  /** 入队时刻，ISO 8601 UTC。 */
  requestedAt: string;
};

/** 幂等窗口：同一分钟内重复的手动触发合并成一次。 */
export const FETCH_NOW_WINDOW_MS = 60_000;

/** 把时刻折成幂等窗口标识（epoch 分钟）。 */
export function fetchWindow(at: Date): string {
  return String(Math.floor(at.getTime() / FETCH_NOW_WINDOW_MS));
}

export type EnqueuedSourceFetch = {
  queue: string;
  jobName: string;
  jobId: string;
  window: string;
};

export interface SourceFetchEnqueuer {
  enqueueFetchNow(sourceId: string, at: Date): Promise<EnqueuedSourceFetch>;
  /** 释放连接。 */
  close(): Promise<void>;
}

/**
 * 从 `REDIS_URL` 推导 BullMQ 的连接参数。
 *
 * BullMQ 的 `connection` 直接吃 ioredis 的 options，**不接受 `url` 字段**，
 * 所以这里手工拆一次。导出以便单测直接断言（例如 `rediss:` 必须带 tls）。
 */
export function redisConnectionOptions(redisUrl: string): ConnectionOptions {
  const url = new URL(redisUrl);
  const options: ConnectionOptions = {
    host: url.hostname,
    port: url.port === '' ? 6379 : Number(url.port),
    // BullMQ 要求：阻塞式命令不能被 ioredis 的默认重试次数打断，
    // 否则 Worker 侧会在网络抖动时抛出「max retries per request」。
    maxRetriesPerRequest: null,
    // ⚠ 惰性连接：ioredis 在构造时不去连，第一条命令才连。
    //
    // **实测效果（2026-10-01 复测，与之前记录的不同）**：这一行把进程级
    // 未处理 rejection 从 **2 条降到 1 条**，**但没有清零**。剩下的那 1 条
    // 已经定位到确切的出处（见下面 `getQueue()` 的注释）。
    lazyConnect: true,
  };
  if (url.username !== '') options.username = decodeURIComponent(url.username);
  if (url.password !== '') options.password = decodeURIComponent(url.password);
  const db = url.pathname.replace(/^\//, '');
  if (db !== '') options.db = Number(db);
  if (url.protocol === 'rediss:') options.tls = {};
  return options;
}

@Injectable()
export class BullSourceFetchEnqueuer implements SourceFetchEnqueuer, OnModuleDestroy {
  /**
   * ⚠ **Queue 本身也是惰性建的**（第一次入队时才建）—— 这是 2026-10-01 的改动。
   *
   * 只把连接设成 `lazyConnect` **不够**。此前那道只把进程级未处理 rejection
   * 从 2 条降到 1 条，剩下那条的确切出处是：
   *
   * ```text
   * ioredis/built/Redis.js:220   ← connect() 内部注册的 connectionCloseHandler
   *   reject(new Error("Connection is closed."))
   * ```
   *
   * 也就是说被拒绝的是 **`client.connect()` 这个 promise 本身**，它由
   * `bullmq/dist/cjs/classes/node-redis-client.js` 持有（`connectPromise`）。
   * BullMQ 的 `RedisConnection.close()` 只在 `status === 'ready'` 时走 `quit()`
   * 那条干净路径；**只要连接还在 `initializing`，它就走 `disconnect()`**，
   * 而那个 `connectPromise` 会随之被拒绝、且**没有任何人接** —— `disconnect()`
   * 里那段 `this.initializing?.catch(() => {})` 只盖住了 `init()`，盖不住它。
   *
   * `lazyConnect` 恰恰**制造**了「关闭时仍处于 initializing」这个状态：
   * 惰性连接意味着构造函数之后连接从未建立，于是 `app.close()` 来的时候
   * 状态必然是 `initializing`。这是一个自造的必现竞态，不是运气问题
   * （实测：Redis 在 6390 可达时同样复现）。
   *
   * 所以把同一个理由走完：那个文件头本来就说「入队是**用户触发**的，
   * 启动期本来就不需要这条连接」。既然不需要连接，那就**也不需要 Queue**。
   * 于是没有任何入队的进程（`boot.spec` 整条测试、端到端冒烟、以及生产里
   * 没人点「立即抓取」的时刻）根本不会创建它。
   */
  private queue: Queue<CollectorFetchSourcePayload> | null = null;

  private readonly connectionOptions: ConnectionOptions;

  private readonly timeoutMs: number;

  // ⚠ 显式 @Inject：不要依赖 emitDecoratorMetadata（见 di-wiring.spec.ts）。
  constructor(
    @Inject(SOURCE_CONFIG) config: SourceConfig,
    @Inject(APP_LOGGER) private readonly logger: Logger,
    @Inject(SOURCE_ENQUEUER_OPTIONS) options: SourceEnqueuerOptions,
  ) {
    this.timeoutMs = options.timeoutMs ?? ENQUEUE_TIMEOUT_MS;
    this.connectionOptions = redisConnectionOptions(config.redisUrl);
  }

  /** 第一次入队时才建 Queue（因而才连 Redis）。 */
  private getQueue(): Queue<CollectorFetchSourcePayload> {
    this.queue ??= new Queue<CollectorFetchSourcePayload>(QueueName.COLLECTOR, {
      connection: this.connectionOptions,
    });
    return this.queue;
  }

  async enqueueFetchNow(sourceId: string, at: Date): Promise<EnqueuedSourceFetch> {
    const window = fetchWindow(at);
    const jobId = JobId.collectorFetchSource(sourceId, window);

    const payload: CollectorFetchSourcePayload = {
      sourceId,
      trigger: 'manual',
      requestedAt: at.toISOString(),
    };

    try {
      await withTimeout(
        this.getQueue().add(JobName.COLLECTOR_FETCH_SOURCE, payload, {
          jobId,
          attempts: COLLECTOR_RETRY.attempts,
          // 契约里的重试策略用 `delayMs`，BullMQ 用 `delay`。
          backoff:
            COLLECTOR_RETRY.backoff === null
              ? undefined
              : {
                  type: COLLECTOR_RETRY.backoff.type,
                  delay: COLLECTOR_RETRY.backoff.delayMs,
                },
          // 保留最近的成功记录便于排障，但不要让 Redis 无限增长。
          removeOnComplete: { age: 3_600, count: 1_000 },
          removeOnFail: { age: 86_400 },
        }),
        this.timeoutMs,
        `enqueue timed out after ${this.timeoutMs}ms`,
      );
    } catch (error) {
      // fail-closed：入队没成功就必须让调用方知道，绝不能返回「已入队」。
      // 日志里只带 sourceId 与错误摘要 —— 连接串里有密码。
      this.logger.error(
        { sourceId, errorCode: DomainErrorCode.SOURCE_ENQUEUE_FAILED, err: serializeError(error) },
        'failed to enqueue source fetch',
      );
      throw new AppError({
        code: DomainErrorCode.SOURCE_ENQUEUE_FAILED,
        httpStatus: 503,
        safeMessage: 'Could not enqueue the fetch job; the queue is unavailable',
        cause: error,
      });
    }

    return { queue: QueueName.COLLECTOR, jobName: JobName.COLLECTOR_FETCH_SOURCE, jobId, window };
  }

  async close(): Promise<void> {
    // 从未入队过 → Queue 从未被创建 → 也就没有连接要关。
    if (this.queue === null) return;
    await this.queue.close();
  }

  async onModuleDestroy(): Promise<void> {
    // 关连接是尽力的：它对业务结果毫无影响（进程都要退出了），
    // 却能决定 `app.close()` 是干净退出还是抛异常。
    // 仓库里 `public-read` / `health` 本来就写了 `.catch`，这里补齐。
    await this.close().catch(() => undefined);
  }
}

/**
 * 给一个 promise 加上等待上限。
 *
 * 注意：超时后**原 promise 仍在后台跑**（ioredis 会继续重试），
 * 这里只是不再等它。可以接受 —— 一旦 Redis 恢复，那次入队会补上，
 * 而 JobId 幂等保证它不会被重复执行。
 */
async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
