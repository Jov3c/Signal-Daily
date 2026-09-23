/**
 * 测试用 Nest 应用装配。
 *
 * 用 `Test.createTestingModule({ imports: [AuthModule] })` + `overrideProvider`
 * 把**全部**外部依赖（DB / Redis / 邮件 / GitHub / 时钟 / 随机数）换成替身：
 *   - 不需要 MySQL；
 *   - 不需要 Redis；
 *   - 不需要网络；
 *   - 验证码确定（`123456`），因此可以断言到具体行为而不是「大概能跑」。
 *
 * 这是真的 HTTP：`app.listen(0)` + `fetch()`，走完 Nest 的
 * 路由 → 守卫 → 控制器 → 异常过滤器整条链，与生产同一套代码路径。
 */

import { createLogger } from '@signal/logger';
import { API_PREFIX, REQUEST_ID_HEADER } from '@signal/contracts';
import { Test } from '@nestjs/testing';
import type { INestApplication, Type } from '@nestjs/common';
import { AuthModule } from '../../src/modules/auth/auth.module';
import { AUTH_CONFIG, type AuthConfig } from '../../src/modules/auth/auth.config';
import { CLOCK } from '../../src/modules/auth/clock';
import { GITHUB_CLIENT } from '../../src/modules/auth/github.client';
import { MAIL_SENDER } from '../../src/modules/auth/mail-sender';
import { OTP_CODE_GENERATOR } from '../../src/modules/auth/otp.service';
import { RATE_LIMITER } from '../../src/modules/auth/rate-limiter';
import { REDIS_CLIENT } from '../../src/modules/auth/redis-rate-limiter';
import { AUTH_REPOSITORY } from '../../src/modules/auth/repository';
import { APP_LOGGER } from '../../src/common/logger/app-logger';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { USER_REPOSITORY } from '../../src/modules/users/user.repository';
import {
  FakeClock,
  FakeGithubClient,
  FakeMailSender,
  FakeRateLimiter,
  InMemoryAuthRepository,
  InMemoryUserRepository,
  createTestAuthConfig,
} from './fakes';
import { createMemoryStream, type MemoryLogStream } from '@signal/test-utils';

/** 测试里固定使用的验证码。 */
export const TEST_OTP_CODE = '123456';

/** 默认测试邮箱。 */
export const TEST_EMAIL = 'reader@example.com';

export type AuthTestApp = {
  app: INestApplication;
  baseUrl: string;
  /** 直接发请求；默认不跟随 302，便于断言重定向。 */
  request(path: string, init?: RequestInit & { cookie?: string }): Promise<Response>;
  authRepository: InMemoryAuthRepository;
  userRepository: InMemoryUserRepository;
  mail: FakeMailSender;
  github: FakeGithubClient;
  rateLimiter: FakeRateLimiter;
  clock: FakeClock;
  config: AuthConfig;
  logStream: MemoryLogStream;
  close(): Promise<void>;
};

export async function createAuthTestApp(
  options: {
    config?: Partial<AuthConfig>;
    githubConfigured?: boolean;
    /**
     * 依次返回的验证码。用于「重新请求后旧码失效」这类需要两个不同码的用例；
     * 用完后重复最后一个。
     */
    otpCodes?: string[];
    /**
     * 额外的探针控制器。
     *
     * 用来在**真实 HTTP** 上验证 `AuthGuard` / `AdminGuard` 的行为 ——
     * Auth 模块自己没有 admin 路由（也不该有），
     * 下游（03/07/09/12）如何套守卫由这些探针代表。
     */
    probeControllers?: Type<unknown>[];
    /**
     * 用**真实的** `FetchGithubClient` 而不是替身。
     * 用于「未配置 GitHub」这类不联网就能走完真实代码路径的用例。
     */
    realGithubClient?: boolean;
    /**
     * 用**真实的**邮件通道选择（`selectMailSender`）而不是替身。
     * 用来验证「生产 + 无 SMTP → 503」这类装配决策。
     */
    realMailSender?: boolean;
  } = {},
): Promise<AuthTestApp> {
  const config = createTestAuthConfig(options.config);
  const authRepository = new InMemoryAuthRepository();
  const userRepository = new InMemoryUserRepository();
  const mail = new FakeMailSender();
  const github = new FakeGithubClient(options.githubConfigured ?? true);
  const rateLimiter = new FakeRateLimiter();
  const clock = new FakeClock();
  const logStream = createMemoryStream();
  authRepository.users = userRepository;

  const codes = options.otpCodes ?? [TEST_OTP_CODE];
  let codeIndex = 0;
  const nextCode = (): string => codes[Math.min(codeIndex++, codes.length - 1)] ?? TEST_OTP_CODE;

  let builder = Test.createTestingModule({
    imports: [AuthModule],
    controllers: options.probeControllers ?? [],
  })
    .overrideProvider(AUTH_CONFIG)
    .useValue(config)
    .overrideProvider(AUTH_REPOSITORY)
    .useValue(authRepository)
    .overrideProvider(USER_REPOSITORY)
    .useValue(userRepository)
    .overrideProvider(RATE_LIMITER)
    .useValue(rateLimiter)
    .overrideProvider(CLOCK)
    .useValue(clock)
    .overrideProvider(OTP_CODE_GENERATOR)
    .useValue(nextCode)
    .overrideProvider(APP_LOGGER)
    .useValue(createLogger({ service: 'api-test', level: 'info', destination: logStream }))
    // 未使用的连接：直接给桩，避免测试进程里留下 ioredis / Prisma 句柄。
    .overrideProvider(REDIS_CLIENT)
    .useValue({ eval: async () => [1, 1000], quit: async () => 'OK' })
    .overrideProvider(PrismaService)
    .useValue({});

  // 邮件与 GitHub 客户端：默认都用替身；需要验证真实装配时显式关掉。
  if (!options.realMailSender) builder = builder.overrideProvider(MAIL_SENDER).useValue(mail);
  if (!options.realGithubClient) {
    builder = builder.overrideProvider(GITHUB_CLIENT).useValue(github);
  }
  const moduleRef = await builder.compile();

  const app = moduleRef.createNestApplication({ logger: false });
  // 与 bootstrap.ts 一致：前缀来自契约常量，不写字面量。
  app.setGlobalPrefix(API_PREFIX.slice(1));
  await app.listen(0, '127.0.0.1');
  const baseUrl = await app.getUrl();

  const request = async (
    path: string,
    init: RequestInit & { cookie?: string } = {},
  ): Promise<Response> => {
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
  };

  return {
    app,
    baseUrl,
    request,
    authRepository,
    userRepository,
    mail,
    github,
    rateLimiter,
    clock,
    config,
    logStream,
    close: async () => {
      await app.close();
    },
  };
}

/** 取响应的 `set-cookie` 列表。 */
export function setCookies(response: Response): string[] {
  const raw = response.headers.getSetCookie?.() ?? [];
  return raw;
}

/** 从 Set-Cookie 列表里取某个 Cookie 的值（已 URL 解码）。 */
export function cookieValue(cookies: string[], name: string): string | undefined {
  for (const cookie of cookies) {
    const [pair] = cookie.split(';');
    if (pair === undefined) continue;
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    if (pair.slice(0, eq).trim() !== name) continue;
    return decodeURIComponent(pair.slice(eq + 1).trim());
  }
  return undefined;
}

/** 把 Set-Cookie 列表拼成下一次请求的 Cookie 头。 */
export function cookieHeader(cookies: string[]): string {
  return cookies
    .map((cookie) => cookie.split(';')[0]?.trim())
    .filter((pair): pair is string => pair !== undefined && pair !== '')
    .join('; ');
}

/** 断言响应带 requestId 头。 */
export function requestIdOf(response: Response): string | undefined {
  return response.headers.get(REQUEST_ID_HEADER) ?? undefined;
}
