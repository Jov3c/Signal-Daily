/**
 * `collector` 队列的生产端（调度器入队）。
 *
 * ── 与 Agent 03 的入队必须逐字一致 ──────────────────────────────────
 * 同一个队列 `collector` 有两个生产端：
 *   - `apps/api` 的 `POST /admin/sources/:id/fetch-now`（Agent 03）；
 *   - 本文件（Agent 04 的调度器）。
 *
 * Queue 名、Job 名、JobId 格式、重试策略、载荷形状**全部取自契约**，
 * 一处都不自己拼：
 *
 * ```
 * Queue     collector                    (QueueName.COLLECTOR)
 * Job       collector.fetch-source       (JobName.COLLECTOR_FETCH_SOURCE)
 * JobId     collector:{sourceId}:{window}(JobId.collectorFetchSource)
 * 重试      3 次指数退避                  (COLLECTOR_RETRY)
 * 载荷      {sourceId, trigger, requestedAt}
 * ```
 *
 * ⚠ `docs/13` 的 `COLLECTOR_RETRY.backoff` 用 `delayMs`，BullMQ 用 `delay` —
 * 这个字段名转换只在契约注释里写明，写错的表现是「退避间隔变成默认 0」
 * （不报错，只是重试变得很密）。Agent 03 已经踩过一次，这里照抄同一段。
 *
 * ── 为什么 `fetch-now` 的 5 秒超时这里也要有 ────────────────────────
 * BullMQ 要求 `maxRetriesPerRequest: null`，副作用是 **Redis 挂掉时
 * ioredis 会无限重试**，`queue.add()` 于是永远不 resolve。
 * 调度器若卡在这里，整个轮询就停了 —— 而且一条错误日志都不会留下
 * （没有异常可记）。所以同样加一个等待上限。
 */

import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import { COLLECTOR_RETRY, JobId, JobName, QueueName } from '@signal/contracts';
import type { CollectorFetchSourcePayload, EnqueuedFetch, SourceFetchQueue } from './ports';
import { COLLECTOR_CONFIG, type CollectorConfig } from './collector.config';
import { redisConnectionOptions } from './redis';

/** 幂等窗口：同一分钟内重复的入队合并成一次。 */
export const FETCH_WINDOW_MS = 60_000;

/** 把时刻折成幂等窗口标识（epoch 分钟），与 Agent 03 的 `fetchWindow` 一致。 */
export function fetchWindow(at: Date): string {
  return String(Math.floor(at.getTime() / FETCH_WINDOW_MS));
}

/** 单次入队的等待上限（毫秒）。 */
export const ENQUEUE_TIMEOUT_MS = 5_000;

@Injectable()
export class BullSourceFetchQueue implements SourceFetchQueue, OnModuleDestroy {
  private readonly queue: Queue<CollectorFetchSourcePayload>;

  /**
   * 实际使用的队列名。暴露出来是为了**可以被断言**。
   *
   * ⚠ `docs/13` 固定了队列名 `collector`；`apps/api`（Agent 03）按这个名字入队，
   * worker 按这个名字消费。一旦这个默认值被改错，两边会落在**两个不同的队列**上
   * —— **采集会整体静默停止**，而所有单测/集成测试都看不出来
   * （反证实测：把默认名改成 `collector-typo`，202 项单测 + 46 项集成**全绿**）。
   * 现在集成测试里有一条断言直接读这个属性。
   */
  readonly queueName: string;

  /**
   * @param queueName 队列名。**生产恒为契约里的 `collector`**
   *   （`QueueName.COLLECTOR`，`docs/13`）。
   *
   *   这个参数的存在只为一件事：集成测试必须能用一个**自己的**队列名。
   *   原先测试直接用生产队列名并在 `beforeAll` / `afterAll` 里
   *   `obliterate({force:true})` —— 那会**清空共享 Redis 上真实 worker
   *   正在消费的生产队列**，表现为「任务莫名消失」。测试不该动生产队列。
   */
  constructor(
    @Inject(COLLECTOR_CONFIG) config: CollectorConfig,
    queueName: string = QueueName.COLLECTOR,
  ) {
    this.queueName = queueName;
    this.queue = new Queue<CollectorFetchSourcePayload>(queueName, {
      connection: redisConnectionOptions(config.redisUrl),
    });
  }

  async enqueue(payload: CollectorFetchSourcePayload, at: Date): Promise<EnqueuedFetch> {
    const window = fetchWindow(at);
    const jobId = JobId.collectorFetchSource(payload.sourceId, window);

    await withTimeout(
      this.queue.add(JobName.COLLECTOR_FETCH_SOURCE, payload, {
        jobId,
        attempts: COLLECTOR_RETRY.attempts,
        backoff:
          COLLECTOR_RETRY.backoff === null
            ? undefined
            : {
                type: COLLECTOR_RETRY.backoff.type,
                delay: COLLECTOR_RETRY.backoff.delayMs,
              },
        // 与 Agent 03 的选项保持一致：保留最近的成功记录便于排障，
        // 但不让 Redis 无限增长。
        removeOnComplete: { age: 3_600, count: 1_000 },
        removeOnFail: { age: 86_400 },
      }),
      ENQUEUE_TIMEOUT_MS,
      `enqueue timed out after ${ENQUEUE_TIMEOUT_MS}ms`,
    );

    return { queue: QueueName.COLLECTOR, jobName: JobName.COLLECTOR_FETCH_SOURCE, jobId, window };
  }

  async close(): Promise<void> {
    await this.queue.close();
  }

  async onModuleDestroy(): Promise<void> {
    await this.close();
  }
}

/** 给 promise 加等待上限（超时后原 promise 仍在后台跑，由 JobId 幂等保证不重复执行）。 */
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
