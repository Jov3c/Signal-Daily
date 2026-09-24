/**
 * Redis 连接参数的解析。
 *
 * ── 为什么不在 module 里直接 `new URL()` ─────────────────────────────
 * `REDIS_URL` 是 `docs/20` 里的一条**连接串**，而 BullMQ 的 `connection`
 * 要的是 `{ host, port, username?, password?, db?, tls? }`。
 * 这个转换有三个容易漏的点，值得单独一个函数 + 单独一组测试：
 *
 * 1. **空端口**：`redis://localhost` 的 `URL.port` 是空串，`Number('')` 是 `0`，
 *    直接透传会让 BullMQ 连 0 端口。必须回退到 6379。
 * 2. **空用户名/密码**：`URL.username` 空串时不能传 `''`（会被当成一个真实用户）。
 * 3. **`rediss://`**：协议本身表达了 TLS，不显式传 `tls` 就会明文连 6380。
 *
 * ⚠ 与 Agent 03 在 `apps/api/src/modules/sources/source-enqueuer.ts` 里的
 * `redisConnectionOptions()` 是**同一件事的两份实现** —— `apps/api` 不在
 * worker 的 tsconfig 引用图里，跨 app import 会把整个 api 源码树拖进 worker 构建。
 * 已与另外两处 worker 侧重复一起记入 CCR 第 2 项，建议 Agent 14 提到共享包。
 */

import type { ConnectionOptions } from 'bullmq';

/** 注入 token。 */
export const AI_QUEUE_CONNECTION = 'AI_QUEUE_CONNECTION';

/** Redis 默认端口。 */
const DEFAULT_REDIS_PORT = 6379;

/** 把 `redis://` / `rediss://` 连接串解析成 BullMQ 的连接参数。 */
export function parseRedisConnection(redisUrl: string): ConnectionOptions {
  const parsed = new URL(redisUrl);

  const port = parsed.port === '' ? DEFAULT_REDIS_PORT : Number(parsed.port);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new Error(`Invalid Redis port in REDIS_URL: ${parsed.port}`);
  }

  const database = parsed.pathname.replace(/^\//, '');

  return {
    host: parsed.hostname,
    port,
    ...(parsed.username === '' ? {} : { username: decodeURIComponent(parsed.username) }),
    ...(parsed.password === '' ? {} : { password: decodeURIComponent(parsed.password) }),
    ...(database === '' ? {} : { db: Number(database) }),
    // `rediss://` 表示 TLS —— 不显式声明就会明文连接。
    ...(parsed.protocol === 'rediss:' ? { tls: {} } : {}),
  };
}
