/**
 * `AdminReviewModule` —— 审核后端与证据管理的装配。
 *
 * ⚠ **不要把它挂到 `apps/api/src/app.module.ts`** —— 根注册由 Agent 14
 * 统一完成（Agent 00 HANDOFF Integration Notes 第 3 条）。
 * 下游若要复用 `ReviewService`，在自己模块里 `imports: [AdminReviewModule]` 即可。
 *
 * `imports: [AuthModule]` 是**必需的**：`AdminGuard` 以及它依赖的
 * `ACCESS_TOKEN_VERIFIER` / `AUTH_SESSION_LOOKUP` 都由 AuthModule 导出，
 * 守卫的依赖要在**使用方模块**的注入上下文里可解析（Agent 02 的说明）。
 *
 * 全部外部依赖都是可 override 的 provider token，因此单元测试可以在
 * 没有 MySQL、没有网络的情况下跑完整条审核流程。
 */

import { Inject, Module, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { createLogger } from '@signal/logger';
import { AuthModule } from '../auth/auth.module';
import { ADMIN_ORIGIN_CONFIG, AdminOriginGuard, createAdminOriginConfig } from './admin-origin.guard';
import { ADMIN_REVIEW_CLOCK, SystemAdminReviewClock } from './clock';
import { DashboardController, EvidenceController, ReviewController } from './controller';
import { EVIDENCE_LOGGER, EvidenceService } from './evidence.service';
import { NOTIFICATION_LOGGER, NotificationService } from './notification.service';
import { ADMIN_REVIEW_REPOSITORY } from './repository';
import { PrismaAdminReviewRepository } from './prisma-admin-review.repository';
import { REVIEW_LOGGER, ReviewService } from './review.service';

/**
 * 通知扫描的间隔。
 *
 * 取 60 秒：通知是**告知性**的，晚一分钟看到高分候选完全可接受；
 * 而更密的轮询只是白烧两次数据库查询。
 *
 * ⚠ 这是 **api 进程里的定时器**，与 Agent 05 在 worker 里做收尾扫描不同 ——
 * 取舍与理由见 `notification.service.ts` 的文件头，**已提 CCR**。
 */
export const NOTIFICATION_SCAN_INTERVAL_MS = 60_000;

@Module({
  imports: [AuthModule],
  controllers: [ReviewController, EvidenceController, DashboardController],
  providers: [
    { provide: ADMIN_REVIEW_REPOSITORY, useClass: PrismaAdminReviewRepository },
    { provide: ADMIN_REVIEW_CLOCK, useClass: SystemAdminReviewClock },
    {
      provide: REVIEW_LOGGER,
      useFactory: () => createLogger({ service: 'api' }),
    },
    {
      provide: EVIDENCE_LOGGER,
      useFactory: () => createLogger({ service: 'api' }),
    },
    {
      provide: NOTIFICATION_LOGGER,
      useFactory: () => createLogger({ service: 'api' }),
    },
    { provide: ADMIN_ORIGIN_CONFIG, useFactory: () => createAdminOriginConfig() },
    // `docs/14`：「敏感 Admin mutation 进行 Origin check」。
    AdminOriginGuard,
    ReviewService,
    EvidenceService,
    NotificationService,
  ],
  exports: [ReviewService, EvidenceService, NotificationService, ADMIN_REVIEW_REPOSITORY],
})
export class AdminReviewModule implements OnModuleInit, OnModuleDestroy {
  private scanTimer: NodeJS.Timeout | null = null;

  constructor(
    @Inject(NotificationService) private readonly notifications: NotificationService,
    @Inject(NOTIFICATION_LOGGER) private readonly logger: ReturnType<typeof createLogger>,
  ) {}

  onModuleInit(): void {
    // ⚠ 刻意**不加分布式锁**：扫描是幂等的（靠 `(type, targetUrl)` 去重，
    // 且 `admin_notifications` 的写入本身没有唯一约束但业务上只会在
    // 「还没通知过」时写）。两个实例同时跑只会重复一次相等的判断。
    this.scanTimer = setInterval(() => {
      void this.notifications
        .scan()
        .catch((error: unknown) => this.logger.error({ err: error }, 'notification scan failed'));
    }, NOTIFICATION_SCAN_INTERVAL_MS);
  }

  onModuleDestroy(): void {
    if (this.scanTimer !== null) clearInterval(this.scanTimer);
    this.scanTimer = null;
  }
}
