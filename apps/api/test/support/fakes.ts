/**
 * Auth 测试用的内存替身。
 *
 * 这些替身**不是**为了「让测试好写」而放松语义 —— 它们刻意复刻真实实现的
 * 关键约束，否则测试就是自证：
 *   - OTP 的「条件消费」：只有把 consumedAt 从 null 改成时间戳的那一次算成功。
 *   - Session 的 `refreshTokenHash` 唯一约束。
 *   - AuthAccount 的 `(provider, providerAccountId)` 唯一约束。
 *   - `users.email` 唯一。
 * 真实 MySQL 上的同一批断言由 `auth.integration.spec.ts` 再跑一遍。
 */

import { randomUUID } from 'node:crypto';
import { AppError, DomainErrorCode, UserRole, UserStatus } from '@signal/contracts';
import type { AccessTokenClaims, AccessTokenVerifier } from '../../src/common/guards/ports';
import type { Clock } from '../../src/modules/auth/clock';
import type { AuthConfig } from '../../src/modules/auth/auth.config';
import type { GithubClient, GithubProfile } from '../../src/modules/auth/github.client';
import type { MailSender, SendOtpEmailParams } from '../../src/modules/auth/mail-sender';
import type {
  RateLimitPolicy,
  RateLimitResult,
  RateLimiter,
} from '../../src/modules/auth/rate-limiter';
import type { AuthenticatedSession } from '../../src/common/guards/ports';
import type {
  AuthAccountRecord,
  AuthRepository,
  CreateOtpInput,
  CreateSessionInput,
  OtpRecord,
  SessionRecord,
} from '../../src/modules/auth/repository';
import {
  USER_FIELD_LIMITS,
  clampToColumn,
  type CreateUserInput,
  type UserRecord,
  type UserRepository,
} from '../../src/modules/users/user.repository';

/* ------------------------------------------------------------------ */
/* Clock                                                               */
/* ------------------------------------------------------------------ */

/** 可手动推进的时钟。用来在毫秒级内断言 10 分钟过期、30 天过期。 */
export class FakeClock implements Clock {
  private current: Date;

  constructor(start: Date = new Date('2026-09-23T00:00:00.000Z')) {
    this.current = start;
  }

  now(): Date {
    return new Date(this.current.getTime());
  }

  advanceMs(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }

  advanceSeconds(seconds: number): void {
    this.advanceMs(seconds * 1000);
  }
}

/* ------------------------------------------------------------------ */
/* Rate limiter                                                        */
/* ------------------------------------------------------------------ */

/** 默认放行；`denyAll()` 后可用来强制命中限流分支。 */
export class FakeRateLimiter implements RateLimiter {
  readonly calls: { key: string; policy: RateLimitPolicy }[] = [];
  private deny = false;

  denyAll(): void {
    this.deny = true;
  }

  async consume(key: string, policy: RateLimitPolicy): Promise<RateLimitResult> {
    this.calls.push({ key, policy });
    return {
      allowed: !this.deny,
      remaining: this.deny ? 0 : policy.limit,
      resetAt: new Date(Date.now() + policy.windowSeconds * 1000),
    };
  }
}

/* ------------------------------------------------------------------ */
/* Mail                                                                */
/* ------------------------------------------------------------------ */

export type CapturedMail = SendOtpEmailParams & { capturedAt: Date };

export class FakeMailSender implements MailSender {
  readonly sent: CapturedMail[] = [];

  async sendOtpEmail(params: SendOtpEmailParams): Promise<void> {
    this.sent.push({ ...params, capturedAt: new Date() });
  }

  /** 最近一封邮件的验证码。测试用它完成登录，而不必读日志。 */
  latestCode(): string {
    const last = this.sent.at(-1);
    if (last === undefined) throw new Error('没有捕获到任何验证码邮件');
    return last.code;
  }

  reset(): void {
    this.sent.length = 0;
  }
}

/* ------------------------------------------------------------------ */
/* GitHub                                                              */
/* ------------------------------------------------------------------ */

export class FakeGithubClient implements GithubClient {
  readonly exchangedCodes: string[] = [];
  profile: GithubProfile = {
    providerAccountId: '42',
    login: 'octocat',
    name: 'Mona Lisa',
    avatarUrl: 'https://avatars.example/octocat.png',
    email: 'octocat@example.com',
  };
  /** 设为 true 时 `exchangeCodeForToken` 抛错，用来覆盖上游失败分支。 */
  failExchange = false;
  private readonly configured: boolean;

  constructor(configured = true) {
    this.configured = configured;
  }

  /**
   * 抛出的错误与真实 `FetchGithubClient` **逐字一致**。
   * 如果这里图省事抛 `new Error()`，HTTP 层的断言就会变成 500 而不是 503/502 ——
   * 测试通过但生产行为没被验证到。
   */
  buildAuthorizeUrl(state: string): string {
    this.assertConfigured();
    const url = new URL('https://github.com/login/oauth/authorize');
    url.searchParams.set('client_id', 'test-client');
    url.searchParams.set('scope', 'read:user user:email');
    url.searchParams.set('state', state);
    return url.toString();
  }

  async exchangeCodeForToken(code: string): Promise<string> {
    this.assertConfigured();
    if (this.failExchange) {
      throw new AppError({
        code: DomainErrorCode.AUTH_OAUTH_EXCHANGE_FAILED,
        httpStatus: 502,
        safeMessage: 'GitHub OAuth exchange failed',
      });
    }
    this.exchangedCodes.push(code);
    return 'gho_faketoken';
  }

  async fetchProfile(): Promise<GithubProfile> {
    this.assertConfigured();
    return this.profile;
  }

  private assertConfigured(): void {
    if (this.configured) return;
    throw new AppError({
      code: DomainErrorCode.AUTH_GITHUB_NOT_CONFIGURED,
      httpStatus: 503,
      safeMessage: 'GitHub sign-in is not configured',
    });
  }
}

/* ------------------------------------------------------------------ */
/* Users                                                               */
/* ------------------------------------------------------------------ */

export class InMemoryUserRepository implements UserRepository {
  readonly users = new Map<string, UserRecord>();
  private nextId = 1;

  /** 直接插入一个用户（测试准备数据用）。 */
  seed(input: {
    email: string | null;
    role?: UserRole;
    status?: UserStatus;
    displayName?: string | null;
    avatarUrl?: string | null;
  }): UserRecord {
    const record: UserRecord = {
      id: String(this.nextId++),
      email: input.email,
      displayName: input.displayName ?? null,
      avatarUrl: input.avatarUrl ?? null,
      role: input.role ?? UserRole.USER,
      status: input.status ?? UserStatus.ACTIVE,
      createdAt: new Date('2026-09-01T00:00:00.000Z'),
    };
    this.users.set(record.id, record);
    return record;
  }

  async findAuthUserById(
    id: string,
  ): Promise<{ id: string; role: UserRole; status: UserStatus } | null> {
    const user = this.users.get(id);
    return user === undefined ? null : { id: user.id, role: user.role, status: user.status };
  }

  async findById(id: string): Promise<UserRecord | null> {
    return this.users.get(id) ?? null;
  }

  async findByEmail(email: string): Promise<UserRecord | null> {
    for (const user of this.users.values()) {
      if (user.email === email) return user;
    }
    return null;
  }

  async findOrCreateByEmail(
    email: string,
    defaults: { displayName?: string | null; avatarUrl?: string | null } = {},
  ): Promise<UserRecord> {
    const existing = await this.findByEmail(email);
    // 与真实实现一致：只在新建时采用 defaults，已有用户不覆盖。
    return existing ?? this.seed({ email, ...defaults });
  }

  async createWithPreference(input: CreateUserInput): Promise<UserRecord> {
    if (input.email !== null && (await this.findByEmail(input.email)) !== null) {
      // 复刻 users.email 的唯一约束。
      const error = new Error('Unique constraint failed on the fields: (`email`)');
      (error as { code?: string }).code = 'P2002';
      throw error;
    }
    // 复刻真实实现按列宽截断展示型字段（真库上的等价断言在集成测试里）。
    return this.seed({
      ...input,
      displayName: clampToColumn(input.displayName, USER_FIELD_LIMITS.displayName),
      avatarUrl: clampToColumn(input.avatarUrl, USER_FIELD_LIMITS.avatarUrl),
    });
  }
}

/* ------------------------------------------------------------------ */
/* Auth repository                                                     */
/* ------------------------------------------------------------------ */

type OtpRow = CreateOtpInput & { id: string; consumedAt: Date | null };

export class InMemoryAuthRepository implements AuthRepository {
  /**
   * 指向用户仓储，用来复刻真实实现里 `sessions` join `users` 的那条查询。
   * 由 `createAuthTestApp()` 在构造后接上。
   */
  users: InMemoryUserRepository | null = null;

  readonly otpRows: OtpRow[] = [];
  readonly sessions: (CreateSessionInput & { id: string; revokedAt: Date | null })[] = [];
  readonly accounts: { id: string; userId: string; provider: string; providerAccountId: string }[] =
    [];
  private nextId = 1;

  async replaceActiveOtp(input: CreateOtpInput, now: Date): Promise<void> {
    for (const row of this.otpRows) {
      if (row.email === input.email && row.consumedAt === null) row.consumedAt = now;
    }
    this.otpRows.push({ ...input, id: String(this.nextId++), consumedAt: null });
  }

  async findLatestUnconsumedOtp(email: string): Promise<OtpRecord | null> {
    const row = [...this.otpRows].reverse().find((r) => r.email === email && r.consumedAt === null);
    return row === undefined
      ? null
      : { id: row.id, codeHash: row.codeHash, expiresAt: row.expiresAt };
  }

  async findRecentlyConsumedOtp(email: string, since: Date): Promise<OtpRecord | null> {
    const row = [...this.otpRows]
      .reverse()
      .find((r) => r.email === email && r.consumedAt !== null && r.consumedAt >= since);
    return row === undefined
      ? null
      : { id: row.id, codeHash: row.codeHash, expiresAt: row.expiresAt };
  }

  async consumeOtp(id: string, consumedAt: Date): Promise<boolean> {
    const row = this.otpRows.find((r) => r.id === id);
    // 复刻真实实现的条件更新语义：已消费的行不会被二次消费。
    if (row === undefined || row.consumedAt !== null) return false;
    row.consumedAt = consumedAt;
    return true;
  }

  async createSession(input: CreateSessionInput): Promise<{ id: string }> {
    if (this.sessions.some((s) => s.refreshTokenHash === input.refreshTokenHash)) {
      throw new Error('Unique constraint failed on refresh_token_hash');
    }
    const id = String(this.nextId++);
    this.sessions.push({ ...input, id, revokedAt: null });
    return { id };
  }

  async findSessionByRefreshHash(refreshTokenHash: string): Promise<SessionRecord | null> {
    const row = this.sessions.find((s) => s.refreshTokenHash === refreshTokenHash);
    return row === undefined
      ? null
      : { id: row.id, userId: row.userId, expiresAt: row.expiresAt, revokedAt: row.revokedAt };
  }

  async findAuthenticatedSession(sessionId: string): Promise<AuthenticatedSession | null> {
    const row = this.sessions.find((s) => s.id === sessionId);
    // 已撤销 / 已过期的会话与不存在的会话一样返回 null —— 与真实实现的 where 条件一致。
    if (row === undefined || row.revokedAt !== null) return null;
    if (row.expiresAt.getTime() <= Date.now()) return null;

    const user = this.users === null ? null : await this.users.findAuthUserById(row.userId);
    if (user === null) return null;

    return { sessionId: row.id, userId: user.id, role: user.role, status: user.status };
  }

  async revokeSession(sessionId: string, revokedAt: Date): Promise<boolean> {
    const row = this.sessions.find((s) => s.id === sessionId);
    if (row === undefined || row.revokedAt !== null) return false;
    row.revokedAt = revokedAt;
    return true;
  }

  async revokeAllSessionsForUser(userId: string, revokedAt: Date): Promise<number> {
    let count = 0;
    for (const row of this.sessions) {
      if (row.userId === userId && row.revokedAt === null) {
        row.revokedAt = revokedAt;
        count += 1;
      }
    }
    return count;
  }

  async findAuthAccount(
    provider: string,
    providerAccountId: string,
  ): Promise<AuthAccountRecord | null> {
    const row = this.accounts.find(
      (a) => a.provider === provider && a.providerAccountId === providerAccountId,
    );
    return row === undefined ? null : { id: row.id, userId: row.userId };
  }

  async linkAuthAccount(input: {
    userId: string;
    provider: string;
    providerAccountId: string;
  }): Promise<AuthAccountRecord | null> {
    const exists = await this.findAuthAccount(input.provider, input.providerAccountId);
    if (exists !== null) return null;
    const id = String(this.nextId++);
    this.accounts.push({ id, ...input });
    return { id, userId: input.userId };
  }
}

/* ------------------------------------------------------------------ */
/* Access token verifier 替身                                          */
/* ------------------------------------------------------------------ */

/** 用于只想测守卫分支、不想走真实 JWT 的用例。 */
export class FakeAccessTokenVerifier implements AccessTokenVerifier {
  claims: AccessTokenClaims | null = null;
  error: Error | null = null;

  verifyAccessToken(): AccessTokenClaims {
    if (this.error !== null) throw this.error;
    if (this.claims === null) throw new Error('FakeAccessTokenVerifier 未设置 claims');
    return this.claims;
  }
}

/* ------------------------------------------------------------------ */
/* Config                                                              */
/* ------------------------------------------------------------------ */

/** 一份自洽的测试配置：不依赖任何真实 env。 */
export function createTestAuthConfig(overrides: Partial<AuthConfig> = {}): AuthConfig {
  return {
    nodeEnv: 'test',
    secureCookies: false,
    accessTokenSecret: 'test-access-token-secret-value',
    refreshTokenPepper: 'test-refresh-token-pepper-value',
    emailOtpPepper: 'test-email-otp-pepper-value',
    github: {
      clientId: 'test-client',
      clientSecret: 'test-secret',
      callbackUrl: 'http://localhost:3001/api/v1/auth/github/callback',
    },
    smtp: null,
    appBaseUrl: 'http://localhost:3000',
    redisUrl: 'redis://localhost:6379',
    ...overrides,
  };
}

export { randomUUID };
