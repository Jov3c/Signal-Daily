/**
 * 发布模块的数据库注入点 —— P3-02 之后是**全局单例的别名**，不再是又一份实现。
 *
 * 实现已收敛到 `src/common/prisma/prisma.service.ts` 的 `WorkerPrismaService`，
 * 由 `@Global()` 的 `PrismaModule` 提供。这里把全局类重导出为
 * `PublishingPrismaService`：`module.ts` 的三个 `useFactory`（仓储 / 通知器 /
 * job-run 记录器）与 `publishing-di-wiring.spec.ts` 的 override 名字都不变。
 *
 * ⚠ 本文件原注释数着「这是第 8 份 PrismaClient 包装」。那份账本从 P3-02 起
 * 作废：worker 进程内**只有一份**实现（`src/common/prisma/`），
 * 其余都是别名。`test/prisma-singleton.spec.ts` 用静态扫描 + 运行时断言守住它。
 */

export { WorkerPrismaService as PublishingPrismaService } from '../../common/prisma/prisma.service';
