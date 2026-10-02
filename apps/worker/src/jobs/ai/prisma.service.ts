/**
 * AI 模块的数据库注入点 —— P3-02 之后是**全局单例的别名**，不再是第 N 份实现。
 *
 * 实现已收敛到 `src/common/prisma/prisma.service.ts` 的 `WorkerPrismaService`，
 * 由 `@Global()` 的 `PrismaModule` 提供。这里保留文件只是为了：
 *   1. 注入点名字（`WorkerPrismaService`）与 import 路径不变 ——
 *      `prisma-ai-run.repository.ts` / `prisma-job-run.repository.ts` 的
 *      `@Inject(WorkerPrismaService)` 与 `module.ts` 的接线都不用改；
 *   2. `ai-content-di-wiring.spec.ts` 的回归墓碑继续盯着这两个仓储的
 *      显式 `@Inject`（那个守卫断言的是「写没写 @Inject」，与实现在哪里无关）。
 *
 * ⚠ 这里**不要**再出现 `class ... extends PrismaClient` ——
 * 多一份实现就多一个连接池，正是 P3-02 要消除的东西。
 * `test/prisma-singleton.spec.ts` 会静态断言整个 worker `src` 只有一处继承。
 */

export { WorkerPrismaService } from '../../common/prisma/prisma.service';
