/**
 * `FeaturedModule` —— 精选的装配。
 *
 * ⚠ **不要把它挂到 `apps/api/src/app.module.ts`** —— 根注册由 Agent 14 统一完成。
 * 下游（Agent 10 的公开 API、Agent 12 的后台）在自己模块里
 * `imports: [FeaturedModule]` 即可复用 `FeaturedService`。
 *
 * `imports: [AuthModule]` 是必需的：AdminGuard 及其依赖由 AuthModule 导出。
 */

import { Module } from '@nestjs/common';
import { createLogger } from '@signal/logger';
import { AuthModule } from '../auth/auth.module';
import {
  ADMIN_ORIGIN_CONFIG,
  AdminOriginGuard,
  createAdminOriginConfig,
} from '../admin-review/admin-origin.guard';
import { AdminFeaturedController, PublicFeaturedController } from './controller';
import { FEATURED_CLOCK, FEATURED_REPOSITORY, type FeaturedRepository } from './repository';
import { PrismaFeaturedRepository } from './prisma-featured.repository';
import { FEATURED_LOGGER, FeaturedService } from './service';
import { PrismaService } from '../../common/prisma/prisma.service';

@Module({
  imports: [AuthModule],
  controllers: [AdminFeaturedController, PublicFeaturedController],
  providers: [
    {
      provide: FEATURED_REPOSITORY,
      useFactory: (prisma: PrismaService): FeaturedRepository =>
        new PrismaFeaturedRepository(prisma),
      inject: [PrismaService],
    },
    // 系统时钟（可 override 以便测试断言 `publishedAt`）。
    { provide: FEATURED_CLOCK, useFactory: () => ({ now: () => new Date() }) },
    { provide: FEATURED_LOGGER, useFactory: () => createLogger({ service: 'api' }) },
    // `docs/14`：敏感 Admin mutation 进行 Origin check（复用 Agent 07 的守卫）。
    //
    // ⚠ **`ADMIN_ORIGIN_CONFIG` 必须一起提供** —— 守卫的构造参数依赖它。
    // 少了这一行，本模块**能编译、能通过所有单测**，但一挂到根模块就
    // 启动即崩（「Nest can't resolve dependencies of the AdminOriginGuard」）。
    // `apps/api/test/publishing-di-wiring.spec.ts` 就是为此加的
    //（§23 独立审查的 P3-3，加完立刻抓到了它）。
    { provide: ADMIN_ORIGIN_CONFIG, useFactory: () => createAdminOriginConfig() },
    AdminOriginGuard,
    FeaturedService,
  ],
  exports: [FeaturedService, FEATURED_REPOSITORY],
})
export class FeaturedModule {}
