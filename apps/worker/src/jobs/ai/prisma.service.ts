/**
 * Worker 进程内的 Prisma 入口。
 *
 * ⚠ **这是一份重复实现，已记入 HANDOFF。**
 * `apps/api/src/common/prisma/prisma.service.ts` 是 Agent 02 落地的，
 * 但 `apps/api/src/**` 不在 worker 的 tsconfig 引用图里，
 * 跨 app import 会把 api 的整个源码树拖进 worker 的构建（`docs/02` 只允许共享 `packages/*`）。
 * Agent 04 也在 `jobs/collectors/prisma.service.ts` 里各建了一份。
 *
 * 建议 Agent 14 集成时把「worker 侧 PrismaService + 枚举桥接」提到共享包。
 * 在那之前，各模块保留自己的那份 —— 跨模块 import 会让两个 Job 目录
 * 的生命周期绑在一起，而这里只有二十行。
 *
 * 契约（与 api 侧一致，来自 Agent 02）：
 *   - 连接是**惰性**的：不在 `onModuleInit` 里 `$connect()`，
 *     这样只 override 仓储的单元测试不需要真实 MySQL 就能构造本 provider。
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
