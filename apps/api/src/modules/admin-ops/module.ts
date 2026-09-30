/**
 * `AdminOpsModule` —— 后台运维视图（作业 / 通知 / AI 用量）的装配。
 *
 * ⚠ **不要把它挂到 `apps/api/src/app.module.ts`** —— 根注册由 Agent 14 统一完成。
 *
 * `imports: [AuthModule]` 是**必需的**：`AdminGuard` 以及它依赖的
 * `ACCESS_TOKEN_VERIFIER` / `AUTH_SESSION_LOOKUP` 都由 AuthModule 导出，
 * 守卫的依赖要在**使用方模块**的注入上下文里可解析（Agent 02 的说明）。
 *
 * `ADMIN_ORIGIN_CONFIG` 必须在这里提供（Agent 08 的教训：少了它，
 * 模块能编译、能过全部单测，一挂进根模块就启动即崩）。
 */

import { Module } from '@nestjs/common';
import { createLogger } from '@signal/logger';
import { AuthModule } from '../auth/auth.module';
import {
  ADMIN_ORIGIN_CONFIG,
  AdminOriginGuard,
  createAdminOriginConfig,
} from '../admin-review/admin-origin.guard';
import { AiUsageController, JobsController, NotificationsController } from './controller';
import { ADMIN_OPS_REPOSITORY } from './repository';
import { PrismaAdminOpsRepository } from './prisma-admin-ops.repository';
import { ADMIN_OPS_CLOCK, ADMIN_OPS_LOGGER, AdminOpsService } from './service';

@Module({
  imports: [AuthModule],
  controllers: [JobsController, NotificationsController, AiUsageController],
  providers: [
    { provide: ADMIN_OPS_REPOSITORY, useClass: PrismaAdminOpsRepository },
    { provide: ADMIN_OPS_CLOCK, useFactory: () => ({ now: () => new Date() }) },
    { provide: ADMIN_OPS_LOGGER, useFactory: () => createLogger({ service: 'api' }) },
    { provide: ADMIN_ORIGIN_CONFIG, useFactory: () => createAdminOriginConfig() },
    AdminOriginGuard,
    AdminOpsService,
  ],
  exports: [AdminOpsService, ADMIN_OPS_REPOSITORY],
})
export class AdminOpsModule {}
