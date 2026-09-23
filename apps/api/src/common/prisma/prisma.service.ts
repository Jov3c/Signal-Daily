/**
 * PrismaService — API 进程内的唯一数据库入口。
 *
 * 归属：Agent 02 落地（首个需要 DB 的模块）。**下游 Agent 请复用，不要各建一份。**
 * 见 `handoffs/agent-02-HANDOFF.md` 的 Integration Notes。
 *
 * 契约：
 *   - `prisma/schema.prisma` 由 Agent 01 独占，本文件只做 Nest 生命周期包装。
 *   - 主键是 BIGINT UNSIGNED，取出来是 `bigint`，**API 层必须 `String()` 后再返回**（docs/02）。
 *   - 连接是**惰性**的：不在 `onModuleInit` 里 `$connect()`。
 *     这样只 override 仓储的单元测试不需要一个真实 MySQL 就能构造本 provider。
 */

import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
