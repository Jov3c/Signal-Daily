/**
 * `DailyModule` —— 日报编辑面与公开读取面的装配。
 *
 * ⚠ **不要把它挂到 `apps/api/src/app.module.ts`** —— 根注册由 Agent 14
 * 统一完成（Agent 00 HANDOFF Integration Notes 第 3 条）。
 * 下游（Agent 10 的公开 API 聚合、Agent 12 的后台）在自己模块里
 * `imports: [DailyModule]` 即可复用 `DailyService`。
 *
 * `imports: [AuthModule]` 是**必需的**：`AdminGuard` 以及它依赖的
 * `ACCESS_TOKEN_VERIFIER` / `AUTH_SESSION_LOOKUP` 都由 AuthModule 导出，
 * 守卫的依赖要在**使用方模块**的注入上下文里可解析（Agent 02 的说明）。
 *
 * 全部外部依赖都是可 override 的 provider token，因此单元测试可以在
 * 没有 MySQL、没有网络的情况下跑完整条编辑/发布流程。
 */

import { Module, type OnModuleInit } from '@nestjs/common';
import { createLogger } from '@signal/logger';
import { AuthModule } from '../auth/auth.module';
import {
  ADMIN_ORIGIN_CONFIG,
  AdminOriginGuard,
  createAdminOriginConfig,
} from '../admin-review/admin-origin.guard';
import { AdminDailyController, PublicDailyController } from './controller';
import { DAILY_CLOCK, SystemDailyClock } from './clock';
import { DAILY_REPOSITORY } from './repository';
import { PrismaDailyRepository } from './prisma-daily.repository';
import { DAILY_LOGGER, DailyService } from './service';
import { assertStateMachineCoversContract } from './state';
import { PrismaService } from '../../common/prisma/prisma.service';

@Module({
  imports: [AuthModule],
  controllers: [AdminDailyController, PublicDailyController],
  providers: [
    {
      // 显式工厂而不是 `useClass`：`PrismaDailyRepository` 的构造函数
      // 要一个 `PrismaService`，而它在 `PrismaModule`（`@Global`）里。
      // 用 `useClass` 也能解析，但工厂让「它依赖 Prisma」这件事在装配处可见。
      provide: DAILY_REPOSITORY,
      useFactory: (prisma: PrismaService) => new PrismaDailyRepository(prisma),
      inject: [PrismaService],
    },
    { provide: DAILY_CLOCK, useClass: SystemDailyClock },
    { provide: DAILY_LOGGER, useFactory: () => createLogger({ service: 'api' }) },
    // `docs/14`：敏感 Admin mutation 进行 Origin check
    //（复用 Agent 07 的守卫，见其 CCR 第 7 项）。
    //
    // ⚠ **`ADMIN_ORIGIN_CONFIG` 必须一起提供** —— 守卫的构造参数依赖它。
    // 少了这一行，本模块能编译、能通过所有单测，但一挂到根模块就启动即崩。
    // 由 `apps/api/test/publishing-di-wiring.spec.ts` 守住。
    { provide: ADMIN_ORIGIN_CONFIG, useFactory: () => createAdminOriginConfig() },
    AdminOriginGuard,
    DailyService,
  ],
  exports: [DailyService, DAILY_REPOSITORY],
})
export class DailyModule implements OnModuleInit {
  /**
   * 启动期自检状态机与契约的一致性。
   *
   * ⚠ **这个调用点是被 §23 独立审查逼出来的。**
   * `assertStateMachineCoversContract()` 原先**零调用点** —— 一个死守卫。
   * 讽刺的是本模块在 `publishing/queue.ts` 的文件头**逐字**写着
   * 「必须真的被调用，否则就是死代码 —— Agent 06 的独立审查正是在那里发现
   * `assertQueueMapping()` 从来没有调用点」，却在同一交付里造了个新的。
   *
   * 它的价值是**运行期**的那一半：`Record<DailyEditionStatus, …>` 保证了
   * 「不多不少」，但如果有人把枚举的**值**改了而不改结构（例如
   * `DRAFT = 'DRAFT_V2'`），`Record` 查不出来，而这里会。
   */
  onModuleInit(): void {
    assertStateMachineCoversContract();
  }
}
