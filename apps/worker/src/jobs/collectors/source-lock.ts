/**
 * `docs/06` 的 Redis 分布式锁：`source-fetch:{sourceId}`。
 *
 * ── 它保护的是什么（这是必须说清楚的一点）────────────────────────────
 * `raw_items` 上**没有** `(source_id, external_id)` 或 `canonical_url_hash`
 * 的唯一约束（Agent 01 建的是普通索引）。因此 `docs/06` 的幂等只能靠
 * 「先查后写」实现，而「先查后写」在并发下必然双写。
 *
 * 这把锁就是让「先查后写」成为安全操作的那个前提：
 * **同一个来源在同一时刻最多只有一个采集任务在写库。**
 * 没有它，管理员点两次「立即抓取」就可能对同一批条目插入两遍。
 *
 * 因此：**不要在没有持锁的情况下调用 RawItem 仓储。**
 *
 * ── 两个使用者，同一把锁 ────────────────────────────────────────────
 *   1. **调度器**：枚举到期来源时先占锁，避免两个 worker 实例同时把它入队；
 *   2. **采集任务执行期间**：占锁覆盖整个「取数 → 去重 → 写库」过程，
 *      防止「定时抓取」与「管理员手动抓取」对同一来源并发。
 *
 * ── 拿不到锁时**跳过**，不等待、不重试 ──────────────────────────────
 * 拿不到锁意味着「同一来源已经有人在抓了」，那一轮的结果本来就会是新鲜的。
 * 等待会把 worker 的并发额度占住（`docs/13`：并发 5），
 * 重试则会烧掉 BullMQ 的 3 次尝试却仍可能拿不到 —— 两者都比跳过差。
 * 跳过会被记进日志与 `JobRun.metadata`，不会静默。
 *
 * ── 释放必须比对 token ──────────────────────────────────────────────
 * 「先 GET 再 DEL」在两步之间锁可能已过期并被别人拿到，于是会删掉
 * **别人的**锁。所以用 Lua 脚本做原子的 compare-and-delete ——
 * 这是 Redis 分布式锁的标准做法，也是唯一正确的做法。
 *
 * ── ⚠ 一个被集成测试抓出来的真缺陷（务必保留这条注释）───────────────
 * 最初的 `createLockRedis` 设了 `enableOfflineQueue: false`，
 * 意图是「Redis 不可用时立刻失败」。但 ioredis 的连接是**异步**建立的，
 * 于是**每一个刚构造出来的锁客户端，第一次命令都会直接抛**
 * `Stream isn't writeable and enableOfflineQueue options is false` ——
 * 与 Redis 是否可用毫无关系。生产里的症状会是
 * 「worker 起来后什么都采不到，日志里全是锁获取失败」，
 * 而 Redis 明明好好的。
 *
 * 现在改为：**允许离线队列**（让首次连接期间的命令能排上队）
 * + **每次锁操作有硬超时**（把「Redis 真的挂了」这种情况限定在
 * `LOCK_COMMAND_TIMEOUT_MS` 内失败，而不是无限等待 → worker 卡住）。
 * 两个失败模式各自被一个机制覆盖，而不是用一个开关去赌。
 */

import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { serializeError, type Logger } from '@signal/logger';
import { WORKER_LOGGER } from './logger';
import type { SourceLock } from './ports';
import { createLockRedis } from './redis';
import { COLLECTOR_CONFIG, type CollectorConfig } from './collector.config';

/** 注入 token。 */
export const LOCK_REDIS = 'COLLECTOR_LOCK_REDIS';

/**
 * 单次锁操作的硬超时。
 *
 * 上限必须**远小于**调度间隔（60s），否则一轮调度会被一个卡住的
 * `SET` 拖死；也要小于一次采集的超时预算，否则锁获取本身成了瓶颈。
 * 3 秒对「本机/内网 Redis」是极宽松的值（正常在 1ms 量级）。
 */
export const LOCK_COMMAND_TIMEOUT_MS = 3_000;

/** 只删自己持有的锁。 */
const RELEASE_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
end
return 0
`;

@Injectable()
export class RedisSourceLock implements SourceLock, OnModuleDestroy {
  private readonly client: Redis;

  // ⚠ 显式 @Inject：不要依赖 emitDecoratorMetadata
  // （见 Agent 02 的 `di-wiring.spec.ts`：类型 import 被转成 `import type`
  //  之后，tsc 产物里的 `design:paramtypes` 会退化成 `[Function]`，
  //  而测试用的另一套 transform 会掩盖这个差异）。
  constructor(
    @Inject(COLLECTOR_CONFIG) private readonly config: CollectorConfig,
    @Inject(WORKER_LOGGER) private readonly logger: Logger,
  ) {
    this.client = createLockRedis(config.redisUrl);
    // ioredis 会把连接错误作为 'error' 事件抛出；不监听的话 Node 会
    // 因为未处理的 'error' 事件直接结束进程。
    this.client.on('error', (error: unknown) => {
      this.logger.warn({ err: serializeError(error) }, 'collector lock redis error');
    });
  }

  /**
   * 取锁。拿到返回 token；已被占用返回 null；Redis 不可用时**抛错**。
   *
   * 抛错是刻意的（不做「拿不到就当作拿到了」的降级）—— 那等于关掉并发保护，
   * 让「先查后写」的幂等重新暴露在并发双写下。
   * 调用方：调度器跳过本轮（下一分钟还有机会），采集任务记可重试的失败。
   */
  async acquire(key: string, ttlMs: number): Promise<string | null> {
    const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const result = await withTimeout(
      this.client.set(key, token, 'PX', ttlMs, 'NX'),
      LOCK_COMMAND_TIMEOUT_MS,
      `lock acquire timed out after ${LOCK_COMMAND_TIMEOUT_MS}ms`,
    );
    return result === 'OK' ? token : null;
  }

  async release(key: string, token: string): Promise<void> {
    try {
      await withTimeout(
        this.client.eval(RELEASE_SCRIPT, 1, key, token),
        LOCK_COMMAND_TIMEOUT_MS,
        `lock release timed out after ${LOCK_COMMAND_TIMEOUT_MS}ms`,
      );
    } catch (error) {
      // 释放失败只可能是 Redis 抖动或锁已过期 —— 两者都会由 TTL 兜底，
      // 不该让已经成功的采集变成失败。
      this.logger.warn({ err: serializeError(error) }, 'failed to release collector lock');
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.quit().catch(() => undefined);
  }
}

/**
 * 采集任务的持锁时长。
 *
 * 必须**严格大于**一次采集可能花掉的最长时间，否则锁会在任务还在跑时过期，
 * 后来者拿到锁 → 两个任务同时写库 → 幂等失效（正是这把锁要防的事）。
 *
 * 一次采集最坏情况 = **1 次列表请求 + ceil(N / 并发) 批子请求**，
 * 每个都可能吃满超时预算（超时是整条重定向链共享的一个 deadline，
 * 所以一次 `getText` 最多花 `timeoutMs`）。
 * HN：`1 + ceil(30 / 5) = 7` 次；再加上各适配器可能的重定向链。
 * 因此给上界 `超时预算 × 8 + 30 秒` → `docs/20` 默认值（10s）下 110 秒，
 * 对最坏的 70 秒有余量。
 *
 * ⚠ 这个余量是**人工算术**，不是运行期保证。前提是「没有适配器会发出
 * 超过 8 次顺序请求」—— 给 HN 加一页、或加一个需要多次往返的适配器
 * 都可能打破它。`collectors-queue.integration.spec.ts` 里有一条不变量测试
 * 把「最坏请求数 × 超时 ≤ TTL」钉住，改动窗口常量时它会报警。
 */
export function collectorLockTtlMs(timeoutMs: number): number {
  return timeoutMs * 8 + 30_000;
}

/** 调度器入队时的短暂占锁时长（只为「别重复入队」，不覆盖执行）。 */
export const SCHEDULER_LOCK_TTL_MS = 30_000;

/**
 * 给 promise 加等待上限。
 *
 * 超时后原 promise 仍在后台跑 —— 对 `SET NX` 与 compare-and-delete 都是
 * 安全的：前者最多让一个锁晚一点过期（有 TTL 兜底），后者至多删掉一把
 * 本来就该删的锁。**不会**出现「以为没拿到，其实拿到了」造成的双写，
 * 因为双写需要两个任务同时进入「先查后写」，而拿到锁的那个会正常执行。
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
