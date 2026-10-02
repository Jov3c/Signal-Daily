/**
 * Worker 进程内的**唯一**数据库入口（清单 P3-02 的收敛结果）。
 *
 * ── 为什么会有这份文件 ──────────────────────────────────────────────
 * 收敛之前，四个 Job 模块（collectors / ai / content / publishing）各自
 * 持有一份 `PrismaClient` 子类。每一份单独看都没错，但一个 Worker 进程把
 * 四个模块都挂上时，就会**同时存在四份 `PrismaClient`** —— 也就是四个连接池
 * （Prisma 默认池大小 `num_cpus * 2 + 1`）。这不是当前的正确性阻塞，却是
 * 确定的资源浪费与未来的连接数风险。
 *
 * 现在只有这一份，由同目录的 `PrismaModule`（`@Global()`）提供并导出。
 * `jobs/<area>/prisma.service.ts` 全部退化成它的**别名** —— 注入点的名字
 * 一个都没变，因此业务仓储的公开接口（方法签名、返回类型）一行都不用改。
 *
 * ── 连接是**惰性**的 ────────────────────────────────────────────────
 * 不在 `onModuleInit` 里 `$connect()`：这样「只 override 仓储」的单元测试
 * 不需要一个真实 MySQL 就能构造本 provider（与 Agent 02 的 api 侧同一取舍）。
 *
 * ── 生命周期：只 disconnect 一次 ────────────────────────────────────
 * `onModuleDestroy` 里 `$disconnect()`。**整个容器里只有这一个实例**，
 * 所以进程退出时只会 disconnect 一次。这条由
 * `apps/worker/test/prisma-singleton.spec.ts` 用运行时断言钉住
 * （不是「我看了一遍代码」）。
 *
 * 契约（与 api 侧一致，来自 Agent 02）：
 *   - 主键 BIGINT UNSIGNED，取出来是 `bigint`，**出库必须 `String()`**。
 */

import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class WorkerPrismaService extends PrismaClient implements OnModuleDestroy {
  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
