/**
 * 内容流水线模块的数据库注入点 —— P3-02 之后是**全局单例的别名**，不再是第 4 份实现。
 *
 * 实现已收敛到 `src/common/prisma/prisma.service.ts` 的 `WorkerPrismaService`，
 * 由 `@Global()` 的 `PrismaModule` 提供。这里把它重导出为 `ContentPrismaService`：
 * `prisma-content.repository.ts` 与 `prisma-job-run.repository.ts` 的
 * `@Inject(ContentPrismaService)`、以及 DI 守卫测试里的同名 override 都不用改。
 *
 * ⚠ `ai-content-di-wiring.spec.ts` 的回归墓碑断言
 * `prisma-content.repository.ts` 里含有字面量 `@Inject(ContentPrismaService)`
 * —— 保留这个别名正是为了**不改动那个仓储文件**、也不去削弱那条守卫。
 */

export { WorkerPrismaService as ContentPrismaService } from '../../common/prisma/prisma.service';
