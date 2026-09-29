/**
 * `PublishingEnqueuer` 的 BullMQ 实现。
 *
 * ── 关于 Redis 连接参数的解析 ────────────────────────────────────────
 * **不再写第 4 份** `parseRedisConnection`。Agent 06 把它放在了
 * `jobs/ai/index.ts` 的公开面上（`export { parseRedisConnection } from './connection'`），
 * 因此这里直接 `import { parseRedisConnection } from '../ai'` ——
 * 那是**跨模块走公开面**，不是深入内部（Agent 05 也这么用）。
 *
 * 这一条与 PrismaService 的重复（只能各留一份）不同：
 * `parseRedisConnection` 是**纯函数**，没有生命周期、没有连接，
 * 所以把它的唯一实现放在一个公开面上是正确且零代价的。
 */

import { Inject, Injectable } from '@nestjs/common';
import { parseRedisConnection } from '../ai';
import { PUBLISHING_JOB_OPTIONS, type PublishingJobData } from './queue';
import type { PublishingEnqueuer } from './scheduler';

/** 注入 token：入队用的 BullMQ `Queue`。 */
export const PUBLISHING_QUEUE = 'PUBLISHING_QUEUE';

/** 注入 token：Redis 连接参数。 */
export const PUBLISHING_QUEUE_CONNECTION = 'PUBLISHING_QUEUE_CONNECTION';

/**
 * `REDIS_URL` → BullMQ 连接参数。
 *
 * 只是给 `parseRedisConnection` 起一个本模块可读的名字（并让调用点
 * 不必直接 import `../ai` 的实现细节）。**不做任何额外处理** ——
 * 尤其不要「顺手」补上默认端口之类：那些坑 Agent 06 已经在唯一实现里处理过了
 *（空端口回退 6379、空用户名不传、`rediss:` 补 tls）。
 */
export function publishingConnectionOptions(redisUrl: string) {
  return parseRedisConnection(redisUrl);
}

/**
 * BullMQ `Queue` 的**结构性最小类型**。
 *
 * ⚠ 为什么不用 `import { Queue } from 'bullmq'` 把它当类型标注：
 * `Queue` 在本文件里只出现在**类型位置**，于是
 * `@typescript-eslint/consistent-type-imports` 会要求改成 `import type`。
 * 而 `emitDecoratorMetadata` 会把构造函数参数的类型写进装饰器元数据 ——
 * 一旦变成 `import type`，元数据里那一项会退化成 `Object`。
 * 本文件用了**显式 `@Inject(PUBLISHING_QUEUE)`**，所以 Nest 不依赖那份元数据、
 * 改掉也不会当场坏 —— 但「今天不坏」不等于「明天不坏」：
 * 后人删掉 `@Inject` 时会踩到一个静默失败的 DI。
 *（Agent 07 的自查记录里正是「为了让 lint 过把运行时值改成 import type
 *  → 7 条测试全红」。）
 *
 * 用结构性类型同时解决三件事：lint 无争议、元数据不含第三方类、
 * 单元测试可以直接传一个记录调用的替身而不需要 Redis。
 */
export type QueueLike = {
  add(name: string, data: unknown, options: object): Promise<unknown>;
};

@Injectable()
export class BullPublishingEnqueuer implements PublishingEnqueuer {
  constructor(@Inject(PUBLISHING_QUEUE) private readonly queue: QueueLike) {}

  async add(jobName: string, data: PublishingJobData, jobId: string): Promise<void> {
    await this.queue.add(jobName, data, {
      ...PUBLISHING_JOB_OPTIONS,
      // 重复的 jobId 会让 BullMQ 直接返回已有的 job、不再执行 ——
      // 这正是我们依赖的幂等（见 `scheduler.ts` 文件头的第 2 层）。
      jobId,
    });
  }
}
