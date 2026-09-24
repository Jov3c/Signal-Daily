/**
 * Worker 进程内的数据库入口。
 *
 * ── 为什么这里有一份，而不是复用 `apps/api` 的 ──────────────────────
 * `docs/02` 规定模块按 app 分目录（`apps/api/src/modules/...` /
 * `apps/worker/src/jobs/...`），两个 app 是**各自独立的进程与依赖树**。
 * `apps/api/src/common/prisma/prisma.service.ts` 属于 API 的进程，
 * worker 运行时不加载它。
 *
 * 因此这是一个**刻意的、极小的**重复：只有 12 行，且不含任何业务逻辑。
 * 与之相对，`@signal/source-core` 里那些**有逻辑**的东西
 * （SSRF、调度规则、config 契约）则是真正共享的一份，
 * 不允许各写一份 —— 两者的区别是「重复的是样板」还是「重复的是判断」。
 *
 * ── 连接是惰性的 ────────────────────────────────────────────────────
 * 不在 `onModuleInit` 里 `$connect()`：这样只 override 仓储的单元测试
 * 不需要一个真实 MySQL 就能构造本 provider（与 Agent 02 的取舍一致）。
 */

import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
