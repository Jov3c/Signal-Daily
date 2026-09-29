/**
 * Redis 连接参数的解析。
 *
 * ⚠ 与 Agent 03（`apps/api/src/modules/sources/source-enqueuer.ts`）、
 * Agent 06（`jobs/ai/connection.ts`）是**同一件事的第三份实现**。
 * 已与其它 worker 侧重复一起记入 CCR。
 *
 * 三个容易漏的点（都不是风格问题）：
 * 1. **空端口**：`redis://localhost` 的 `URL.port` 是空串，`Number('')` 是 `0`，
 *    直接透传会让 BullMQ 连 0 端口 → 必须回退 6379；
 * 2. **空用户名/密码**：空串不能传（会被当成一个真实用户）；
 * 3. **`rediss://`**：协议本身表达了 TLS，不显式传 `tls` 就会明文连接。
 */

import type { ConnectionOptions } from 'bullmq';

/** 注入 token。 */
export const CONTENT_QUEUE_CONNECTION = 'CONTENT_QUEUE_CONNECTION';

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
    ...(parsed.protocol === 'rediss:' ? { tls: {} } : {}),
  };
}
