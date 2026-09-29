/**
 * `JobRunRecorder` 的 Prisma 实现（`docs/13` 的 Dead Letter 落库）。
 */

import { Inject, Injectable } from '@nestjs/common';
import { JobRunStatus as PrismaJobRunStatus, type PrismaClient } from '@prisma/client';
import type { JobRunStatus } from '@signal/contracts';
import type { JobRunRecorder, RecordJobRunInput } from './job-run.repository';
import { ContentPrismaService } from './prisma.service';

/** 契约 `JobRunStatus` → Prisma `JobRunStatus`（显式映射表，缺键即编译错）。 */
const JOB_RUN_STATUS_TO_PRISMA: Readonly<Record<JobRunStatus, PrismaJobRunStatus>> = {
  QUEUED: PrismaJobRunStatus.QUEUED,
  RUNNING: PrismaJobRunStatus.RUNNING,
  SUCCEEDED: PrismaJobRunStatus.SUCCEEDED,
  FAILED: PrismaJobRunStatus.FAILED,
  DEAD: PrismaJobRunStatus.DEAD,
};

@Injectable()
export class PrismaJobRunRecorder implements JobRunRecorder {
  /**
   * ⚠ 显式 `@Inject(...)`：不写时 Nest 靠 `design:paramtypes` 元数据解析依赖，
   * 而那个元数据要求构造函数参数在**运行期是个值** ——
   * lint 规则 `consistent-type-imports` 会诱导人把 import 改成 `import type`，
   * 那会让元数据退化成 `Object`，DI 在运行期静默失败。
   */
  constructor(@Inject(ContentPrismaService) private readonly prisma: ContentPrismaService) {}

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
          : { metadata: JSON.parse(JSON.stringify(input.metadata)) as object }),
      },
      select: { id: true },
    });
  }

  static forClient(prisma: PrismaClient): PrismaJobRunRecorder {
    return new PrismaJobRunRecorder(prisma as ContentPrismaService);
  }
}
