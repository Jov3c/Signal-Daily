/**
 * SourcesModule —— Source Registry / X 白名单的装配。
 *
 * ⚠ **不要把它挂到 `app.module.ts`** —— 根注册由 Agent 14 统一完成
 * （Agent 00 HANDOFF Integration Notes 第 3 条）。
 *
 * 下游（Agent 07 / 12）若要复用 `SourcesService` 或 `SOURCE_REPOSITORY`，
 * 在自己模块里 `imports: [SourcesModule]` 即可。
 *
 * `imports: [AuthModule]` 是**必需的**：`AdminGuard` 以及它依赖的
 * `ACCESS_TOKEN_VERIFIER` / `AUTH_SESSION_LOOKUP` 都由 AuthModule 导出，
 * 守卫的依赖要在**使用方模块**的注入上下文里可解析（Agent 02 的说明）。
 *
 * 全部外部依赖都是可 override 的 provider token，因此单元测试可以
 * 在没有 MySQL、没有 Redis、没有网络的情况下跑完整流程。
 */

import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { SourcesController } from './controller';
import { SOURCE_CLOCK, SystemSourceClock } from './clock';
import { PrismaSourceRepository } from './prisma-source.repository';
import { SOURCE_REPOSITORY } from './repository';
import {
  BullSourceFetchEnqueuer,
  SOURCE_ENQUEUER_OPTIONS,
  SOURCE_FETCH_ENQUEUER,
} from './source-enqueuer';
import { HttpSourceTester, SOURCE_TESTER, SOURCE_TESTER_DEPS } from './source-tester';
import { SOURCE_CONFIG, createSourceConfig } from './source.config';
import { SourcesService } from './service';

@Module({
  imports: [AuthModule],
  controllers: [SourcesController],
  providers: [
    { provide: SOURCE_CONFIG, useFactory: () => createSourceConfig() },
    { provide: SOURCE_REPOSITORY, useClass: PrismaSourceRepository },
    { provide: SOURCE_CLOCK, useClass: SystemSourceClock },
    // 出网依赖的替身注入点：生产为空对象（走真实 fetch / DNS / Date.now），
    // 测试 override 它就能在完全不联网的情况下跑真实解析逻辑。
    { provide: SOURCE_TESTER_DEPS, useValue: {} },
    { provide: SOURCE_TESTER, useClass: HttpSourceTester },
    // 入队选项：生产为空对象（走 ENQUEUE_TIMEOUT_MS），测试可覆盖成很短的超时。
    { provide: SOURCE_ENQUEUER_OPTIONS, useValue: {} },
    { provide: SOURCE_FETCH_ENQUEUER, useClass: BullSourceFetchEnqueuer },
    SourcesService,
  ],
  exports: [SourcesService, SOURCE_REPOSITORY, SOURCE_CLOCK],
})
export class SourcesModule {}
