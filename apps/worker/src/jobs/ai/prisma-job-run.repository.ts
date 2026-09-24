/**
 * `JobRunRecorder` 的 Prisma 实现（`docs/13` 的 Dead Letter 落库）。
 */

import { Inject, Injectable } from '@nestjs/common';
import { JobRunStatus as PrismaJobRunStatus, type PrismaClient } from '@prisma/client';
import { JobRunStatus } from '@signal/contracts';
import type { JobRunRecorder, RecordJobRunInput } from './job-run.repository';
import { WorkerPrismaService } from './prisma.service';

/** 契约 `JobRunStatus` → Prisma `JobRunStatus`（显式映射表，缺键即编译错）。 */
const JOB_RUN_STATUS_TO_PRISMA: Readonly<Record<JobRunStatus, PrismaJobRunStatus>> = {
  [JobRunStatus.QUEUED]: PrismaJobRunStatus.QUEUED,
  [JobRunStatus.RUNNING]: PrismaJobRunStatus.RUNNING,
  [JobRunStatus.SUCCEEDED]: PrismaJobRunStatus.SUCCEEDED,
  [JobRunStatus.FAILED]: PrismaJobRunStatus.FAILED,
  [JobRunStatus.DEAD]: PrismaJobRunStatus.DEAD,
};

@Injectable()
export class PrismaJobRunRecorder implements JobRunRecorder {
  /**
   * ⚠ 显式 `@Inject(WorkerPrismaService)`，与 `apps/api` 的
   * `PrismaSourceRepository` 同一写法。
   *
   * 理由不只是风格：不写 `@Inject` 时 Nest 靠 `design:paramtypes` 元数据
   * 解析依赖，而那个元数据要求构造函数参数的类型在**运行期是个值** ——
   * 一旦有人把 import 改成 `import type`（lint 规则 `consistent-type-imports`
   * 会诱导这么做），元数据会退化成 `Object`，DI 在运行期静默失败。
   * 显式 `@Inject` 把依赖绑定从元数据里解耦出来。
   */
  constructor(@Inject(WorkerPrismaService) private readonly prisma: WorkerPrismaService) {}

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

  /** 便于测试与工具代码构造（`PrismaClient` 的别名）。 */
  static forClient(prisma: PrismaClient): PrismaJobRunRecorder {
    return new PrismaJobRunRecorder(prisma as WorkerPrismaService);
  }
}
