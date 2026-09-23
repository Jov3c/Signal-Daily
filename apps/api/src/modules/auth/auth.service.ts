/**
 * AuthService —— 认证流程编排。
 *
 * 分工：
 *   - `OtpService`       只管验证码本身的生成 / 校验 / 消费
 *   - `SessionService`   只管会话的签发 / 轮换 / 撤销
 *   - `RateLimitService` 只管限流判定
 *   - 本文件负责把上面几步按顺序串起来，决定事务边界、错误语义与 Cookie 组装
 *
 * 安全（`docs/14`）：全流程**不记录**验证码、access token、refresh token、
 * Authorization 头与 OAuth code。日志只留 userId / 邮箱摘要 / flow。
 */

import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { AppError, DomainErrorCode, PlatformErrorCode, UserStatus } from '@signal/contracts';
import { APP_LOGGER } from '../../common/logger/app-logger';
import type { Logger } from '@signal/logger';
import { toMeDto } from '../users/dto/me.dto';
import { USER_REPOSITORY, type UserRecord, type UserRepository } from '../users/user.repository';
import { AccessTokenService } from './access-token.service';
import { buildSessionCookies } from './auth-cookies';
import { AUTH_CONFIG, type AuthConfig } from './auth.config';
import { OAUTH_STATE_TTL_SECONDS, RATE_LIMITS } from './auth.constants';
import { CLOCK, type Clock } from './clock';
import { GITHUB_CLIENT, type GithubClient, type GithubProfile } from './github.client';
import { MAIL_SENDER, type MailSender } from './mail-sender';
import { constantTimeEqual, generateOAuthState, verifyOAuthState } from './oauth-state';
import { OtpService } from './otp.service';
import { RateLimitService } from './rate-limit.service';
import { AUTH_REPOSITORY, type AuthAccountRecord, type AuthRepository } from './repository';
import { SessionService, hashFingerprint, type SessionRequestMeta } from './session.service';
import type { AuthSessionResponse, RequestCodeResponse } from './dto/auth.dto';

/** OAuth provider 名（写入 `auth_accounts.provider`）。 */
export const GITHUB_PROVIDER = 'github';

/** 一次认证请求的上下文。 */
export type AuthRequestContext = {
  ip: string | undefined;
  userAgent: string | undefined;
};

/** 登录成功后的结果：响应体 + 需要写入的 Cookie。 */
export type LoginResult = {
  response: AuthSessionResponse;
  cookies: string[];
};

/** GitHub 登录完成后的结果。 */
export type GithubLoginResult = {
  cookies: string[];
  redirectUrl: string;
};

@Injectable()
export class AuthService {
  constructor(
    @Inject(AUTH_REPOSITORY) private readonly accounts: AuthRepository,
    @Inject(USER_REPOSITORY) private readonly users: UserRepository,
    @Inject(AUTH_CONFIG) private readonly config: AuthConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(MAIL_SENDER) private readonly mail: MailSender,
    @Inject(GITHUB_CLIENT) private readonly github: GithubClient,
    @Inject(APP_LOGGER) private readonly logger: Logger,
    @Inject(AccessTokenService) private readonly accessTokens: AccessTokenService,
    @Inject(OtpService) private readonly otp: OtpService,
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(RateLimitService) private readonly rateLimit: RateLimitService,
  ) {}

  /* ---------------------------------------------------------------- */
  /* Email OTP                                                         */
  /* ---------------------------------------------------------------- */

  /**
   * 请求验证码。
   *
   * 无论邮箱是否已注册，都返回同一个结果 —— `sent: true`。
   * 若对未注册邮箱返回错误，这个接口就成了「某人是否在用 Signal」的查询接口。
   */
  async requestEmailCode(email: string, context: AuthRequestContext): Promise<RequestCodeResponse> {
    await this.rateLimit.enforce('otp:request:email', email, RATE_LIMITS.otpRequestPerEmail);
    if (context.ip !== undefined) {
      await this.rateLimit.enforce('otp:request:ip', context.ip, RATE_LIMITS.otpRequestPerIp);
    }

    // 用 OTP 自己的 pepper（而不是 refresh token 的）：不同用途不共用密钥材料。
    const ipHash = hashFingerprint(this.config.emailOtpPepper, 'ip', context.ip);
    const { code, expiresInSeconds } = await this.otp.issue(email, ipHash);

    // 明文只进邮件正文，不落库、不进日志。
    await this.mail.sendOtpEmail({ to: email, code, expiresInSeconds });

    this.logger.info(
      { emailHash: hashForLog(email), flow: 'email-otp' },
      'auth: verification code issued',
    );

    return { sent: true, expiresInSeconds };
  }

  /** 校验验证码并登录（首次登录即注册）。 */
  async verifyEmailCode(
    email: string,
    code: string,
    context: AuthRequestContext,
  ): Promise<LoginResult> {
    await this.rateLimit.enforce('otp:verify:email', email, RATE_LIMITS.otpVerifyPerEmail);
    await this.otp.verifyAndConsume(email, code);

    const user = await this.users.findOrCreateByEmail(email);
    this.assertActive(user.status);

    const session = await this.sessions.issue(
      { id: user.id, role: user.role },
      toSessionMeta(context),
    );

    this.logger.info({ userId: user.id, flow: 'email-otp' }, 'auth: login succeeded');

    return {
      response: {
        user: toMeDto(user),
        accessTokenExpiresInSeconds: session.accessTokenExpiresInSeconds,
      },
      cookies: buildSessionCookies(session, this.config),
    };
  }

  /* ---------------------------------------------------------------- */
  /* GitHub OAuth                                                      */
  /* ---------------------------------------------------------------- */

  /**
   * 发起 GitHub 登录。
   * `buildAuthorizeUrl` 在未配置 GitHub 时抛 503（`AUTH_GITHUB_NOT_CONFIGURED`）。
   */
  startGithubLogin(): { authorizeUrl: string; state: string } {
    const state = generateOAuthState(this.config.accessTokenSecret, this.clock.now());
    return { authorizeUrl: this.github.buildAuthorizeUrl(state), state };
  }

  /**
   * 处理 GitHub 回调。
   *
   * state 三重校验：签名有效、未超过 10 分钟、与发起时留在本浏览器的 Cookie 一致。
   * 缺任何一项都拒绝 —— 这是防「登录 CSRF」的关键。
   */
  async completeGithubLogin(params: {
    code: string;
    state: string;
    /** 来自 Cookie 的 state；没带、或带了多个同名 Cookie 时为 undefined。 */
    cookieState: string | undefined;
    context: AuthRequestContext;
  }): Promise<GithubLoginResult> {
    const now = this.clock.now();

    if (
      !verifyOAuthState(this.config.accessTokenSecret, params.state, now, OAUTH_STATE_TTL_SECONDS)
    ) {
      throw oauthStateInvalid();
    }
    if (params.cookieState === undefined || !constantTimeEqual(params.cookieState, params.state)) {
      throw oauthStateInvalid();
    }

    const providerAccessToken = await this.github.exchangeCodeForToken(params.code);
    const profile = await this.github.fetchProfile(providerAccessToken);

    const user = await this.resolveGithubUser(profile);
    this.assertActive(user.status);

    const session = await this.sessions.issue(
      { id: user.id, role: user.role },
      toSessionMeta(params.context),
    );

    this.logger.info({ userId: user.id, flow: 'github' }, 'auth: login succeeded');

    return {
      cookies: buildSessionCookies(session, this.config),
      redirectUrl: this.config.appBaseUrl,
    };
  }

  /**
   * 把 GitHub 资料落到本地用户。
   *
   * 顺序：先找绑定 → 没有则按「已验证邮箱」找已有用户并绑定 → 仍没有才建新用户。
   *
   * 这不是一个跨表事务，但每一步都幂等：中途失败只会留下「用户已建、绑定未建」，
   * 用户下次登录会补上绑定，不会产生重复账号。**不允许用未验证邮箱绑定账号** ——
   * GitHub 的 `email` 可能是用户自填的任意值。
   */
  private async resolveGithubUser(profile: GithubProfile): Promise<UserRecord> {
    const bound = await this.accounts.findAuthAccount(GITHUB_PROVIDER, profile.providerAccountId);
    if (bound !== null) return this.requireUser(bound);

    // 首次登录要把昵称 / 头像一起带上：`findOrCreateByEmail` 只在**新建**时采用它们，
    // 已有用户不会被覆盖（用户可能已经改过自己的资料）。
    const displayName = profile.name ?? profile.login;
    const user =
      profile.email !== null
        ? await this.users.findOrCreateByEmail(profile.email, {
            displayName,
            avatarUrl: profile.avatarUrl,
          })
        : await this.users.createWithPreference({
            email: null,
            displayName,
            avatarUrl: profile.avatarUrl,
          });

    const linked = await this.accounts.linkAuthAccount({
      userId: user.id,
      provider: GITHUB_PROVIDER,
      providerAccountId: profile.providerAccountId,
    });
    if (linked !== null) return user;

    // 并发回调：另一个请求先建好了绑定。重新读一次即可，这不是错误。
    const raced = await this.accounts.findAuthAccount(GITHUB_PROVIDER, profile.providerAccountId);
    if (raced === null) throw accountLookupBroken();
    return this.requireUser(raced);
  }

  private async requireUser(account: AuthAccountRecord): Promise<UserRecord> {
    const user = await this.users.findById(account.userId);
    // `auth_accounts.user_id` 是级联外键，理论上到不了这里；真到了就是数据异常。
    if (user === null) throw accountLookupBroken();
    return user;
  }

  /* ---------------------------------------------------------------- */
  /* Session                                                           */
  /* ---------------------------------------------------------------- */

  /** 刷新：轮换会话。 */

  async refresh(
    refreshToken: string | undefined,
    context: AuthRequestContext,
  ): Promise<LoginResult> {
    if (refreshToken === undefined || refreshToken === '') {
      throw new AppError({
        code: DomainErrorCode.AUTH_SESSION_INVALID,
        httpStatus: 401,
        safeMessage: 'Session is invalid or has expired',
      });
    }

    // ⚠ 限流主体必须是 **userId**，不能是 refresh token 的摘要：
    // refresh 每次都会轮换 token，用 token 作 key 等于每个请求一个新计数器，
    // 限额永远不会触发 —— 看着有配置，实际完全失效。
    //
    // ⚠ 这里是**纯粹的限流前置检查，不参与鉴权**：识别不出身份时也不能提前
    // 抛错，否则「重放已轮换的 token」这条路径会被截断成 SESSION_INVALID，
    // 既丢了「凭据泄露」的语义，也**不会再撤销该用户全部会话**。
    // 正确性一律交给下面的 rotate()。
    const userId = await this.sessions.findUserIdByRefreshToken(refreshToken);
    if (userId !== null) {
      await this.rateLimit.enforce('auth:refresh:user', userId, RATE_LIMITS.refreshPerUser);
    } else {
      // 认不出来的 token 不存在「轮换」，用它自己的摘要兜底限流，挡住随机试探。
      await this.rateLimit.enforce(
        'auth:refresh:unknown',
        createHash('sha256').update(refreshToken).digest('hex').slice(0, 32),
        RATE_LIMITS.refreshPerUnknownToken,
      );
    }

    const session = await this.sessions.rotate(refreshToken, toSessionMeta(context));

    const user = await this.users.findById(session.userId);
    if (user === null) throw accountLookupBroken();

    return {
      response: {
        user: toMeDto(user),
        accessTokenExpiresInSeconds: session.accessTokenExpiresInSeconds,
      },
      cookies: buildSessionCookies(session, this.config),
    };
  }

  /**
   * 退出登录。幂等。
   *
   * 两条定位路径都要走：
   *   1. refresh token（浏览器场景）—— 直接按哈希找到会话；
   *   2. access token（只用 `Authorization` 头的客户端，例如原生 App）——
   *      从载荷里取 `sid`。access token 已过期就忽略，不能因此让登出失败。
   *
   * 只做其中一条会让另一种客户端出现「登出返回 200 但会话还在」的静默失效。
   */
  async logout(params: {
    refreshToken: string | undefined;
    accessToken?: string | undefined;
  }): Promise<void> {
    if (params.refreshToken !== undefined && params.refreshToken !== '') {
      await this.sessions.revokeByRefreshToken(params.refreshToken);
    }

    const sessionId = this.sessionIdFromAccessToken(params.accessToken);
    if (sessionId !== undefined) {
      await this.sessions.revoke(sessionId);
    }
  }

  /** 尽力从 access token 取 `sid`；任何失败（过期 / 被篡改）都返回 undefined。 */
  private sessionIdFromAccessToken(accessToken: string | undefined): string | undefined {
    if (accessToken === undefined || accessToken === '') return undefined;
    try {
      return this.accessTokens.verifyAccessToken(accessToken).sessionId;
    } catch {
      // 故意吞掉：登出不该因为 access token 过期而失败。
      return undefined;
    }
  }

  private assertActive(status: UserStatus): void {
    if (status !== UserStatus.ACTIVE) {
      throw new AppError({
        code: DomainErrorCode.AUTH_ACCOUNT_DISABLED,
        httpStatus: 401,
        safeMessage: 'Account is disabled',
      });
    }
  }
}

function oauthStateInvalid(): AppError {
  return new AppError({
    code: DomainErrorCode.AUTH_OAUTH_STATE_INVALID,
    httpStatus: 401,
    safeMessage: 'Invalid OAuth state',
  });
}

function accountLookupBroken(): AppError {
  return new AppError({
    code: PlatformErrorCode.INTERNAL_ERROR,
    httpStatus: 500,
    safeMessage: 'Internal server error',
  });
}

function toSessionMeta(context: AuthRequestContext): SessionRequestMeta {
  return { userAgent: context.userAgent, ip: context.ip };
}

/** 日志用的邮箱摘要：可关联、不可还原（邮箱是 PII，不进明文日志）。 */
export function hashForLog(email: string): string {
  return createHash('sha256').update(email.trim().toLowerCase()).digest('hex').slice(0, 16);
}
