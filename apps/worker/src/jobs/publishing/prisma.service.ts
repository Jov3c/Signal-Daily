/**
 * Worker 进程内的 Prisma 入口（Publishing 模块）。
 *
 * ⚠ **这是本仓库的第 8 份 `PrismaClient` 包装**
 * （api / collectors / ai / content / 本模块，加上各自测试里的替身）。
 *
 * 为什么不能共用：`apps/api/src/**` 不在 worker 的 tsconfig 引用图里，
 * 跨 app import 会把 api 的整个源码树拖进 worker 构建（`docs/02` 只允许共享
 * `packages/*`）；而 worker 内部 `jobs/<area>/prisma.service.ts` 都**没有**
 * 从各自的 `index.ts` 导出 —— 那是**故意**的（Agent 05/06 的说明：
 * 导出它等于让别的模块的生命周期绑在它的连接上）。
 *
 * 于是每一轮 Agent 都留下一份。Agent 14 要做的是**一份全局的** worker
 * `PrismaService`（`@Global()`，一次连接池），而不是再让第 9 个 Agent 复制一遍。
 * 已记入 Agent 08 的 CCR。
 *
 * 契约（与 api 侧一致，来自 Agent 02）：
 *   - 连接是**惰性**的：不在 `onModuleInit` 里 `$connect()`，
 *     这样只 override 仓储的单元测试不需要真实 MySQL 就能构造本 provider。
 *   - 主键 BIGINT UNSIGNED，取出来是 `bigint`，**出库必须 `String()`**。
 */

import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PublishingPrismaService extends PrismaClient implements OnModuleDestroy {
  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
