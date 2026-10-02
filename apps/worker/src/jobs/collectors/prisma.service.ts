/**
 * 采集模块的数据库注入点 —— P3-02 之后是**全局单例的别名**，不再是第 1 份实现。
 *
 * 实现已收敛到 `src/common/prisma/prisma.service.ts` 的 `WorkerPrismaService`，
 * 由 `@Global()` 的 `PrismaModule` 提供。这里把全局类**重导出为 `PrismaService`**：
 * 采集侧三个仓储（source / raw-item / job-run）与 DI 守卫测试用的都是这个名字，
 * 别名让它们一行都不用改。
 *
 * ⚠ 别名意味着 `PrismaService` 与 `WorkerPrismaService` 在运行期是**同一个
 * 类对象（同一个注入 token）** —— 这正是收敛的目的，不是巧合。
 * 静态守卫 `collectors-di-wiring.spec.ts` 仍然盯着
 * `constructor(@Inject(PrismaService) ...)` 这个写法，不受影响。
 */

export { WorkerPrismaService as PrismaService } from '../../common/prisma/prisma.service';
