/**
 * `ReadingProgressModule` —— 阅读进度的装配。
 *
 * ⚠ **不要把它挂到 `apps/api/src/app.module.ts`** —— 根注册由 Agent 14 统一完成。
 * `imports: [AuthModule]` 是必需的（`AuthGuard` 及其依赖由 AuthModule 导出）。
 */

import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ReadingProgressController } from './controller';
import { READING_PROGRESS_CLOCK, READING_PROGRESS_REPOSITORY } from './repository';
import { PrismaReadingProgressRepository } from './prisma-reading-progress.repository';
import { ReadingProgressService } from './service';

@Module({
  imports: [AuthModule],
  controllers: [ReadingProgressController],
  providers: [
    { provide: READING_PROGRESS_REPOSITORY, useClass: PrismaReadingProgressRepository },
    { provide: READING_PROGRESS_CLOCK, useFactory: () => ({ now: () => new Date() }) },
    ReadingProgressService,
  ],
  exports: [ReadingProgressService, READING_PROGRESS_REPOSITORY],
})
export class ReadingProgressModule {}
