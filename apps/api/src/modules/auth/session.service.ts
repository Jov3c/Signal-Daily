/**
 * Session 生命周期：签发、轮换、撤销。
 *
 * `docs/11`：Access Token 15min，Refresh Session 30d。
 *
 * ── 设计取舍（已记入 HANDOFF，下游必须知道） ──────────────────────────
 * **严格轮换（strict rotation）**：每次 refresh 都作废旧 Session 并新建一个。
 * 因此「用同一个 refresh token 并发刷新两次」会有一次被判定为**重放**，
 * 触发「撤销该用户全部 Session」。
 *
 * 这是 OAuth 对 refresh token 的推荐做法（把「同一个 token 用了两次」
 * 视为凭据泄露的信号），代价是**前端必须对刷新做 single-flight**。
 * 已显式记入 HANDOFF，提示 Agent 13 在 Web 端串行化刷新。
 */

import { createHmac, randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { AppError, DomainErrorCode, UserStatus, type UserRole } from '@signal/contracts';
import type { UserRepository } from '../users/user.repository';
import { USER_REPOSITORY } from '../users/user.repository';
import { AccessTokenService } from './access-token.service';
import { AUTH_CONFIG, type AuthConfig } from './auth.config';
import {
  ACCESS_TOKEN_TTL_SECONDS,
  REFRESH_SESSION_TTL_SECONDS,
  REFRESH_TOKEN_BYTES,
  REFRESH_TOKEN_PURPOSE,
} from './auth.constants';
import { CLOCK, type Clock } from './clock';
import { AUTH_REPOSITORY, type AuthRepository } from './repository';

/** 会话指纹（UA / IP 的哈希）入参。 */
export type SessionRequestMeta = {
  /** 原始 `User-Agent`，函数内部哈希后入库。 */
  userAgent: string | undefined;
  /** 客户端 IP（已由调用方从可信来源取得）。 */
  ip: string | undefined;
};

/** 一次成功认证产出的凭据。 */
export type IssuedSession = {
  sessionId: string;
  /** BIGINT → string。 */
  userId: string;
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresInSeconds: number;
  refreshTokenExpiresInSeconds: number;
};

/**
 * 把 UA / IP 这类指纹转成不可逆摘要。
 *
 * 复用 `AUTH_REFRESH_TOKEN_PEPPER` 作为 HMAC 密钥，而不是写死一个常量：
 * 写死常量等于「拿到库就能反查常见 UA / IP 网段」，加了 pepper 才真的不可逆。
 */
export function hashFingerprint(
  pepper: string,
  kind: 'ua' | 'ip',
  value: string | undefined,
): string | null {
  if (value === undefined || value === '') return null;
  return createHmac('sha256', pepper)
    .update(`signal:session-fingerprint:v1:${kind}:${value}`)
    .digest('hex')
    .slice(0, 64);
}

@Injectable()
export class SessionService {
  constructor(
    @Inject(AUTH_REPOSITORY) private readonly repository: AuthRepository,
    @Inject(USER_REPOSITORY) private readonly users: UserRepository,
    @Inject(AUTH_CONFIG) private readonly config: AuthConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(AccessTokenService) private readonly accessTokens: AccessTokenService,
  ) {}

  /** 登录成功后签发新会话。 */
  async issue(
    user: { id: string; role: UserRole },
    meta: SessionRequestMeta,
  ): Promise<IssuedSession> {
    return this.createSession(user, meta);
  }

  /**
   * 用 refresh token 换一套新凭据（轮换）。
   *
   * 分支与对应错误码：
   *   - 哈希查不到        → `AUTH_SESSION_INVALID`（401）
   *   - 已撤销的重放      → 撤销该用户全部会话 + `AUTH_SESSION_REVOKED`（401）
   *   - 已过期            → 撤销该条 + `AUTH_SESSION_INVALID`（401）
   *   - 用户被禁用        → 撤销全部 + `AUTH_ACCOUNT_DISABLED`（401）
   */
  async rotate(refreshToken: string, meta: SessionRequestMeta): Promise<IssuedSession> {
    const now = this.clock.now();
    const session = await this.repository.findSessionByRefreshHash(
      this.hashRefreshToken(refreshToken),
    );

    if (session === null) throw sessionInvalid();

    if (session.revokedAt !== null) {
      // 一个已经轮换掉的 token 又出现了 —— 视为凭据泄露，砍掉该用户所有会话。
      await this.repository.revokeAllSessionsForUser(session.userId, now);
      throw sessionRevoked();
    }

    if (session.expiresAt.getTime() <= now.getTime()) {
      await this.repository.revokeSession(session.id, now);
      throw sessionInvalid();
    }

    const user = await this.users.findById(session.userId);
    if (user === null) {
      await this.repository.revokeAllSessionsForUser(session.userId, now);
      throw sessionInvalid();
    }
    if (user.status !== UserStatus.ACTIVE) {
      await this.repository.revokeAllSessionsForUser(user.id, now);
      throw new AppError({
        code: DomainErrorCode.AUTH_ACCOUNT_DISABLED,
        httpStatus: 401,
        safeMessage: 'Account is disabled',
      });
    }

    // 先撤销旧的：只有本次调用真的改了状态，才允许签发新的。
    // 并发刷新时失败的一方会走到这里，被判定为重放。
    const revoked = await this.repository.revokeSession(session.id, now);
    if (!revoked) {
      await this.repository.revokeAllSessionsForUser(session.userId, now);
      throw sessionRevoked();
    }

    return this.createSession({ id: user.id, role: user.role }, meta);
  }

  /** 退出登录：撤销指定会话。幂等 —— 已撤销也返回成功。 */
  async revoke(sessionId: string): Promise<void> {
    await this.repository.revokeSession(sessionId, this.clock.now());
  }

  /**
   * 按 refresh token 撤销会话。找不到就静默返回。
   *
   * 登出**刻意不要求有效的 access token**：access token 只有 15 分钟，
   * 若登出要过 AuthGuard，token 一过期用户就登不出去（还会看到 401），
   * 这正是「登出按钮点了没用」的常见成因。
   */
  async revokeByRefreshToken(refreshToken: string): Promise<void> {
    const session = await this.repository.findSessionByRefreshHash(
      this.hashRefreshToken(refreshToken),
    );
    if (session === null || session.revokedAt !== null) return;
    await this.repository.revokeSession(session.id, this.clock.now());
  }

  /**
   * 只反查 refresh token 属于谁，不做任何状态变更。
   *
   * 给限流用：限流 key 必须是 **userId**（token 每次都轮换，用 token 作 key
   * 等于永远不触发限额）。找不到、或会话已撤销/已过期时返回 null，
   * 调用方按 `AUTH_SESSION_INVALID` 处理。
   */
  async findUserIdByRefreshToken(refreshToken: string): Promise<string | null> {
    const session = await this.repository.findSessionByRefreshHash(
      this.hashRefreshToken(refreshToken),
    );
    if (session === null || session.revokedAt !== null) return null;
    if (session.expiresAt.getTime() <= this.clock.now().getTime()) return null;
    return session.userId;
  }

  /**
   * 算 refresh token 的存储哈希。
   *
   * 用 HMAC + pepper 而不是裸 SHA-256：refresh token 是高熵随机串，
   * 加 pepper 的意义在于「只拿到数据库也换不出会话」。
   */
  hashRefreshToken(refreshToken: string): string {
    return createHmac('sha256', this.config.refreshTokenPepper)
      .update(`${REFRESH_TOKEN_PURPOSE}:${refreshToken}`)
      .digest('hex');
  }

  private async createSession(
    user: { id: string; role: UserRole },
    meta: SessionRequestMeta,
  ): Promise<IssuedSession> {
    const now = this.clock.now();
    const refreshToken = randomBytes(REFRESH_TOKEN_BYTES).toString('base64url');

    const created = await this.repository.createSession({
      userId: user.id,
      refreshTokenHash: this.hashRefreshToken(refreshToken),
      expiresAt: new Date(now.getTime() + REFRESH_SESSION_TTL_SECONDS * 1000),
      userAgentHash: this.hashFingerprint('ua', meta.userAgent),
      ipHash: this.hashFingerprint('ip', meta.ip),
    });

    const accessToken = this.accessTokens.signAccessToken({
      userId: user.id,
      sessionId: created.id,
      role: user.role,
    });

    return {
      sessionId: created.id,
      userId: user.id,
      accessToken,
      refreshToken,
      accessTokenExpiresInSeconds: ACCESS_TOKEN_TTL_SECONDS,
      refreshTokenExpiresInSeconds: REFRESH_SESSION_TTL_SECONDS,
    };
  }

  /** UA / IP 只存哈希（`docs/11`：不建立广告画像）。 */
  private hashFingerprint(kind: 'ua' | 'ip', value: string | undefined): string | null {
    return hashFingerprint(this.config.refreshTokenPepper, kind, value);
  }
}

export function sessionInvalid(): AppError {
  return new AppError({
    code: DomainErrorCode.AUTH_SESSION_INVALID,
    httpStatus: 401,
    safeMessage: 'Session is invalid or has expired',
  });
}

export function sessionRevoked(): AppError {
  return new AppError({
    code: DomainErrorCode.AUTH_SESSION_REVOKED,
    httpStatus: 401,
    safeMessage: 'Session has been revoked',
  });
}
