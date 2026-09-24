/**
 * Redis 连接参数推导。
 *
 * BullMQ 的 `connection` 直接吃 ioredis 的 options，**不接受 `url` 字段**，
 * 所以必须手工拆一次 URL。
 *
 * ── 两个不能省的细节 ────────────────────────────────────────────────
 * **① `maxRetriesPerRequest: null` 是 BullMQ 的硬要求。**
 * 它阻塞式地读队列，ioredis 的默认重试次数会在网络抖动时把阻塞命令
 * 打断，Worker 侧会抛「max retries per request」。
 *
 * **② `rediss:` 必须带 `tls: {}`。**
 * 生产（Agent 11）如果用带 TLS 的托管 Redis，漏掉这一项的表现是
 * 「连上了但立刻断」或「一直握手失败」，而错误信息不会提到 TLS ——
 * 排查方向会被带偏到网络与 ACL 上。
 *
 * ── 为什么先拆成一个中间结构 ────────────────────────────────────────
 * 两个消费者要**不同**的选项对象：BullMQ 要 `maxRetriesPerRequest: null`
 * 且自带连接池语义；分布式锁要「快速失败」（见 `createLockRedis`）。
 * 把 URL 解析抽成 `parseRedisUrl()` 让两边共用同一份解析逻辑，
 * 而各自组装自己的选项 —— 这样「`rediss:` 要带 tls」这类规则
 * 只可能写错一次。
 */

import type { ConnectionOptions } from 'bullmq';
import { Redis, type RedisOptions } from 'ioredis';

/** Redis 默认端口。 */
const DEFAULT_REDIS_PORT = 6379;

type RedisTarget = {
  host: string;
  port: number;
  username: string | null;
  password: string | null;
  db: number | null;
  tls: boolean;
};

function parseRedisUrl(redisUrl: string): RedisTarget {
  const url = new URL(redisUrl);
  const db = url.pathname.replace(/^\//, '');
  return {
    host: url.hostname,
    port: url.port === '' ? DEFAULT_REDIS_PORT : Number(url.port),
    username: url.username === '' ? null : decodeURIComponent(url.username),
    password: url.password === '' ? null : decodeURIComponent(url.password),
    db: db === '' ? null : Number(db),
    tls: url.protocol === 'rediss:',
  };
}

/** BullMQ 的 `Queue` / `Worker` 用的连接参数。 */
export function redisConnectionOptions(redisUrl: string): ConnectionOptions {
  const target = parseRedisUrl(redisUrl);
  const options: ConnectionOptions = {
    host: target.host,
    port: target.port,
    maxRetriesPerRequest: null,
  };
  if (target.username !== null) options.username = target.username;
  if (target.password !== null) options.password = target.password;
  if (target.db !== null) options.db = target.db;
  if (target.tls) options.tls = {};
  return options;
}

/**
 * 供分布式锁使用的 ioredis 客户端。
 *
 * ⚠ 与 BullMQ 的连接**分开**：BullMQ 会按自己的需要配置连接
 * （阻塞式命令、`maxRetriesPerRequest: null`），而锁需要的是
 * 「失败要快」。两种诉求不该共用一个连接。
 *
 * ── ⚠⚠ 被集成测试抓出来的真缺陷：不要设 `enableOfflineQueue: false` ──
 * 最初的实现设了它，意图是「Redis 不可用时立刻失败」。但 ioredis 的连接是
 * **异步**建立的，于是**每一个刚构造出来的锁客户端，第一次命令都会直接抛**
 * `Stream isn't writeable and enableOfflineQueue options is false` ——
 * 与 Redis 到底可不可用毫无关系。
 *
 * 生产里的症状会是「worker 起来后什么都采不到，日志里全是锁获取失败」，
 * 而 Redis 明明好好的、监控也全绿。这正是最费时间的一类故障。
 *
 * 现在改用两个**各自针对一种失败模式**的机制，而不是拿一个开关去赌：
 *   - **允许离线队列**（默认行为）→ 首次连接期间的命令能排上队，正常场景可用；
 *   - **每次锁操作有硬超时**（`source-lock.ts` 的 `LOCK_COMMAND_TIMEOUT_MS`）
 *     → Redis 真的挂了时，操作在有界时间内失败，而不是无限等待导致 worker 卡住。
 *
 * `retryStrategy` 用**有上限的退避**而不是放弃：Redis 重启之后必须能自愈，
 * 否则一个跑了几周的 worker 会在 Redis 抖动一次之后永久失去锁能力。
 */
export function createLockRedis(redisUrl: string): Redis {
  const target = parseRedisUrl(redisUrl);
  const options: RedisOptions = {
    host: target.host,
    port: target.port,
    // 单条命令的重试次数：连上之后 Redis 抖动时快速失败，
    // 而不是把请求一直挂着（锁操作的硬超时是第二层保险）。
    maxRetriesPerRequest: 2,
    // 有上限的重连退避（最长 2 秒），无限重试 —— 保证 Redis 恢复后能自愈。
    // 刻意不用 `null`（放弃重连）：那会让一次抖动变成永久故障。
    retryStrategy: (times: number) => Math.min(times * 200, 2_000),
  };
  if (target.username !== null) options.username = target.username;
  if (target.password !== null) options.password = target.password;
  if (target.db !== null) options.db = target.db;
  if (target.tls) options.tls = {};
  return new Redis(options);
}
