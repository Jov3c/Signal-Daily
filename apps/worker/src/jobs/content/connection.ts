/**
 * Redis 连接参数 —— 本模块只保留自己的注入 token。
 *
 * ── 为什么这里不再有第二份 `parseRedisConnection` ──────────────────
 * 唯一实现留在 `jobs/ai/connection.ts`，并由 `jobs/ai/index.ts` 放上公开面。
 * 本文件从**公开面**复用（`import { parseRedisConnection } from '../ai'`），
 * 这与 `publishing/enqueuer.ts` 是同款做法 —— 那是跨模块走公开面，不是深入内部。
 *
 * 三个容易漏的点（空端口回退 6379 / 空用户名不传 / `rediss:` 补 tls）
 * 因此只有一处实现、一处测试，见 `jobs/ai/connection.ts`。
 *
 * ⚠ 这与 `PrismaService` 的重复**不能类比**：PrismaService 有生命周期与连接，
 * 各模块只能留一份；而 `parseRedisConnection` 是**纯函数**，
 * 把唯一实现放在一个公开面上是正确且零代价的。
 */

import { parseRedisConnection } from '../ai';

/** 注入 token。 */
export const CONTENT_QUEUE_CONNECTION = 'CONTENT_QUEUE_CONNECTION';

export { parseRedisConnection };
