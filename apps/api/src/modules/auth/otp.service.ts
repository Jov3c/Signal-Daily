/**
 * Email OTP 的生成与校验。
 *
 * 契约（`docs/11`）：6 位、10 分钟、**hash 存储**、防重放。
 *
 * 关键设计：
 *   1. `codeHash` 绑定了**邮箱**与一个固定 pepper：
 *      `HMAC-SHA256(EMAIL_OTP_PEPPER, "signal:otp:v1:<email>:<code>")`。
 *      绑邮箱的意义是：同一个 6 位码在 A 邮箱请求、到 B 邮箱提交，哈希对不上。
 *      用 HMAC 而不是裸 SHA-256：数据库泄露时，攻击者无法用彩虹表反推 6 位码
 *      （6 位只有 100 万种，裸 SHA-256 秒破）。
 *   2. 校验用**恒定时间比较**。
 *   3. 消费走条件更新，保证并发下只有一个请求能消费成功。
 *   4. 请求新码时作废旧码 —— 同一时刻只有一个有效码，缩小爆破窗口。
 */

import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { AppError, DomainErrorCode } from '@signal/contracts';
import { AUTH_CONFIG, type AuthConfig } from './auth.config';
import { OTP_LENGTH, OTP_PURPOSE, OTP_TTL_SECONDS } from './auth.constants';
import { CLOCK, type Clock } from './clock';
import { AUTH_REPOSITORY, type AuthRepository } from './repository';

/** 注入 token：测试注入固定码生成器，让用例可断言具体数字。 */
export const OTP_CODE_GENERATOR = 'OTP_CODE_GENERATOR';

/** 生成 6 位数字验证码。 */
export type OtpCodeGenerator = () => string;

/** 默认生成器：`crypto.randomInt` 是 CSPRNG，不是 `Math.random`。 */
export const defaultOtpCodeGenerator: OtpCodeGenerator = () =>
  randomInt(0, 10 ** OTP_LENGTH)
    .toString()
    .padStart(OTP_LENGTH, '0');

/** 邮箱归一化：登录标识不区分大小写，避免 `A@x.com` 与 `a@x.com` 建出两个用户。 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

@Injectable()
export class OtpService {
  constructor(
    @Inject(AUTH_REPOSITORY) private readonly repository: AuthRepository,
    @Inject(AUTH_CONFIG) private readonly config: AuthConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(OTP_CODE_GENERATOR) private readonly generateCode: OtpCodeGenerator,
  ) {}

  /**
   * 生成并存储新验证码，返回**明文**给调用方投递。
   *
   * ⚠ 明文不落库、不写日志，只应进入邮件正文。
   * 调用方（`AuthService`）必须把 `code` 直接交给 `MailSender`，不要放进日志字段。
   */
  async issue(
    email: string,
    requestIpHash: string | null,
  ): Promise<{ code: string; expiresInSeconds: number }> {
    const normalized = normalizeEmail(email);
    const code = this.generateCode();
    const now = this.clock.now();
    const expiresAt = new Date(now.getTime() + OTP_TTL_SECONDS * 1000);

    await this.repository.replaceActiveOtp(
      {
        email: normalized,
        codeHash: this.hashCode(normalized, code),
        expiresAt,
        requestIpHash,
      },
      now,
    );

    return { code, expiresInSeconds: OTP_TTL_SECONDS };
  }

  /**
   * 校验验证码并在成功时消费它。失败按原因抛不同错误码：
   *   - `AUTH_OTP_EXPIRED`       —— 有效码但已过期
   *   - `AUTH_OTP_ALREADY_USED`  —— 最近刚被消费过（重放）
   *   - `AUTH_OTP_INVALID`       —— 其余（没有码、码不对）
   */
  async verifyAndConsume(email: string, code: string): Promise<void> {
    const normalized = normalizeEmail(email);
    const now = this.clock.now();

    const record = await this.repository.findLatestUnconsumedOtp(normalized);
    if (record === null) {
      // 没有未消费的码：可能是「从未请求」，也可能是「已经用过」。
      // 只有确实在有效期内被消费过，才算重放。
      const consumed = await this.repository.findRecentlyConsumedOtp(
        normalized,
        new Date(now.getTime() - OTP_TTL_SECONDS * 1000),
      );
      if (consumed !== null) {
        throw new AppError({
          code: DomainErrorCode.AUTH_OTP_ALREADY_USED,
          httpStatus: 401,
          safeMessage: 'This code has already been used',
        });
      }
      throw new AppError({
        code: DomainErrorCode.AUTH_OTP_INVALID,
        httpStatus: 401,
        safeMessage: 'Invalid verification code',
      });
    }

    if (record.expiresAt.getTime() <= now.getTime()) {
      // 过期码顺手消费掉，避免它一直占着「最新未消费」的位置挡住后续请求。
      await this.repository.consumeOtp(record.id, now);
      throw new AppError({
        code: DomainErrorCode.AUTH_OTP_EXPIRED,
        httpStatus: 401,
        safeMessage: 'This code has expired',
      });
    }

    if (!this.matchesHash(normalized, code, record.codeHash)) {
      throw new AppError({
        code: DomainErrorCode.AUTH_OTP_INVALID,
        httpStatus: 401,
        safeMessage: 'Invalid verification code',
      });
    }

    // 条件消费：并发提交同一个码时只有一个能成功，另一个按重放处理。
    const consumed = await this.repository.consumeOtp(record.id, now);
    if (!consumed) {
      throw new AppError({
        code: DomainErrorCode.AUTH_OTP_ALREADY_USED,
        httpStatus: 401,
        safeMessage: 'This code has already been used',
      });
    }
  }

  /** 计算验证码哈希。 */
  hashCode(email: string, code: string): string {
    return createHmac('sha256', this.config.emailOtpPepper)
      .update(`${OTP_PURPOSE}:${email}:${code}`)
      .digest('hex');
  }

  private matchesHash(email: string, code: string, expectedHash: string): boolean {
    const actual = Buffer.from(this.hashCode(email, code), 'utf8');
    const expected = Buffer.from(expectedHash, 'utf8');
    if (actual.length !== expected.length) return false;
    return timingSafeEqual(actual, expected);
  }
}
