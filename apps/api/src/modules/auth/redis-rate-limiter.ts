/**
 * `RateLimiter` 的 Redis 实现（生产绑定）。
 *
 * 用 Lua 保证「自增 + 首次设 TTL」是原子的：
 *   如果分成 `INCR` 与 `EXPIRE` 两条命令，进程在两者之间挂掉就会留下
 *   **永不过期的计数器**，该用户从此永久被限流。这是 fixed-window 限流最经典的坑。
 *
 * 故障策略：**fail-closed**。Redis 不可用时 `consume()` 抛异常，
 * 请求以 500 结束，而不是「静默放行、限流消失」。
 */

import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { Redis } from 'ioredis';
import type { RateLimitPolicy, RateLimitResult, RateLimiter } from './rate-limiter';

/** 注入 token：便于测试注入假客户端。 */
export const REDIS_CLIENT = 'AUTH_REDIS_CLIENT';

/**
 * `KEYS[1]` 计数器；`ARGV[1]` 窗口毫秒数。
 * 返回 `{ 当前计数, 剩余毫秒 }`。
 */
const CONSUME_SCRIPT = `
local current = redis.call('INCR', KEYS[1])
if current == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then
  -- 极端情况下 key 存在但没有 TTL（例如被人手工 SET 过），补一个，避免永久限流。
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = ARGV[1]
end
return { current, ttl }
`;

/**
 * 创建指向 `REDIS_URL` 的连接。
 *
 * @param onError 连接/命令错误的收口回调。
 *   ⚠ ioredis 在**没有** `error` 监听器时会自己往 stderr 打
 *   `[ioredis] Unhandled error event` —— 那等于绕过 @signal/logger，
 *   既不脱敏也不带 requestId。所以生产装配（`AuthModule`）必须传一个
 *   logger 收口。连接失败时 `consume()` 依旧抛错，**fail-closed 不变**。
 */
export function createRedisClient(redisUrl: string, onError?: (error: Error) => void): Redis {
  const client = new Redis(redisUrl, {
    // 懒连接：不在模块构造期就要求 Redis 可用，便于「只跑单元测试」的场景。
    lazyConnect: true,
    maxRetriesPerRequest: 2,
    enableOfflineQueue: true,
  });

  if (onError !== undefined) client.on('error', onError);
  return client;
}

@Injectable()
export class RedisRateLimiter implements RateLimiter, OnModuleDestroy {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async consume(key: string, policy: RateLimitPolicy): Promise<RateLimitResult> {
    const windowMs = policy.windowSeconds * 1000;
    const raw = (await this.redis.eval(CONSUME_SCRIPT, 1, key, String(windowMs))) as [
      number,
      number,
    ];

    const count = Number(raw[0]);
    const ttlMs = Math.max(0, Number(raw[1]));

    return {
      allowed: count <= policy.limit,
      remaining: Math.max(0, policy.limit - count),
      resetAt: new Date(Date.now() + ttlMs),
    };
  }

  async onModuleDestroy(): Promise<void> {
    // ⚠ `quit()` 在**从未连上过**的连接上会先尝试建连再发 QUIT ——
    // 于是「Redis 不可达时关进程」会抛 ECONNREFUSED，**把关闭流程也弄失败**。
    //
    // 关连接必须是尽力的：它对业务结果毫无影响（进程都要退出了），
    // 却能决定 `app.close()` / `worker.close()` 是干净退出还是抛异常。
    // 仓库里另外两处（`public-read`、`health`）本来就写了 `.catch`，
    // 只有这里漏了 —— 集成时才现形（`apps/api/test/boot.spec.ts` 退出码非零）。
    await this.redis.quit().catch(() => undefined);
  }
}
