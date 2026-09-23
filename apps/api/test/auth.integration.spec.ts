/**
 * Auth 集成测试 —— **真实 MySQL + 真实 Redis**。
 *
 * 运行：`pnpm --filter @signal/api test:integration`
 * 环境：仓库根 `.env` 里的 `DATABASE_URL` / `REDIS_URL`（可用环境变量覆盖）。
 *
 * 与 `pnpm test` 里的同一批断言的区别：
 *   那边用的是内存替身（复刻约束），这边打的是**真库**：
 *   `email_otp_codes.code_hash` 的实际列宽、`sessions.refresh_token_hash` 的
 *   唯一索引、级联删除、以及 Redis 上限流键的真实 TTL。
 *   连不上就直接失败，绝不静默跳过。
 */

import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { createLogger } from '@signal/logger';
import { API_PREFIX, DomainErrorCode } from '@signal/contracts';
import { createMemoryStream } from '@signal/test-utils';
import { AuthModule } from '../src/modules/auth/auth.module';
import { AUTH_CONFIG, buildAuthConfig, type AuthConfig } from '../src/modules/auth/auth.config';
import { CLOCK } from '../src/modules/auth/clock';
import { GITHUB_CLIENT } from '../src/modules/auth/github.client';
import { MAIL_SENDER } from '../src/modules/auth/mail-sender';
import { OTP_CODE_GENERATOR } from '../src/modules/auth/otp.service';
import {
  REDIS_CLIENT,
  RedisRateLimiter,
  createRedisClient,
} from '../src/modules/auth/redis-rate-limiter';
import { APP_LOGGER } from '../src/common/logger/app-logger';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { FakeClock, FakeGithubClient, FakeMailSender, createTestAuthConfig } from './support/fakes';
import { cookieHeader, cookieValue, setCookies } from './support/test-app';

/* ------------------------------------------------------------------ */
/* 环境准备                                                            */
/* ------------------------------------------------------------------ */

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

/** 载入仓库根 `.env`，但**不覆盖**已经显式设置的环境变量。 */
function loadDotEnv(): void {
  let content: string;
  try {
    content = readFileSync(`${REPO_ROOT}/.env`, 'utf8');
  } catch {
    return;
  }
  for (const line of content.split('\n')) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match === null) continue;
    const [, key, value] = match as unknown as [string, string, string];
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadDotEnv();

const OTP_CODE = '424242';
const EMAIL = `agent02-it-${randomBytes(6).toString('hex')}@signal.test`;

let app: Awaited<ReturnType<ReturnType<typeof Test.createTestingModule>['compile']>> extends {
  createNestApplication: (...args: never[]) => infer A;
}
  ? A
  : never;

let baseUrl = '';
let prisma: PrismaService;
let redis: ReturnType<typeof createRedisClient>;
const mail = new FakeMailSender();
const github = new FakeGithubClient();
const clock = new FakeClock();
const logStream = createMemoryStream();

const config: AuthConfig = createTestAuthConfig({
  nodeEnv: 'test',
  secureCookies: false,
  accessTokenSecret: process.env.AUTH_ACCESS_TOKEN_SECRET ?? 'integration-access-secret',
  refreshTokenPepper: process.env.AUTH_REFRESH_TOKEN_PEPPER ?? 'integration-refresh-pepper',
  emailOtpPepper: process.env.EMAIL_OTP_PEPPER ?? 'integration-otp-pepper',
  redisUrl: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379',
  github: null,
});

beforeAll(async () => {
  prisma = new PrismaService();
  redis = createRedisClient(config.redisUrl);

  // 真的 ping 一次：连不上就直接失败，不静默跳过
  await redis.ping();
  await prisma.$queryRaw`SELECT 1`;

  const moduleRef = await Test.createTestingModule({ imports: [AuthModule] })
    .overrideProvider(AUTH_CONFIG)
    .useValue(config)
    .overrideProvider(MAIL_SENDER)
    .useValue(mail)
    .overrideProvider(GITHUB_CLIENT)
    .useValue(github)
    .overrideProvider(CLOCK)
    .useValue(clock)
    .overrideProvider(OTP_CODE_GENERATOR)
    .useValue(() => OTP_CODE)
    .overrideProvider(APP_LOGGER)
    .useValue(createLogger({ service: 'api-it', level: 'info', destination: logStream }))
    // REDIS_CLIENT 与 RATE_LIMITER 都用**真实实现**：Redis 限流必须真跑
    .overrideProvider(REDIS_CLIENT)
    .useValue(redis)
    .compile();

  const nestApp = moduleRef.createNestApplication({ logger: false });
  nestApp.setGlobalPrefix(API_PREFIX.slice(1));
  await nestApp.listen(0, '127.0.0.1');
  baseUrl = await nestApp.getUrl();
  app = nestApp as never;

  // 清掉可能残留的限流计数，保证用例之间的独立性
  await clearRateLimitKeys();
});

/**
 * 每个用例前清空限流计数。
 *
 * 真实限流策略是「同一邮箱 10 分钟最多 5 次验码」，而本文件里多个用例
 * 都在用同一个邮箱登录 —— 不清空的话，第 6 个用例会拿到 429 而不是 200，
 * 失败原因看起来像「登录坏了」，实际是限流按设计生效了。
 */
beforeEach(async () => {
  await clearRateLimitKeys();
});

afterAll(async () => {
  // 清理：删用户（sessions / user_preferences 级联），再删验证码
  await prisma.user.deleteMany({ where: { email: EMAIL } });
  await prisma.emailOtpCode.deleteMany({ where: { email: EMAIL } });
  await clearRateLimitKeys();

  // app.close() 会触发 RedisRateLimiter.onModuleDestroy()，它会 quit 掉**同一个**
  // 客户端实例（测试里 REDIS_CLIENT 与 RATE_LIMITER 共用）。所以这里要容错。
  await app?.close();
  await prisma.$disconnect();
  try {
    await redis.quit();
  } catch {
    // 已经由模块销毁流程关闭，正常情况。
  }
});

async function clearRateLimitKeys(): Promise<void> {
  const keys = await redis.keys('ratelimit:auth:*');
  if (keys.length > 0) await redis.del(...keys);
}

function request(path: string, init: RequestInit & { cookie?: string } = {}): Promise<Response> {
  const { cookie, headers, ...rest } = init;
  return fetch(`${baseUrl}${path}`, {
    redirect: 'manual',
    ...rest,
    headers: {
      ...(rest.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(cookie === undefined ? {} : { cookie }),
      ...(headers ?? {}),
    },
  });
}

function post(path: string, body: unknown, cookie?: string): Promise<Response> {
  return request(path, {
    method: 'POST',
    body: JSON.stringify(body),
    ...(cookie === undefined ? {} : { cookie }),
  });
}

/* ------------------------------------------------------------------ */
/* 用例                                                                */
/* ------------------------------------------------------------------ */

describe('真实 env → 配置装配', () => {
  it('用仓库 .env 走真实的 parseEnv 能构造出配置（本机未配 GitHub / SMTP）', async () => {
    const { parseEnv } = await import('@signal/config');
    const env = parseEnv(process.env);
    const real = buildAuthConfig(env);

    expect(real.accessTokenSecret).not.toBe('change-me');
    expect(real.refreshTokenPepper).not.toBe('change-me');
    expect(real.emailOtpPepper).not.toBe('change-me');
    expect(real.nodeEnv).toBe(env.NODE_ENV);
    // 本地 .env 没有 GITHUB_CLIENT_ID / SMTP_HOST → 两个通道都应为 null，
    // 于是 /auth/github 返回 503、OTP 走开发用控制台投递。
    expect(real.github).toBeNull();
    expect(real.smtp).toBeNull();
    expect(real.secureCookies).toBe(env.NODE_ENV === 'production');
  });
});

describe('真实 MySQL：Email OTP 全流程', () => {
  it('请求验证码 → 库里只存 hash，且不含明文', async () => {
    const response = await post('/api/v1/auth/email/request-code', { email: EMAIL });
    expect(response.status).toBe(200);

    const row = await prisma.emailOtpCode.findFirst({
      where: { email: EMAIL },
      orderBy: { id: 'desc' },
    });
    expect(row).not.toBeNull();
    // 列宽是 VarChar(128)，sha256 hex 是 64 位
    expect(row?.codeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.codeHash).not.toContain(OTP_CODE);
    expect(row?.requestIpHash === null || /^[0-9a-f]{64}$/.test(row.requestIpHash)).toBe(true);
  });

  it('校验成功 → 建用户 + 偏好 + 会话，验证码被消费', async () => {
    const response = await post('/api/v1/auth/email/verify', { email: EMAIL, code: OTP_CODE });
    expect(response.status).toBe(200);

    const user = await prisma.user.findUnique({
      where: { email: EMAIL },
      include: { preference: true },
    });
    expect(user).not.toBeNull();
    // 注册时就必须带上默认偏好（Agent 01 HANDOFF 要求）
    expect(user?.preference).not.toBeNull();
    expect(user?.preference?.theme).toBe('SYSTEM');

    const otp = await prisma.emailOtpCode.findFirst({
      where: { email: EMAIL },
      orderBy: { id: 'desc' },
    });
    expect(otp?.consumedAt).not.toBeNull();

    const sessions = await prisma.session.findMany({ where: { userId: user?.id } });
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.refreshTokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(sessions[0]?.revokedAt).toBeNull();
  });

  it('会话 Cookie 能真实访问 /me；库里读到的 id 与响应一致', async () => {
    const login = await post('/api/v1/auth/email/verify', { email: EMAIL, code: OTP_CODE });
    // 上一条用例已经消费了验证码 → 这里用重放路径拿新的
    if (login.status !== 200) {
      await post('/api/v1/auth/email/request-code', { email: EMAIL });
      const retry = await post('/api/v1/auth/email/verify', { email: EMAIL, code: OTP_CODE });
      expect(retry.status).toBe(200);
      const cookies = setCookies(retry);
      const me = await request('/api/v1/me', { cookie: cookieHeader(cookies) });
      expect(me.status).toBe(200);
      const body = (await me.json()) as { data: { id: string } };
      const dbUser = await prisma.user.findUnique({ where: { email: EMAIL } });
      expect(body.data.id).toBe(String(dbUser?.id));
      return;
    }

    const cookies = setCookies(login);
    const me = await request('/api/v1/me', { cookie: cookieHeader(cookies) });
    expect(me.status).toBe(200);
  });

  it('验证码重放被拒绝，且不会产生第二个会话', async () => {
    await post('/api/v1/auth/email/request-code', { email: EMAIL });
    const ok = await post('/api/v1/auth/email/verify', { email: EMAIL, code: OTP_CODE });
    expect(ok.status).toBe(200);
    const before = await prisma.session.count();

    const replay = await post('/api/v1/auth/email/verify', { email: EMAIL, code: OTP_CODE });
    expect(replay.status).toBe(401);
    const body = (await replay.json()) as { error: { code: string } };
    expect(body.error.code).toBe(DomainErrorCode.AUTH_OTP_ALREADY_USED);
    expect(await prisma.session.count()).toBe(before);
  });

  it('refresh 轮换：旧 token 在真库上被标记为已撤销，重放后全部撤销', async () => {
    await post('/api/v1/auth/email/request-code', { email: EMAIL });
    const login = await post('/api/v1/auth/email/verify', { email: EMAIL, code: OTP_CODE });
    const cookies = setCookies(login);
    const oldRefresh = cookieValue(cookies, 'signal_refresh_token') ?? '';

    const rotated = await post(
      '/api/v1/auth/refresh',
      undefined,
      `signal_refresh_token=${encodeURIComponent(oldRefresh)}`,
    );
    expect(rotated.status).toBe(200);

    const user = await prisma.user.findUnique({ where: { email: EMAIL } });
    const sessions = await prisma.session.findMany({
      where: { userId: user?.id },
      orderBy: { id: 'asc' },
    });
    // 至少两条：一条已撤销（旧），一条有效（新）
    expect(sessions.filter((s) => s.revokedAt !== null).length).toBeGreaterThanOrEqual(1);
    expect(sessions.some((s) => s.revokedAt === null)).toBe(true);

    // 重放旧 refresh token → 撤销该用户全部会话
    const replay = await post(
      '/api/v1/auth/refresh',
      undefined,
      `signal_refresh_token=${encodeURIComponent(oldRefresh)}`,
    );
    expect(replay.status).toBe(401);
    const body = (await replay.json()) as { error: { code: string } };
    expect(body.error.code).toBe(DomainErrorCode.AUTH_SESSION_REVOKED);

    const afterReplay = await prisma.session.findMany({ where: { userId: user?.id } });
    expect(afterReplay.every((s) => s.revokedAt !== null)).toBe(true);
  });

  it('登出后 access token 立刻失效（会话在真库上被撤销）', async () => {
    await post('/api/v1/auth/email/request-code', { email: EMAIL });
    const login = await post('/api/v1/auth/email/verify', { email: EMAIL, code: OTP_CODE });
    const cookies = setCookies(login);

    expect((await request('/api/v1/me', { cookie: cookieHeader(cookies) })).status).toBe(200);
    expect((await post('/api/v1/auth/logout', undefined, cookieHeader(cookies))).status).toBe(200);
    expect((await request('/api/v1/me', { cookie: cookieHeader(cookies) })).status).toBe(401);
  });
});

describe('真实 Redis：限流', () => {
  it('RedisRateLimiter 真的在 Redis 上计数，并在超限后拒绝', async () => {
    const limiter = new RedisRateLimiter(redis);
    const key = `ratelimit:auth:it:${randomBytes(6).toString('hex')}`;
    const policy = { limit: 3, windowSeconds: 60 };

    for (let i = 1; i <= 3; i += 1) {
      const result = await limiter.consume(key, policy);
      expect(result.allowed, `第 ${i} 次`).toBe(true);
      expect(result.remaining).toBe(3 - i);
    }

    const blocked = await limiter.consume(key, policy);
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
  });

  it('★ 计数器键必须带 TTL：否则该用户会被永久限流', async () => {
    const limiter = new RedisRateLimiter(redis);
    const key = `ratelimit:auth:it:ttl:${randomBytes(6).toString('hex')}`;

    await limiter.consume(key, { limit: 5, windowSeconds: 120 });
    const ttl = await redis.pttl(key);

    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(120_000);
  });

  it('超限后接口返回 429（走真实 Redis 计数）', async () => {
    // 直接构造一个超限的键：用与实现相同的 key 规则
    const { rateLimitKey, rateLimitSubject } = await import('../src/modules/auth/rate-limiter');
    const subject = rateLimitSubject('flood@signal.test');
    for (const scope of ['otp:request:email', 'otp:request:ip']) {
      for (let i = 0; i < 50; i += 1) {
        await redis.incr(rateLimitKey(scope, subject));
      }
    }

    const response = await post('/api/v1/auth/email/request-code', { email: 'flood@signal.test' });
    expect(response.status).toBe(429);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('RATE_LIMITED');

    await clearRateLimitKeys();
  });

  it('Redis 不可用时 fail-closed：报错而不是静默放行，且错误被收口到回调', async () => {
    const errors: Error[] = [];
    const deadClient = createRedisClient('redis://127.0.0.1:1', (error) => errors.push(error));
    const limiter = new RedisRateLimiter(deadClient);

    await expect(
      limiter.consume('ratelimit:auth:it:dead', { limit: 1, windowSeconds: 60 }),
    ).rejects.toBeTruthy();

    // 连接错误交给回调（生产装配里是脱敏 logger），不会打到 stderr
    expect(errors.length).toBeGreaterThan(0);

    deadClient.disconnect();
  });
});
