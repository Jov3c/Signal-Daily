/**
 * `JobRunRepository` 的 Prisma 实现。
 *
 * ── JobRun 是干什么用的 ─────────────────────────────────────────────
 * `docs/13` 的 dead-letter 要求：
 * > 最终失败：BullMQ 保留 / JobRun = DEAD / 后台可重试
 *
 * 所以它是一张**给运维看的表**：哪个 Job 跑了、跑了几次、最后成没成、
 * 失败的错误码是什么。它不参与任何业务判断 —— 这条定位很重要，
 * 因为它意味着**写 JobRun 失败绝不能影响采集本身**。
 * 因此本仓储的写入失败由调用方吞掉并记日志（见 `collector.service.ts`），
 * 而不是让一次成功的采集因为一张审计表写不进去而变成失败。
 *
 * ── `jobType` 用契约的 `JobName` ───────────────────────────────────
 * Agent 01 的 HANDOFF：「`JobRun.jobType` 建议用 `@signal/contracts`
 * 的 `JobName` 取值」。列是 `VarChar(120)`，不是数据库枚举 ——
 * 但取值仍然必须来自契约，否则会出现 `collector.fetchSource` /
 * `collector.fetch-source` / `collector_fetch_source` 三种写法并存，
 * 后台的统计从此不可用。
 */

import { Inject, Injectable } from '@nestjs/common';
import { JobRunStatus } from '@signal/contracts';
import type { Prisma } from '@prisma/client';
import { toBindableId } from './bigint-id';
import type { JobRunInput, JobRunRepository } from './ports';
import { toJsonValue } from './json-value';
import { PrismaService } from './prisma.service';

@Injectable()
export class PrismaJobRunRepository implements JobRunRepository {
  // ⚠ 显式 `@Inject`：**不要**依赖 emitDecoratorMetadata。
  // `PrismaService` 只作为类型使用时，eslint 的 `consistent-type-imports`
  // 会要求写成 `import type` —— 而那样 tsc 产出的 `design:paramtypes`
  // 会退化成 `[Function]`，Nest 在**编译产物**里就解析不到依赖。
  // 这个缺陷在单元测试与集成测试里**全都看不见**（它们不实例化本模块），
  // 只有从 dist 起一个真实 Nest 上下文才会暴露。
  // 见 Agent 02 的 `apps/api/test/di-wiring.spec.ts` 与
  // `work/_agent04/probe-dist-collectors.mjs`。
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /** 开始记录。返回 `JobRun.id`（string）；记录失败返回 null，**不抛**。 */
  async start(at: Date, input: JobRunInput): Promise<string | null> {
    try {
      const row = await this.prisma.jobRun.create({
        data: {
          jobType: input.jobType,
          jobKey: input.jobKey,
          status: JobRunStatus.RUNNING,
          startedAt: at,
          attempts: 1,
          metadata:
            input.metadata === null
              ? undefined
              : (toJsonValue(input.metadata) as Prisma.InputJsonValue),
        },
        select: { id: true },
      });
      return String(row.id);
    } catch {
      // 审计表写不进去不该让采集失败（见文件头）。
      // 刻意吞掉而不是往上抛：一个满盘的审计表会让整个采集停摆。
      return null;
    }
  }

  /** 收尾。`id` 为 null（start 时失败）时什么都不做。 */
  async finish(
    id: string | null,
    at: Date,
    outcome: {
      status: 'SUCCEEDED' | 'FAILED' | 'DEAD';
      errorCode: string | null;
      attempts: number;
    },
  ): Promise<void> {
    if (id === null) return;
    const runId = toBindableId(id);
    if (runId === null) return;

    try {
      await this.prisma.jobRun.update({
        where: { id: runId },
        data: {
          status: JobRunStatus[outcome.status],
          finishedAt: at,
          attempts: outcome.attempts,
          errorCode: outcome.errorCode,
        },
      });
    } catch {
      // 同上：审计写入失败不影响采集结论。
    }
  }
}
