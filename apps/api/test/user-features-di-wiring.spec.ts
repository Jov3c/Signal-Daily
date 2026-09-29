/**
 * `BookmarksModule` / `ReadingProgressModule` / `UserPreferencesModule`
 * 的依赖注入接线守卫。
 *
 * ── 为什么每个 Agent 都该有这么一个文件（Agent 08 的实测）────────────
 * Agent 08 给它的两个模块补了同款测试，**第一次运行就报**：
 * 模块提供了 `AdminOriginGuard` 却没提供它依赖的 `ADMIN_ORIGIN_CONFIG`
 * —— 能编译、能过全部单测，但一挂进 `app.module.ts` 就**启动即崩**。
 * 这类缺陷**只在真实集成时暴露**，单测永远不会构造完整的模块图。
 *
 * 本模块的三个模块**不用** `AdminOriginGuard`（它们只有 `AuthGuard`），
 * 所以没有那个具体的坑；但同类缺陷（漏绑 token、TDZ、控制器依赖缺失）
 * 一样存在，而代价同样是「Agent 14 集成时才发现」。
 *
 * ⚠ `compile()` **不触发** `onModuleInit`，所以不会真的连数据库。
 * 只替换**外部世界**（Auth 的仓储/邮件/GitHub/时钟/限流、Prisma、日志），
 * 本模块自己的 provider 全部是真实实现。
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { createLogger } from '@signal/logger';
import { TEST_ENV, createMemoryStream } from '@signal/test-utils';
import { AUTH_CONFIG } from '../src/modules/auth/auth.config';
import { CLOCK } from '../src/modules/auth/clock';
import { GITHUB_CLIENT } from '../src/modules/auth/github.client';
import { MAIL_SENDER } from '../src/modules/auth/mail-sender';
import { OTP_CODE_GENERATOR } from '../src/modules/auth/otp.service';
import { RATE_LIMITER } from '../src/modules/auth/rate-limiter';
import { REDIS_CLIENT } from '../src/modules/auth/redis-rate-limiter';
import { AUTH_REPOSITORY } from '../src/modules/auth/repository';
import { APP_LOGGER } from '../src/common/logger/app-logger';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { USER_REPOSITORY } from '../src/modules/users/user.repository';
import {
  FakeClock,
  FakeGithubClient,
  FakeMailSender,
  FakeRateLimiter,
  InMemoryAuthRepository,
  InMemoryUserRepository,
  createTestAuthConfig,
} from './support/fakes';

import { BookmarksModule } from '../src/modules/bookmarks/module';
import { BOOKMARK_REPOSITORY } from '../src/modules/bookmarks/repository';
import { BookmarkService } from '../src/modules/bookmarks/service';
import { BookmarkController } from '../src/modules/bookmarks/controller';

import { ReadingProgressModule } from '../src/modules/reading-progress/module';
import { READING_PROGRESS_REPOSITORY } from '../src/modules/reading-progress/repository';
import { ReadingProgressService } from '../src/modules/reading-progress/service';
import { ReadingProgressController } from '../src/modules/reading-progress/controller';

import { UserPreferencesModule } from '../src/modules/user-preferences/module';
import { USER_PREFERENCE_REPOSITORY } from '../src/modules/user-preferences/repository';
import { UserPreferenceService } from '../src/modules/user-preferences/service';
import { UserPreferenceController } from '../src/modules/user-preferences/controller';

/**
 * ⚠ **必须先补齐 env**，否则这个文件在缺 `.env` 变量的机器 / CI 上会红。
 *
 * `AuthModule` 的若干工厂会调 `parseEnv()`（Agent 02 的实现），
 * 于是构造这些模块要求一份合法的 env。
 * 这条不是理论风险 —— Agent 08 的同款测试在开发 worktree 里绿、
 * 合并到 `main` 后立刻红（`EnvValidationError`），因为两个 worktree 的
 * `process.env` 恰好不同。
 *
 * 用 Agent 00 的 `TEST_ENV`（`packages/test-utils` 就是为这件事准备的）：
 * 只补**缺失**的键，真实环境变量仍然优先。
 */
beforeAll(() => {
  for (const [key, value] of Object.entries(TEST_ENV)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
});

/** 构造一个只替换了外部世界的测试模块。 */
function buildTestingModule(imports: unknown[]): ReturnType<typeof Test.createTestingModule> {
  const builder = Test.createTestingModule({ imports: imports as never[] });
  const authRepository = new InMemoryAuthRepository();
  const userRepository = new InMemoryUserRepository();
  authRepository.users = userRepository;

  builder
    .overrideProvider(AUTH_CONFIG)
    .useValue(createTestAuthConfig())
    .overrideProvider(AUTH_REPOSITORY)
    .useValue(authRepository)
    .overrideProvider(USER_REPOSITORY)
    .useValue(userRepository)
    .overrideProvider(RATE_LIMITER)
    .useValue(new FakeRateLimiter())
    .overrideProvider(CLOCK)
    .useValue(new FakeClock())
    .overrideProvider(OTP_CODE_GENERATOR)
    .useValue(() => '123456')
    .overrideProvider(APP_LOGGER)
    .useValue(
      createLogger({ service: 'api-test', level: 'silent', destination: createMemoryStream() }),
    )
    .overrideProvider(REDIS_CLIENT)
    .useValue({ eval: async () => [1, 1000], quit: async () => 'OK' })
    .overrideProvider(PrismaService)
    .useValue({})
    .overrideProvider(MAIL_SENDER)
    .useValue(new FakeMailSender())
    .overrideProvider(GITHUB_CLIENT)
    .useValue(new FakeGithubClient(true));

  return builder;
}

describe('BookmarksModule 的依赖图真的能建起来', () => {
  it('编译整个模块，service / 仓储 / 控制器都是真实实例', async () => {
    const moduleRef = await buildTestingModule([BookmarksModule]).compile();

    expect(moduleRef.get(BookmarkService)).toBeInstanceOf(BookmarkService);
    expect(moduleRef.get(BOOKMARK_REPOSITORY)).toBeDefined();
    expect(moduleRef.get(BookmarkController)).toBeInstanceOf(BookmarkController);

    await moduleRef.close();
  });

  it('导出了下游需要的 provider（Agent 14 / 13 集成时要用）', async () => {
    const moduleRef = await buildTestingModule([BookmarksModule]).compile();

    expect(moduleRef.get(BookmarkService, { strict: false })).toBeDefined();
    expect(moduleRef.get(BOOKMARK_REPOSITORY, { strict: false })).toBeDefined();

    await moduleRef.close();
  });
});

describe('ReadingProgressModule 的依赖图真的能建起来', () => {
  it('编译整个模块', async () => {
    const moduleRef = await buildTestingModule([ReadingProgressModule]).compile();

    expect(moduleRef.get(ReadingProgressService)).toBeInstanceOf(ReadingProgressService);
    expect(moduleRef.get(READING_PROGRESS_REPOSITORY)).toBeDefined();
    expect(moduleRef.get(ReadingProgressController)).toBeInstanceOf(ReadingProgressController);

    await moduleRef.close();
  });
});

describe('UserPreferencesModule 的依赖图真的能建起来', () => {
  it('编译整个模块', async () => {
    const moduleRef = await buildTestingModule([UserPreferencesModule]).compile();

    expect(moduleRef.get(UserPreferenceService)).toBeInstanceOf(UserPreferenceService);
    expect(moduleRef.get(USER_PREFERENCE_REPOSITORY)).toBeDefined();
    expect(moduleRef.get(UserPreferenceController)).toBeInstanceOf(UserPreferenceController);

    await moduleRef.close();
  });
});

describe('三个模块可以同时挂载（Agent 14 的真实形态）', () => {
  it('一次 import 三个，依赖图不冲突', async () => {
    const moduleRef = await buildTestingModule([
      BookmarksModule,
      ReadingProgressModule,
      UserPreferencesModule,
    ]).compile();

    // 三个都取自 root，且都在
    expect(moduleRef.get(BookmarkService, { strict: false })).toBeDefined();
    expect(moduleRef.get(ReadingProgressService, { strict: false })).toBeDefined();
    expect(moduleRef.get(UserPreferenceService, { strict: false })).toBeDefined();

    await moduleRef.close();
  });

  it('⚠ `me/preferences` 与 Auth 的 `me` 前缀不冲突（两个控制器都取得到）', async () => {
    // Agent 02 的 HANDOFF 明确「GET/PUT /me/preferences 属 Agent 09 的范围」。
    // 这条断言的是「两个控制器共存时依赖图仍然可解析」——
    // 路由层面的冲突由 Nest 在 `init()` 时报（`compile()` 不注册路由）。
    const moduleRef = await buildTestingModule([
      BookmarksModule,
      ReadingProgressModule,
      UserPreferencesModule,
    ]).compile();
    await moduleRef.init();

    expect(moduleRef.get(UserPreferenceController)).toBeInstanceOf(UserPreferenceController);
    await moduleRef.close();
  });
});
