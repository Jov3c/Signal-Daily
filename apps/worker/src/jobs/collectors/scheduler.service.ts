/**
 * Source Scheduler —— `docs/06` 的「每分钟查 `enabled && next_fetch_at <= now`」。
 *
 * ── 为什么用 `setInterval` 而不是 BullMQ 的 repeatable job ───────────
 * `docs/13` 固定了 6 个 Queue 名与 10 个 Job 名，**没有**「调度扫描」这一个。
 * 用一个 repeatable job 就得发明一个新 Job 名，而 `docs/13` 明令
 * 「禁止创建近义 Queue」、`docs/05` 明令「禁止同义错误码」——
 * 同一套精神下，悄悄多出一个契约外的 Job 名是不行的。
 *
 * 因此调度扫描用进程内定时器 + **Redis 锁**（`docs/06` 本来就要求
 * 「Redis lock `source-fetch:{sourceId}`，再入 Queue」）。多实例部署时，
 * 锁保证同一个来源不会被两个实例同时入队；BullMQ 的 JobId 幂等
 * （`collector:{sourceId}:{window}`，window 是 epoch 分钟）再兜一层。
 *
 * 这个取舍的代价是：**调度精度依赖进程存活**。如果 worker 进程挂了，
 * 就没有人在扫描。这是可接受的 —— 采集本来就是「进程活着才发生」的事，
 * Agent 11 的存活监控覆盖了这一点（`docs/15` 的告警项里有 Queue backlog）。
 *
 * ── 一轮扫描里的三层容错 ────────────────────────────────────────────
 *   1. **整轮**：MySQL 不可用 → 记日志，跳过这一分钟，下一分钟继续；
 *   2. **单个来源**：任何一个来源入队失败不影响同批其它来源；
 *   3. **入队**：本身有 5 秒上限（见 `source-queue.ts`），
 *      不会因为 Redis 黑洞让整轮扫描卡死。
 *
 * 少任何一层，一个坏来源就能让整个采集系统停摆。
 */

import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { serializeError, type Logger } from '@signal/logger';
import { DUE_SOURCES_BATCH_SIZE } from '@signal/source-core';
import { COLLECTOR_CONFIG, type CollectorConfig } from './collector.config';
import { CLOCK, type Clock } from './clock';
import { WORKER_LOGGER } from './logger';
import {
  SOURCE_FETCH_QUEUE,
  SOURCE_LOCK,
  SOURCE_REPOSITORY,
  sourceFetchLockKey,
  type CollectorSourceRepository,
  type SourceFetchQueue,
  type SourceLock,
} from './ports';
import { SCHEDULER_LOCK_TTL_MS } from './source-lock';

/** 一轮扫描里同时处理多少个来源（只影响入队速度，不影响采集并发）。 */
export const SCHEDULER_ENQUEUE_CONCURRENCY = 5;

/** 一轮扫描的结果，供测试直接断言。 */
export type SchedulerTickResult = {
  due: number;
  enqueued: number;
  /** 因为锁被占用而没入队的（同一来源另有任务在跑）。 */
  locked: number;
  /** 入队失败的。 */
  failed: number;
};

@Injectable()
export class SourceScheduler implements OnApplicationBootstrap, OnModuleDestroy {
  private timer: NodeJS.Timeout | null = null;

  /** 防止上一轮还没跑完就叠加下一轮（慢库 + 60s 间隔完全可能撞上）。 */
  private running = false;

  constructor(
    @Inject(COLLECTOR_CONFIG) private readonly config: CollectorConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(SOURCE_REPOSITORY) private readonly sources: CollectorSourceRepository,
    @Inject(SOURCE_FETCH_QUEUE) private readonly queue: SourceFetchQueue,
    @Inject(SOURCE_LOCK) private readonly lock: SourceLock,
    @Inject(WORKER_LOGGER) private readonly logger: Logger,
  ) {}

  onApplicationBootstrap(): void {
    this.start();
  }

  /** 启动定时扫描。重复调用是幂等的。 */
  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.config.schedulerIntervalMs);
    this.logger.info({ intervalMs: this.config.schedulerIntervalMs }, 'source scheduler started');
  }

  stop(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  onModuleDestroy(): void {
    this.stop();
  }

  /**
   * 跑一轮。定时器与测试都调它。
   *
   * 整个函数**永不抛**：一轮扫描失败只该记录，不该让定时器回调抛出
   * 未捕获异常（那会直接结束 Node 进程）。
   */
  async tick(): Promise<SchedulerTickResult> {
    const empty: SchedulerTickResult = { due: 0, enqueued: 0, locked: 0, failed: 0 };
    if (this.running) {
      this.logger.warn('source scheduler tick skipped: the previous tick is still running');
      return empty;
    }
    this.running = true;

    try {
      const now = this.clock.now();
      // 过滤与排序来自 `@signal/source-core` —— 与 Source Registry 共用的唯一一份。
      const due = await this.sources.findDueSources(now, DUE_SOURCES_BATCH_SIZE);
      if (due.length === 0) return empty;

      const result: SchedulerTickResult = { ...empty, due: due.length };

      for (let start = 0; start < due.length; start += SCHEDULER_ENQUEUE_CONCURRENCY) {
        const batch = due.slice(start, start + SCHEDULER_ENQUEUE_CONCURRENCY);
        const outcomes = await Promise.all(batch.map((source) => this.enqueueOne(source.id, now)));
        for (const outcome of outcomes) {
          result[outcome] += 1;
        }
      }

      this.logger.info({ ...result }, 'source scheduler tick finished');
      return result;
    } catch (error) {
      // 整轮失败（通常是 MySQL 不可用）。跳过这一分钟，下一轮继续。
      this.logger.error({ err: serializeError(error) }, 'source scheduler tick failed');
      return empty;
    } finally {
      this.running = false;
    }
  }

  /**
   * 把一个到期来源入队。
   *
   * 锁只覆盖**入队**这一瞬间，随即释放：任务真正执行时会自己再取同一把锁
   * （见 `source-lock.ts`）。这里取锁的目的是防止两个 worker 实例
   * 在同一分钟里对同一来源各入一次队 —— JobId 幂等也能挡住，
   * 但那是 BullMQ 层的兜底，`docs/06` 明确要求的是这一把锁。
   */
  private async enqueueOne(sourceId: string, at: Date): Promise<'enqueued' | 'locked' | 'failed'> {
    const lockKey = sourceFetchLockKey(sourceId);
    let token: string | null;
    try {
      token = await this.lock.acquire(lockKey, SCHEDULER_LOCK_TTL_MS);
    } catch (error) {
      this.logger.error(
        { sourceId, err: serializeError(error) },
        'source scheduler could not acquire the lock',
      );
      return 'failed';
    }
    if (token === null) return 'locked';

    try {
      await this.queue.enqueue(
        { sourceId, trigger: 'schedule', requestedAt: at.toISOString() },
        at,
      );
      return 'enqueued';
    } catch (error) {
      // 单个来源失败不影响同批其它来源 —— 这是「失败隔离」在调度侧的一半。
      this.logger.error(
        { sourceId, err: serializeError(error) },
        'source scheduler failed to enqueue a due source',
      );
      return 'failed';
    } finally {
      await this.lock.release(lockKey, token);
    }
  }
}
