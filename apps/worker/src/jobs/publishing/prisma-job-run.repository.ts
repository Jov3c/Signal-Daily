/**
 * `JobRunRecorder` 的 Prisma 实现（`docs/13` 的 Dead Letter 落库）。
 *
 * ── 为什么是「实现」而不是「又一份端口」────────────────────────────
 * **端口复用 Agent 06 的**：`JobRunRecorder` / `RecordJobRunInput`
 * 已经从 `../ai` 的公开面导出，形状是通用的（jobType / jobKey / status /
 * attempts / errorCode），本模块没有任何理由再造一个。
 *
 * 只有**实现**必须是本地的：它要 `PublishingPrismaService`
 *（worker 侧每个模块一份 Prisma 包装，见 `prisma.service.ts` 的说明）。
 *
 * ⚠ 注入 token 用了本模块自己的 `PUBLISHING_JOB_RUN_RECORDER` 而不是
 * 复用 Agent 06 的 `JOB_RUN_RECORDER`：所有 worker 模块最终会挂在同一个
 * Nest 应用里（Agent 14 的 `worker.module.ts`），同名 token 在多个模块里
 * 各绑一个实现虽然能解析，但**排查时会分不清用的是哪一个**。
 * 接口共用、token 分开，是这里刻意的选择。
 */

import { Inject, Injectable } from '@nestjs/common';
import { JobRunStatus as PrismaJobRunStatus } from '@prisma/client';
import { JobRunStatus } from '@signal/contracts';
import type { JobRunRecorder, RecordJobRunInput } from '../ai';
import { PublishingPrismaService } from './prisma.service';

/** 注入 token。 */
export const PUBLISHING_JOB_RUN_RECORDER = 'PUBLISHING_JOB_RUN_RECORDER';

/**
 * 契约 `JobRunStatus` → Prisma `JobRunStatus`。
 *
 * 显式映射表（而不是 `as`）：契约加了新状态时这里**编译不过**，
 * 而不是在运行期写进一个 Prisma 不认的值。
 */
const JOB_RUN_STATUS_TO_PRISMA: Readonly<Record<JobRunStatus, PrismaJobRunStatus>> = {
  [JobRunStatus.QUEUED]: PrismaJobRunStatus.QUEUED,
  [JobRunStatus.RUNNING]: PrismaJobRunStatus.RUNNING,
  [JobRunStatus.SUCCEEDED]: PrismaJobRunStatus.SUCCEEDED,
  [JobRunStatus.FAILED]: PrismaJobRunStatus.FAILED,
  [JobRunStatus.DEAD]: PrismaJobRunStatus.DEAD,
};

@Injectable()
export class PrismaPublishingJobRunRecorder implements JobRunRecorder {
  constructor(@Inject(PublishingPrismaService) private readonly prisma: PublishingPrismaService) {}

  async record(input: RecordJobRunInput): Promise<void> {
    await this.prisma.jobRun.create({
      data: {
        jobType: input.jobType,
        jobKey: input.jobKey,
        status: JOB_RUN_STATUS_TO_PRISMA[input.status],
        startedAt: input.startedAt,
        finishedAt: input.finishedAt,
        attempts: input.attempts,
        errorCode: input.errorCode,
        ...(input.metadata === undefined
          ? {}
          : // `JSON.parse(JSON.stringify(...))`：Prisma 的 Json 字段不接受
            // `undefined` 与非 JSON 值（`Date`、类实例），而这里可能被传进来。
            { metadata: JSON.parse(JSON.stringify(input.metadata)) as object }),
      },
      select: { id: true },
    });
  }
}
