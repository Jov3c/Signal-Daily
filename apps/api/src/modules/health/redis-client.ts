/**
 * readiness 探针用的 Redis 连接。
 *
 * ── ⚠ 这里的参数与 Agent 02 的 `createRedisClient` **有意不同** ──────
 * 两者要的东西相反，所以不是重复实现：
 *
 * | 参数                    | Agent 02 的限流器        | 这里                |
 * | ----------------------- | ------------------------ | ------------------- |
 * | 用途                    | 限流（**fail-closed**）  | 探活（**fail-fast**）|
 * | `maxRetriesPerRequest`  | 2                        | **1**               |
 * | `connectTimeout`        | 默认（10s）              | **1000ms**          |
 *
 * 限流器宁可多试几次也不能误放行；探针则必须在**每一次** healthcheck 的
 * 预算内给出答案 —— 一次探活花 10 秒等于 docker 报 timeout，
 * 我们精心设计的 `reason: TIMEOUT` 反而到不了运维手里。
 */

import { Redis } from 'ioredis';
import type { FailureSink } from './probes';

/**
 * 创建探针用的连接。
 *
 * ── ⚠ `enableOfflineQueue` 必须是 **true**，这是个反直觉的坑 ────────
 * 直觉是「探针不该排队，连不上就立刻失败」，于是写 `false`。
 * 那在 `lazyConnect: true` 下是**错的**：`ioredis` 的 `sendCommand()`
 * 先看状态再决定可写性 ——
 *
 * ```js
 * if (this.status === 'wait') { this.connect().catch(noop); }   // 异步开始连
 * ...
 * let writable = this.status === 'ready' || ...                  // 此刻还是 'connecting'
 * if (!writable && !this.options.enableOfflineQueue) {
 *   command.reject(new Error("Stream isn't writeable and enableOfflineQueue options is false"));
 * }
 * ```
 *
 * `connect()` 是异步的，所以**第一次** `ping()` 执行到 `writable` 判定时
 * 连接状态一定是 `connecting` —— 于是 Redis 完全健康时，**第一个**探针
 * 也必然报 down。表现是「容器刚起来的那一次 healthcheck 是红的」，
 * 而重启一次就好了，极难复现。
 *
 * 所以：`enableOfflineQueue: true`（首个命令入队，连上即发）+
 * `maxRetriesPerRequest: 1` + `connectTimeout: 1000`（真的连不上时
 * 1 秒内给出错误，而不是排队到天荒地老）。
 * `health-db.integration.spec.ts` 有一条用例对**第一次** `ping()` 断言成功 ——
 * 把这里改回 `false`，它会红。
 *
 * @param onError 连接/命令错误的收口。ioredis 在**没有** `error` 监听器时
 *   会自己往 stderr 打 `[ioredis] Unhandled error event`，等于绕过
 *   `@signal/logger` —— 既不脱敏也不带 requestId。
 */
export function createHealthRedisClient(redisUrl: string, onError?: FailureSink): Redis {
  const client = new Redis(redisUrl, {
    // 不在模块构造期就要求 Redis 可用（单元测试不 override 这个 token 时也不会连）。
    lazyConnect: true,
    connectTimeout: 1000,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: true,
  });

  if (onError !== undefined) client.on('error', onError);
  return client;
}
