/**
 * RateLimiter 端口 + 内存实现。
 *
 * `docs/14` 要求 OTP request / OTP verify / auth refresh 由 Redis 控制。
 * 生产绑定是 `RedisRateLimiter`；本文件的内存实现用于：
 *   - 单元测试（无需 Redis）；
 *   - 显式注入的自定义部署形态。
 *
 * ⚠ 内存实现**不是**默认生产绑定：多实例部署下每个进程各自计数，限流失效。
 */

import { createHash } from 'node:crypto';

/** 注入 token。 */
export const RATE_LIMITER = 'RATE_LIMITER';

export type RateLimitPolicy = {
  /** 窗口内允许的次数。 */
  limit: number;
  /** 窗口长度（秒）。 */
  windowSeconds: number;
};

export type RateLimitResult = {
  allowed: boolean;
  /** 本窗口剩余次数（耗尽后为 0）。 */
  remaining: number;
  /** 窗口重置时刻。 */
  resetAt: Date;
};

export interface RateLimiter {
  /**
   * 记一次消费并返回判定结果。
   *
   * 约定：**必须 fail-closed** —— 计数器不可用时抛异常，绝不静默放行。
   * 静默放行等于在故障期间关掉暴力破解防护。
   */
  consume(key: string, policy: RateLimitPolicy): Promise<RateLimitResult>;
}

/**
 * 把标识（邮箱、IP、userId）转成限流 key 的一段。
 *
 * 刻意哈希：`docs/11` 要求不建立用户画像，Redis 里也不该堆积明文邮箱与 IP。
 * 这里不加 pepper —— 限流 key 不是凭据，不需要抗暴力枚举；
 * 用固定前缀 + 定长摘要即可，同时避免不同用途的 key 互相碰撞。
 */
export function rateLimitSubject(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 32);
}

/** 拼 key，统一命名空间，避免与 Agent 04–08 的限流键撞车。 */
export function rateLimitKey(scope: string, subject: string): string {
  return `ratelimit:auth:${scope}:${subject}`;
}

/** 仅供测试与单进程使用。 */
export class InMemoryRateLimiter implements RateLimiter {
  private readonly buckets = new Map<string, { count: number; resetAtMs: number }>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  async consume(key: string, policy: RateLimitPolicy): Promise<RateLimitResult> {
    const nowMs = this.now().getTime();
    const windowMs = policy.windowSeconds * 1000;

    const existing = this.buckets.get(key);
    const bucket =
      existing === undefined || existing.resetAtMs <= nowMs
        ? { count: 0, resetAtMs: nowMs + windowMs }
        : existing;

    bucket.count += 1;
    this.buckets.set(key, bucket);

    return {
      allowed: bucket.count <= policy.limit,
      remaining: Math.max(0, policy.limit - bucket.count),
      resetAt: new Date(bucket.resetAtMs),
    };
  }

  /** 清空（测试用）。 */
  reset(): void {
    this.buckets.clear();
  }
}
