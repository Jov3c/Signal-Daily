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
  private readonly queue: Queue<CollectorFetchSourcePayload>;

  // ⚠ 显式 @Inject：不要依赖 emitDecoratorMetadata（见 di-wiring.spec.ts）。
  constructor(
    @Inject(SOURCE_CONFIG) config: SourceConfig,
    @Inject(APP_LOGGER) private readonly logger: Logger,
  ) {
    this.queue = new Queue<CollectorFetchSourcePayload>(QueueName.COLLECTOR, {
      connection: redisConnectionOptions(config.redisUrl),
    });
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
      await this.queue.add(JobName.COLLECTOR_FETCH_SOURCE, payload, {
        jobId,
        attempts: COLLECTOR_RETRY.attempts,
        // 契约里的重试策略用 `delayMs`，BullMQ 用 `delay`。
        backoff: COLLECTOR_RETRY.backoff === null
          ? undefined
          : {
              type: COLLECTOR_RETRY.backoff.type,
              delay: COLLECTOR_RETRY.backoff.delayMs,
            },
        // 保留最近的成功记录便于排障，但不要让 Redis 无限增长。
        removeOnComplete: { age: 3_600, count: 1_000 },
        removeOnFail: { age: 86_400 },
      });
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
    await this.queue.close();
  }

  async onModuleDestroy(): Promise<void> {
    await this.close();
  }
}
