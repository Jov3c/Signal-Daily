/**
 * CommonModule —— API 层的公共地基。
 *
 * 提供并全局导出：
 *   - `APP_LOGGER`：脱敏 logger（`apps/api/src/main.ts` 用它接管 Nest 内部日志）。
 *   - `APP_FILTER`：统一错误封套过滤器（`docs/02`）。
 *   - `PrismaService`（经由 `PrismaModule`，同样 `@Global()`）。
 *
 * 归属：Agent 02 落地。**下游 Agent 请复用，不要重复注册全局过滤器。**
 * Agent 14 集成时只需 `imports: [CommonModule, AuthModule, ...]` 即可。
 */

import { Global, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { PrismaModule } from './prisma/prisma.module';
import { AppErrorFilter } from './http/app-error.filter';
import { APP_LOGGER, createAppLogger } from './logger/app-logger';

@Global()
@Module({
  imports: [PrismaModule],
  providers: [
    { provide: APP_LOGGER, useFactory: () => createAppLogger() },
    { provide: APP_FILTER, useClass: AppErrorFilter },
  ],
  exports: [APP_LOGGER, PrismaModule],
})
export class CommonModule {}
