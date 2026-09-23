/**
 * Auth 仓储 —— `email_otp_codes` / `sessions` / `auth_accounts` 的唯一读写入口。
 *
 * 不碰 `users` 表：用户身份的创建与读取属于 `UserRepository`（Agent 02 的 users 模块）。
 * 这样两张表的写入语义各只有一处定义，不会出现「auth 建用户忘了建 preference」。
 */

import type { AuthenticatedSession } from '../../common/guards/ports';

/** 注入 token。 */
export const AUTH_REPOSITORY = 'AUTH_REPOSITORY';

/** 供下游引用同一份类型定义。 */
export type { AuthenticatedSession };

/* ------------------------------------------------------------------ */
/* OTP                                                                 */
/* ------------------------------------------------------------------ */

export type OtpRecord = {
  id: string;
  codeHash: string;
  expiresAt: Date;
};

export interface CreateOtpInput {
  email: string;
  codeHash: string;
  expiresAt: Date;
  requestIpHash: string | null;
}

/* ------------------------------------------------------------------ */
/* Session                                                             */
/* ------------------------------------------------------------------ */

export type SessionRecord = {
  id: string;
  userId: string;
  expiresAt: Date;
  revokedAt: Date | null;
};

export interface CreateSessionInput {
  userId: string;
  refreshTokenHash: string;
  expiresAt: Date;
  userAgentHash: string | null;
  ipHash: string | null;
}

/* ------------------------------------------------------------------ */
/* AuthAccount                                                         */
/* ------------------------------------------------------------------ */

export type AuthAccountRecord = {
  id: string;
  userId: string;
};

export interface AuthRepository {
  /**
   * 作废该邮箱所有未消费的验证码，并写入新的。
   *
   * 必须在一个事务里：否则并发两次 request-code 会留下两条可用验证码，
   * 「同一时刻只有一个有效码」的假设就被打破了。
   *
   * `now` 显式传入而不是实现里 `new Date()`：作废时间会参与
   * 「重放判定」的窗口比较，必须和其余时间来自同一个时钟。
   */
  replaceActiveOtp(input: CreateOtpInput, now: Date): Promise<void>;

  /** 取该邮箱最新一条「未消费」的验证码（不论是否过期，过期判定交给业务层）。 */
  findLatestUnconsumedOtp(email: string): Promise<OtpRecord | null>;

  /**
   * 取该邮箱最近被**消费过**的验证码。
   * 用于把「重放」与「码错误」区分开。
   */
  findRecentlyConsumedOtp(email: string, since: Date): Promise<OtpRecord | null>;

  /**
   * 原子消费验证码。返回是否由本次调用成功消费。
   *
   * 实现必须是「条件更新 + 影响行数判定」：两个并发请求同时提交同一个码时，
   * 只有一个能把 `consumed_at` 从 null 改成时间戳。
   */
  consumeOtp(id: string, consumedAt: Date): Promise<boolean>;

  /** 建 Session。 */
  createSession(input: CreateSessionInput): Promise<{ id: string }>;

  /** 按 refresh token 哈希找 Session（含已撤销的 —— 撤销状态要能区分出来）。 */
  findSessionByRefreshHash(refreshTokenHash: string): Promise<SessionRecord | null>;

  /**
   * 按会话 id 取认证主体（AuthGuard 用）。
   *
   * 一次查询同时拿到「会话是否有效」与「用户当前角色 / 状态」，
   * 因此登出、撤权、禁用立刻生效。已撤销的会话返回 `null`。
   */
  findAuthenticatedSession(sessionId: string): Promise<AuthenticatedSession | null>;

  /** 撤销单个 Session。返回是否真的发生了状态变化（幂等）。 */
  revokeSession(sessionId: string, revokedAt: Date): Promise<boolean>;

  /** 撤销该用户所有未撤销的 Session。返回撤销条数。用于 refresh 重放响应。 */
  revokeAllSessionsForUser(userId: string, revokedAt: Date): Promise<number>;

  /** 按 provider + 外部账号 id 找绑定。 */
  findAuthAccount(provider: string, providerAccountId: string): Promise<AuthAccountRecord | null>;

  /**
   * 绑定外部账号。
   *
   * 并发登录同一 GitHub 账号时可能同时插入 —— 依赖
   * `@@unique([provider, providerAccountId])` 让后来者失败返回 null，
   * 由调用方重新读取已存在的绑定。
   */
  linkAuthAccount(input: {
    userId: string;
    provider: string;
    providerAccountId: string;
  }): Promise<AuthAccountRecord | null>;
}
