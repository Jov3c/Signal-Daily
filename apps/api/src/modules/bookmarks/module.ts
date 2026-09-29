/**
 * `BookmarksModule` —— 收藏的装配。
 *
 * ⚠ **不要把它挂到 `apps/api/src/app.module.ts`** —— 根注册由 Agent 14 统一完成。
 *
 * `imports: [AuthModule]` 是**必需的**：`AuthGuard` 以及它依赖的
 * `ACCESS_TOKEN_VERIFIER` / `AUTH_SESSION_LOOKUP` 都由 AuthModule 导出，
 * 守卫的依赖要在**使用方模块**的注入上下文里可解析（Agent 02 的说明）。
 *
 * 全部外部依赖都是可 override 的 provider token，因此单元测试可以在
 * 没有 MySQL、没有网络的情况下跑完整条收藏流程。
 */

import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { BookmarkController } from './controller';
import { BOOKMARK_CLOCK, BOOKMARK_REPOSITORY } from './repository';
import { PrismaBookmarkRepository } from './prisma-bookmarks.repository';
import { BookmarkService } from './service';

@Module({
  imports: [AuthModule],
  controllers: [BookmarkController],
  providers: [
    { provide: BOOKMARK_REPOSITORY, useClass: PrismaBookmarkRepository },
    { provide: BOOKMARK_CLOCK, useFactory: () => ({ now: () => new Date() }) },
    BookmarkService,
  ],
  exports: [BookmarkService, BOOKMARK_REPOSITORY],
})
export class BookmarksModule {}
