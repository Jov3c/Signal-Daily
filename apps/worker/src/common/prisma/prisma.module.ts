/**
 * `PrismaModule` —— `@Global()`，Worker 进程里唯一提供 `WorkerPrismaService`
 * 的地方（清单 P3-02）。
 *
 * 「为什么是 @Global」：四个 Job 模块都要注入同一个连接池。如果让每个模块
 * 各自 `providers: [自己的 PrismaService]`（收敛前就是这样），那就是四个池；
 * 如果只在根模块 provide，则每个单独编译某个 Job 模块的 DI 守卫测试会解析不到它。
 * `@Global()` 一次性解决两者：注册一次，全容器可见且**只有一个实例**。
 *
 * ── ⚠ 谁负责 import 它 ──────────────────────────────────────────────
 * `@Global()` 只是让它「全局可见」，它自己仍必须**被 import 进依赖图一次**
 * 才会注册。这里让**每一个** Job 模块各自 `imports: [PrismaModule]`，
 * 而不是只在 `worker.module.ts` 里 import 一次：
 *
 * Worker 侧有 8 个 DI 守卫测试是**单独**编译某一个 Job 模块的
 * （`Test.createTestingModule({ imports: [PublishingModule] })` 等）。
 * 那些测试不经过根模块，若只在根模块 import，它们的依赖图里就没有
 * `WorkerPrismaService`，会在 `overrideProvider` / 解析仓储时炸。
 *
 * 重复 import 不会产生第二个连接池：Nest 对同一个模块类只建一个实例，
 * 四个模块拿到的是同一个 provider。这一点由 `prisma-singleton.spec.ts`
 * 在真实 `WorkerModule` 上实测（四个模块的仓储共用同一个 prisma 对象）。
 */

import { Global, Module } from '@nestjs/common';
import { WorkerPrismaService } from './prisma.service';

@Global()
@Module({
  providers: [WorkerPrismaService],
  exports: [WorkerPrismaService],
})
export class PrismaModule {}
