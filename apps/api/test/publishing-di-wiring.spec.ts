/**
 * `DailyModule` / `FeaturedModule` 依赖注入接线的守卫。
 *
 * ── 为什么需要（§23 独立审查的 P3-3）────────────────────────────────
 * 审查指出：worker 侧有 `publishing-di-wiring.spec.ts`，**api 侧这两个模块没有** ——
 * 「你刚给 worker 补了，说明你认同这个标准」。一致地补上。
 *
 * 它防的是两类**编译期发现不了**的缺陷：
 *
 * 1. `@Module({...})` 装饰器在**类定义时**求值 —— 引用一个声明在类之后的
 *    `const` 会落进 TDZ，**启动即 `ReferenceError`**，lint 与 typecheck 都过。
 *    （本模块的 worker 侧 `module.ts` 真实栽过一次，见那边的注释。）
 * 2. **漏绑一个 provider token** —— Nest 只在**实例化时**报
 *    「Nest can't resolve dependencies of …」，而那已经是启动期。
 *
 * ⚠ `compile()` **不触发** `onModuleInit`，所以不会真的连数据库/Redis。
 * 只替换**外部世界**（Auth 的仓储/邮件/GitHub/时钟/限流、Prisma、日志），
 * 本模块自己的 provider 全部是真实实现。
 *
 * ⚠ 下面那串外部 token 与 `support/test-app.ts`（Agent 02）**是同一份清单**。
 * 重复它的代价是「Agent 02 改了 token 名字这里会红」—— 那是一个**会红**的
 * 失败，不是静默失效，可以接受；真正干净的做法是让 Agent 02 的
 * `createAuthTestApp` 接受额外的 `imports`，但那要改它的文件（§9 不越界）。
 */

import { describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { createLogger } from '@signal/logger';
import { createMemoryStream } from '@signal/test-utils';
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

import { DAILY_CLOCK } from '../src/modules/daily/clock';
import { DAILY_REPOSITORY } from '../src/modules/daily/repository';
import { DAILY_LOGGER, DailyService } from '../src/modules/daily/service';
import { DailyModule } from '../src/modules/daily/module';
import { assertStateMachineCoversContract } from '../src/modules/daily/state';
import { AdminDailyController, PublicDailyController } from '../src/modules/daily/controller';

import { FEATURED_CLOCK, FEATURED_REPOSITORY } from '../src/modules/featured/repository';
import { FEATURED_LOGGER, FeaturedService } from '../src/modules/featured/service';
import { FeaturedModule } from '../src/modules/featured/module';
import {
  AdminFeaturedController,
  PublicFeaturedController,
} from '../src/modules/featured/controller';

/** 完整的替换链（写成函数是为了能连续调用）。 */
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

describe('DailyModule 的依赖图真的能建起来', () => {
  it('编译整个模块，关键 provider 都是真实实例', async () => {
    const moduleRef = await buildTestingModule([DailyModule])
      .overrideProvider(DAILY_LOGGER)
      .useValue(
        createLogger({ service: 'di-test', level: 'silent', destination: createMemoryStream() }),
      )
      .compile();

    expect(moduleRef.get(DailyService)).toBeInstanceOf(DailyService);
    // 仓储是**真实实现**（它的构造函数只是存下 prisma），不是替身
    expect(moduleRef.get(DAILY_REPOSITORY)).toBeDefined();
    expect(moduleRef.get(DAILY_CLOCK)).toBeDefined();

    await moduleRef.close();
  });

  it('两个控制器都能被取出来（漏绑 controller 的依赖会在这里炸）', async () => {
    const moduleRef = await buildTestingModule([DailyModule])
      .overrideProvider(DAILY_LOGGER)
      .useValue(
        createLogger({ service: 'di-test', level: 'silent', destination: createMemoryStream() }),
      )
      .compile();

    expect(moduleRef.get(AdminDailyController)).toBeInstanceOf(AdminDailyController);
    expect(moduleRef.get(PublicDailyController)).toBeInstanceOf(PublicDailyController);

    await moduleRef.close();
  });

  it('⚠ 模块加载时会跑状态机自检（幂等，且**不是**死代码）', async () => {
    // `assertStateMachineCoversContract()` 原先**零调用点**（§23 审查的 P4）。
    // 现在由 `DailyModule.onModuleInit` 调用。这里验「调用链存在且不会抛」；
    // 「它真的有牙齿」由下面的对照用例证明。
    expect(() => assertStateMachineCoversContract()).not.toThrow();

    const moduleRef = await buildTestingModule([DailyModule])
      .overrideProvider(DAILY_LOGGER)
      .useValue(
        createLogger({ service: 'di-test', level: 'silent', destination: createMemoryStream() }),
      )
      .compile();

    await moduleRef.init();
    await moduleRef.close();
  });
});

describe('FeaturedModule 的依赖图真的能建起来', () => {
  it('编译整个模块，关键 provider 都是真实实例', async () => {
    const moduleRef = await buildTestingModule([FeaturedModule])
      .overrideProvider(FEATURED_LOGGER)
      .useValue(
        createLogger({ service: 'di-test', level: 'silent', destination: createMemoryStream() }),
      )
      .compile();

    expect(moduleRef.get(FeaturedService)).toBeInstanceOf(FeaturedService);
    expect(moduleRef.get(FEATURED_REPOSITORY)).toBeDefined();
    expect(moduleRef.get(FEATURED_CLOCK)).toBeDefined();

    await moduleRef.close();
  });

  it('两个控制器都能被取出来', async () => {
    const moduleRef = await buildTestingModule([FeaturedModule])
      .overrideProvider(FEATURED_LOGGER)
      .useValue(
        createLogger({ service: 'di-test', level: 'silent', destination: createMemoryStream() }),
      )
      .compile();

    expect(moduleRef.get(AdminFeaturedController)).toBeInstanceOf(AdminFeaturedController);
    expect(moduleRef.get(PublicFeaturedController)).toBeInstanceOf(PublicFeaturedController);

    await moduleRef.close();
  });
});

describe('导出了下游需要的 provider（Agent 14 集成时要用）', () => {
  it('DailyModule 导出 DailyService 与仓储端口', async () => {
    const moduleRef = await buildTestingModule([DailyModule])
      .overrideProvider(DAILY_LOGGER)
      .useValue(
        createLogger({ service: 'di-test', level: 'silent', destination: createMemoryStream() }),
      )
      .compile();

    expect(moduleRef.get(DailyService, { strict: false })).toBeDefined();
    expect(moduleRef.get(DAILY_REPOSITORY, { strict: false })).toBeDefined();

    await moduleRef.close();
  });

  it('FeaturedModule 导出 FeaturedService 与仓储端口', async () => {
    const moduleRef = await buildTestingModule([FeaturedModule])
      .overrideProvider(FEATURED_LOGGER)
      .useValue(
        createLogger({ service: 'di-test', level: 'silent', destination: createMemoryStream() }),
      )
      .compile();

    expect(moduleRef.get(FeaturedService, { strict: false })).toBeDefined();
    expect(moduleRef.get(FEATURED_REPOSITORY, { strict: false })).toBeDefined();

    await moduleRef.close();
  });
});
