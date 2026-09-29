/**
 * `publishing` 队列的消费者。
 *
 * ── 与 Agent 05 / 06 的消费者同一结构，但重试判定有一个**关键区别** ──
 * `publishIfScheduled` 返回 `{published: false, reason: 'NOT_SCHEDULED'}`
 * 时，job 是**成功**的，不是失败。
 *
 * 这条容易写反：`docs/10` 说「08:00 只有 SCHEDULED 才发布」，
 * 所以「到点了但没排期 → 不发」是**契约规定的正常结果**。
 * 把它记成失败会让运维面板每天早上都报一次「publish job 失败」，
 * 而那恰恰是「未审核保持草稿」这条规则在正常工作。
 * 因此 service 用**返回值**表达它，worker 只在真的抛异常时才走失败路径。
 *
 * ── Dead Letter（`docs/13`）──────────────────────────────────────────
 * 终态写一行 `job_runs`：成功 `SUCCEEDED`，最终失败 `DEAD`。
 */

import { UnrecoverableError, Worker, type ConnectionOptions } from 'bullmq';
import { DEAD_LETTER_JOB_RUN_STATUS, JobName, JobRunStatus, isAppError } from '@signal/contracts';
import type { Logger } from '@signal/logger';
import type { JobRunRecorder } from '../ai';
import type { PublishingService } from './publishing.service';
import {
  assertPublishingQueueContract,
  isPublishingJobData,
  PUBLISHING_JOB_OPTIONS,
  PUBLISHING_SLOT,
  type PublishingJobData,
} from './queue';
import { PUBLISHING_QUEUE_NAME, QUEUE_CONCURRENCY_FOR_PUBLISHING } from './queue-names';

/**
 * handler 收到的最小 job 形状。
 *
 * 与 BullMQ 的 `Job` 解耦：这样 `publishing.worker.spec.ts` 可以在
 * **没有 Redis** 的情况下跑完整条「分派 + 重试判定 + Dead Letter」。
 */
export type PublishingJobLike = {
  id?: string;
  name: string;
  data: unknown;
  attemptsMade: number;
};

/** 本模块处理的作业名。 */
const HANDLED_JOB_NAMES: readonly string[] = [
  JobName.PUBLISHING_DAILY_DRAFT,
  JobName.PUBLISHING_DAILY_PUBLISH,
];

export function isPublishingJob(name: string): boolean {
  return HANDLED_JOB_NAMES.includes(name);
}

export class PublishingQueueWorker {
  private worker: Worker | null = null;

  constructor(
    private readonly deps: {
      service: PublishingService;
      connection: ConnectionOptions;
      logger: Logger;
      concurrency?: number;
      /** `docs/13` 的 Dead Letter 落库。未提供时不记录。 */
      recorder?: JobRunRecorder;
    },
  ) {}

  /** 处理一个 job。抛出的错误决定 BullMQ 是否重试。 */
  async handle(job: PublishingJobLike): Promise<unknown> {
    if (!isPublishingJob(job.name)) {
      // 挂错队列的 job 必须炸，不能静默跑成别的任务。
      throw new UnrecoverableError(`Unexpected job name on the publishing queue: ${job.name}`);
    }

    const startedAt = new Date();
    const attempt = job.attemptsMade + 1;

    // 载荷畸形是**代码缺陷**（入队方写错了），重试只会重复同一个错误。
    if (!isPublishingJobData(job.data)) {
      await this.record(job, startedAt, attempt, DEAD_LETTER_JOB_RUN_STATUS, 'INVALID_PAYLOAD');
      throw new UnrecoverableError(
        'publishing job payload must be {businessDate: YYYY-MM-DD, slot: HHmm}',
      );
    }

    try {
      const outcome = await this.runJob(job.name, job.data);
      await this.record(job, startedAt, attempt, JobRunStatus.SUCCEEDED, null);

      this.deps.logger.info(
        {
          businessDate: job.data.businessDate,
          slot: job.data.slot,
          jobName: job.name,
          jobId: job.id,
          attempt,
          outcome,
        },
        'publishing job finished',
      );
      return outcome;
    } catch (error) {
      const errorCode = isAppError(error) ? String(error.code) : 'PUBLISHING_JOB_FAILED';

      // 本模块没有「不可重试的业务失败」这一类：载荷问题已经在上面挡掉了，
      // 剩下的都是数据库/连接类的瞬时故障，重试有意义
      //（`docs/13`：Publishing 重试 3 次）。失败由记录的 `FAILED` 表达；
      // 第 3 次之后 BullMQ 会把它留在 failed 集合里，`job_runs` 记 `DEAD`。
      const isFinalAttempt = attempt >= PUBLISHING_JOB_OPTIONS.attempts;
      await this.record(
        job,
        startedAt,
        attempt,
        isFinalAttempt ? DEAD_LETTER_JOB_RUN_STATUS : JobRunStatus.FAILED,
        errorCode,
      );

      this.deps.logger.error(
        {
          err: error,
          businessDate: job.data.businessDate,
          slot: job.data.slot,
          jobName: job.name,
          jobId: job.id,
          attempt,
          errorCode,
          finalAttempt: isFinalAttempt,
        },
        'publishing job failed',
      );

      throw error;
    }
  }

  /** 按作业名分派。 */
  private async runJob(jobName: string, data: PublishingJobData): Promise<unknown> {
    switch (jobName) {
      case JobName.PUBLISHING_DAILY_DRAFT:
        // 00:10 只建空期次；05:30 / 07:00 生成与刷新。
        // 两者共用一个 Job 名（`docs/13` 只给了这一个），靠槽位区分。
        return data.slot === PUBLISHING_SLOT.INIT_DRAFT
          ? this.deps.service.initDraft(data.businessDate)
          : this.deps.service.generateDraft(data.businessDate);

      case JobName.PUBLISHING_DAILY_PUBLISH:
        return this.deps.service.publishIfScheduled(data.businessDate);

      default:
        // `isPublishingJob` 已经挡过一遍；走到这里说明两处名单不一致。
        throw new UnrecoverableError(`Unmapped publishing job: ${jobName}`);
    }
  }

  /** 写一行 `job_runs`。**绝不因为记录失败而掩盖原始异常。** */
  private async record(
    job: PublishingJobLike,
    startedAt: Date,
    attempt: number,
    status: string,
    errorCode: string | null,
  ): Promise<void> {
    const recorder = this.deps.recorder;
    if (recorder === undefined) return;

    try {
      await recorder.record({
        jobType: job.name,
        jobKey: job.id ?? null,
        status: status as never,
        startedAt,
        finishedAt: new Date(),
        attempts: attempt,
        errorCode,
        metadata: { queue: PUBLISHING_QUEUE_NAME },
      });
    } catch (recordingError) {
      this.deps.logger.error(
        { err: recordingError, jobId: job.id, jobType: job.name },
        'failed to record job run',
      );
    }
  }

  /** 启动消费者。幂等：重复调用不会创建第二个 Worker。 */
  async start(): Promise<void> {
    if (this.worker !== null) return;

    // 启动期自检必须在 `new Worker()` **之前**跑
    //（否则错误只在首次入队时暴露 —— 而那时已经晚了）。
    assertPublishingQueueContract();

    this.worker = new Worker(PUBLISHING_QUEUE_NAME, async (job) => this.handle(job), {
      connection: this.deps.connection,
      concurrency: this.deps.concurrency ?? QUEUE_CONCURRENCY_FOR_PUBLISHING,
    });

    this.worker.on('failed', (job, error) => {
      this.deps.logger.error(
        { err: error, jobId: job?.id, attemptsMade: job?.attemptsMade },
        'publishing job moved to failed',
      );
    });

    this.deps.logger.info(
      { queue: PUBLISHING_QUEUE_NAME, attempts: PUBLISHING_JOB_OPTIONS.attempts },
      'publishing worker started',
    );
  }

  /** 停止消费者。 */
  async close(): Promise<void> {
    const worker = this.worker;
    this.worker = null;
    if (worker !== null) await worker.close();
  }
}
