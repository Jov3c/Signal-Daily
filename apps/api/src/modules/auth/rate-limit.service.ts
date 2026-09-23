/**
 * 限流判定。
 *
 * 只做一件事：把 `RateLimiter` 的结果翻译成 `AppError`。
 * 复用平台错误码 `RATE_LIMITED`（429），**不新造 `AUTH_RATE_LIMITED`** ——
 * `docs/05` 明令禁止同义错误码。
 */

import { Inject, Injectable } from '@nestjs/common';
import { AppError, PlatformErrorCode } from '@signal/contracts';
import {
  RATE_LIMITER,
  rateLimitKey,
  rateLimitSubject,
  type RateLimitPolicy,
  type RateLimiter,
} from './rate-limiter';

@Injectable()
export class RateLimitService {
  constructor(@Inject(RATE_LIMITER) private readonly limiter: RateLimiter) {}

  /**
   * 消费一次配额，超限抛 429。
   *
   * @param scope   限流维度，如 `otp:request:email`
   * @param subject 标识明文（邮箱 / IP / userId）—— 内部会哈希后再进 key
   */
  async enforce(scope: string, subject: string, policy: RateLimitPolicy): Promise<void> {
    const result = await this.limiter.consume(
      rateLimitKey(scope, rateLimitSubject(subject)),
      policy,
    );
    if (result.allowed) return;

    throw new AppError({
      code: PlatformErrorCode.RATE_LIMITED,
      httpStatus: 429,
      safeMessage: 'Too many requests',
      details: {
        retryAfterSeconds: Math.max(1, Math.ceil((result.resetAt.getTime() - Date.now()) / 1000)),
      },
    });
  }
}
