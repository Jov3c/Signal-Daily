/**
 * Worker 进程内的 Prisma 入口（Pipeline 模块）。
 *
 * ⚠ **这是本仓库的第 4 份 `PrismaService`**（api / collectors / ai / 本模块）。
 * `apps/api/src/**` 不在 worker 的 tsconfig 引用图里，跨 app import 会把
 * api 的整个源码树拖进 worker 构建（`docs/02` 只允许共享 `packages/*`）；
 * 而 worker 内部的跨 Job 目录 import 又会让两个模块的生命周期绑在一起。
 *
 * 已与 `contract-enum.ts` 的重复一起记入 CCR，建议 Agent 14 统一提到共享包
 *（与 Agent 04 提取 `packages/source-core` 同一思路）。
 *
 * 契约（与 api 侧一致，来自 Agent 02）：
 *   - 连接是**惰性**的：不在 `onModuleInit` 里 `$connect()`，
 *     这样只 override 仓储的单元测试不需要真实 MySQL 就能构造本 provider。
 *   - 主键 BIGINT UNSIGNED，取出来是 `bigint`，**出库必须 `String()`**。
 */

import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class ContentPrismaService extends PrismaClient implements OnModuleDestroy {
  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
