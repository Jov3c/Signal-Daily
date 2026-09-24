/**
 * Sources 模块的测试应用装配。
 *
 * 关键点：**它不是「只挂一个 controller 再跳过守卫」**。
 * 这里挂的是真实的 `SourcesModule`（内部 import 了 `AuthModule`），
 * 因此走的是完整链路：
 *
 *   真实 HTTP → 真实 AdminGuard → 真实 JWT 校验 → 真实会话查询 → 控制器
 *             → 真实 AppErrorFilter（统一错误封套）
 *
 * 只把**外部依赖**换成替身：MySQL（仓储）、Redis（入队）、网络（探测）、时钟。
 * 于是 401 / 403 / 撤权即时生效这类行为是被真正验证到的，
 * 而不是「我假设守卫会拦住」。
 */

import { createLogger } from '@signal/logger';
import { API_PREFIX, REQUEST_ID_HEADER, UserRole } from '@signal/contracts';
import { Test } from '@nestjs/testing';
import type { INestApplication, Type } from '@nestjs/common';
import { SourcesModule } from '../../src/modules/sources/module';
import { SOURCE_CLOCK } from '../../src/modules/sources/clock';
import { SOURCE_REPOSITORY } from '../../src/modules/sources/repository';
import { SOURCE_FETCH_ENQUEUER } from '../../src/modules/sources/source-enqueuer';
import { SOURCE_TESTER, SOURCE_TESTER_DEPS } from '../../src/modules/sources/source-tester';
import { SOURCE_CONFIG, type SourceConfig } from '../../src/modules/sources/source.config';
import { AUTH_CONFIG } from '../../src/modules/auth/auth.config';
import { CLOCK } from '../../src/modules/auth/clock';
import { GITHUB_CLIENT } from '../../src/modules/auth/github.client';
import { MAIL_SENDER } from '../../src/modules/auth/mail-sender';
import { OTP_CODE_GENERATOR } from '../../src/modules/auth/otp.service';
import { RATE_LIMITER } from '../../src/modules/auth/rate-limiter';
import { REDIS_CLIENT } from '../../src/modules/auth/redis-rate-limiter';
import { AUTH_REPOSITORY } from '../../src/modules/auth/repository';
import { USER_REPOSITORY } from '../../src/modules/users/user.repository';
import { APP_LOGGER } from '../../src/common/logger/app-logger';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import {
  FakeClock,
  FakeGithubClient,
  FakeMailSender,
  FakeRateLimiter,
  InMemoryAuthRepository,
  InMemoryUserRepository,
  createTestAuthConfig,
} from './fakes';
import {
  FakeSourceClock,
  FakeSourceFetchEnqueuer,
  FakeSourceTester,
  InMemorySourceRepository,
} from './source-fakes';
import { createMemoryStream, type MemoryLogStream } from '@signal/test-utils';
import { cookieHeader, setCookies } from './test-app';

/** 测试里固定使用的验证码。 */
export const TEST_OTP_CODE = '123456';

/** 测试用管理员邮箱。 */
export const TEST_ADMIN_EMAIL = 'admin@signal.test';

/** 测试用普通用户邮箱。 */
export const TEST_USER_EMAIL = 'reader@signal.test';

/** 一份自洽的 SourceConfig：不依赖任何真实 env。 */
export function createTestSourceConfig(overrides: Partial<SourceConfig> = {}): SourceConfig {
  return {
    nodeEnv: 'test',
    fetchTimeoutMs: 1_000,
    fetchMaxBytes: 65_536,
    xApiBearerToken: null,
    githubToken: null,
    redisUrl: 'redis://127.0.0.1:6390',
    ...overrides,
  };
}

export type SourcesTestApp = {
  app: INestApplication;
  baseUrl: string;
  request(path: string, init?: RequestInit & { cookie?: string }): Promise<Response>;
  sources: InMemorySourceRepository;
  tester: FakeSourceTester;
  enqueuer: FakeSourceFetchEnqueuer;
  clock: FakeSourceClock;
  userRepository: InMemoryUserRepository;
  authRepository: InMemoryAuthRepository;
  mail: FakeMailSender;
  logStream: MemoryLogStream;
  config: SourceConfig;
  /** 以指定邮箱 + 角色走完整 OTP 登录，返回可直接用于请求的 Cookie 头。 */
  login(email: string, role?: UserRole): Promise<string>;
  /** 改库里的角色 —— 用来验证「授权按库里当前角色判」。 */
  setRole(userId: string, role: UserRole): void;
  close(): Promise<void>;
};

export async function createSourcesTestApp(
  options: {
    sourceConfig?: Partial<SourceConfig>;
    probeControllers?: Type<unknown>[];
  } = {},
): Promise<SourcesTestApp> {
  const authConfig = createTestAuthConfig();
  const config = createTestSourceConfig(options.sourceConfig);

  const authRepository = new InMemoryAuthRepository();
  const userRepository = new InMemoryUserRepository();
  const mail = new FakeMailSender();
  const sources = new InMemorySourceRepository();
  const tester = new FakeSourceTester();
  const enqueuer = new FakeSourceFetchEnqueuer();
  const clock = new FakeSourceClock();
  const logStream = createMemoryStream();
  authRepository.users = userRepository;

  const moduleRef = await Test.createTestingModule({
    imports: [SourcesModule],
    controllers: options.probeControllers ?? [],
  })
    .overrideProvider(SOURCE_CONFIG)
    .useValue(config)
    .overrideProvider(SOURCE_REPOSITORY)
    .useValue(sources)
    .overrideProvider(SOURCE_TESTER)
    .useValue(tester)
    .overrideProvider(SOURCE_FETCH_ENQUEUER)
    .useValue(enqueuer)
    .overrideProvider(SOURCE_CLOCK)
    .useValue(clock)
    .overrideProvider(SOURCE_TESTER_DEPS)
    .useValue({})
    // 以下是 Auth 模块的依赖，同样换成替身：不碰 MySQL / Redis / 网络。
    .overrideProvider(AUTH_CONFIG)
    .useValue(authConfig)
    .overrideProvider(AUTH_REPOSITORY)
    .useValue(authRepository)
    .overrideProvider(USER_REPOSITORY)
    .useValue(userRepository)
    .overrideProvider(RATE_LIMITER)
    .useValue(new FakeRateLimiter())
    .overrideProvider(CLOCK)
    .useValue(new FakeClock())
    .overrideProvider(OTP_CODE_GENERATOR)
    .useValue(() => TEST_OTP_CODE)
    .overrideProvider(MAIL_SENDER)
    .useValue(mail)
    .overrideProvider(GITHUB_CLIENT)
    .useValue(new FakeGithubClient(true))
    .overrideProvider(APP_LOGGER)
    .useValue(createLogger({ service: 'api-test', level: 'info', destination: logStream }))
    .overrideProvider(REDIS_CLIENT)
    .useValue({ eval: async () => [1, 1000], quit: async () => 'OK' })
    .overrideProvider(PrismaService)
    .useValue({})
    .compile();

  const app = moduleRef.createNestApplication({ logger: false });
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

  const login = async (email: string, role: UserRole = UserRole.ADMIN): Promise<string> => {
    const existing = await userRepository.findByEmail(email);
    if (existing === null) userRepository.seed({ email, role });
    else existing.role = role;

    await request('/api/v1/auth/email/request-code', {
      method: 'POST',
      body: JSON.stringify({ email }),
    });
    const verify = await request('/api/v1/auth/email/verify', {
      method: 'POST',
      body: JSON.stringify({ email, code: mail.latestCode() }),
    });
    if (!verify.ok) {
      throw new Error(`登录失败：${verify.status} ${await verify.text()}`);
    }
    return cookieHeader(setCookies(verify));
  };

  return {
    app,
    baseUrl,
    request,
    sources,
    tester,
    enqueuer,
    clock,
    userRepository,
    authRepository,
    mail,
    logStream,
    config,
    login,
    setRole: (userId, role) => {
      const user = userRepository.users.get(userId);
      if (user === undefined) throw new Error(`用户不存在：${userId}`);
      user.role = role;
    },
    close: async () => {
      await app.close();
    },
  };
}

/** 取响应里的 `requestId` 头（错误封套断言用）。 */
export function requestIdOf(response: Response): string | undefined {
  return response.headers.get(REQUEST_ID_HEADER) ?? undefined;
}
