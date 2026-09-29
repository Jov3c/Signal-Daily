/**
 * `content-pipeline` 队列的消费者（Normalize 阶段）。
 *
 * ── 与 Agent 06 的 `ai.worker.ts` 同一结构，但**重试判定更简单** ─────
 * AI 那边要按失败原因分三档（瞬时 / schema / unsupported），因为一次调用
 * 可能要花钱。Normalize **不调外部服务、不花钱**，所以只有两类：
 *
 * | 类别 | 例子 | 处置 |
 * | ---- | ---- | ---- |
 * | **不可重试** | 载荷畸形、RawItem 不存在 | 立即 `UnrecoverableError` |
 * | **可重试** | 连不上库、写库超时 | 抛普通错误，BullMQ 按退避重试 3 次 |
 *
 * ⚠ 特别注意：**「清洗后没有内容」不在这两类里** —— 它由 service 返回
 * `status: 'FAILED'` 而不抛异常（见 `content.service.ts` 的说明）。
 * 那是一个数据结论，job 本身是**成功**的。
 *
 * ── Dead Letter（docs/13）────────────────────────────────────────────
 * 终态写一行 `job_runs`：成功 `SUCCEEDED`，最终失败 `DEAD`。
 */

import { UnrecoverableError, Worker, type ConnectionOptions, type Job } from 'bullmq';
import {
  DEAD_LETTER_JOB_RUN_STATUS,
  JobName,
  JobRunStatus,
  PlatformErrorCode,
  isAppError,
} from '@signal/contracts';
import type { Logger } from '@signal/logger';
import type { ContentService } from './content.service';
import type { JobRunRecorder } from './job-run.repository';
import { assertContentQueueContract, CONTENT_PIPELINE_JOB_OPTIONS } from './queue';
import { CONTENT_PIPELINE_QUEUE_NAME, QUEUE_CONCURRENCY_FOR_CONTENT_PIPELINE } from './queue-names';

/** handler 收到的最小 job 形状（与 BullMQ 解耦，便于无 Redis 测试）。 */
export type ContentJobLike = {
  id?: string;
  name: string;
  data: unknown;
  attemptsMade: number;
};

/** 从 job 载荷里读 `rawItemId`。 */
export function rawItemIdOfJobData(data: unknown): string {
  const rawItemId = (data as { rawItemId?: unknown } | null)?.rawItemId;
  if (typeof rawItemId !== 'string' || !/^\d{1,20}$/.test(rawItemId)) {
    throw new Error(
      `content.normalize payload must contain a decimal string rawItemId, got: ${typeof rawItemId}`,
    );
  }
  return rawItemId;
}

/** 本模块处理的三个作业名（`docs/13` 的 content-pipeline 阶段）。 */
const HANDLED_JOB_NAMES: readonly string[] = [
  JobName.CONTENT_NORMALIZE,
  JobName.CONTENT_DEDUP,
  JobName.CONTENT_EVENT_CLUSTER,
];

/** job 名 → 本模块是否处理它。 */
export function isContentPipelineJob(jobName: string): boolean {
  return HANDLED_JOB_NAMES.includes(jobName);
}

/** 该作业的载荷是不是 `contentId` 形状（dedup / event-cluster 用）。 */
export function usesContentIdPayload(jobName: string): boolean {
  return jobName === JobName.CONTENT_DEDUP || jobName === JobName.CONTENT_EVENT_CLUSTER;
}

/** 从 job 载荷里读 `contentId`。 */
export function contentIdOfJobData(data: unknown): string {
  const contentId = (data as { contentId?: unknown } | null)?.contentId;
  if (typeof contentId !== 'string' || !/^\d{1,20}$/.test(contentId)) {
    throw new Error(
      `content pipeline payload must contain a decimal string contentId, got: ${typeof contentId}`,
    );
  }
  return contentId;
}

/**
 * 该错误是否应当**立刻终止**重试。
 *
 * 判据只有一条：**重试会不会得到不同结果**。
 * - `*_NOT_FOUND`：记录不在库里，重试一百次也不在 → 停。
 * - 其余（数据库故障、超时）：等一会儿可能就好了 → 重试。
 */
export function shouldStopRetrying(error: unknown): boolean {
  if (!isAppError(error)) return false;
  return String(error.code).endsWith('_NOT_FOUND');
}

export class ContentPipelineWorker {
  private worker: Worker | null = null;

  constructor(
    private readonly deps: {
      service: ContentService;
      connection: ConnectionOptions;
      logger: Logger;
      concurrency?: number;
      /** `docs/13` 的 Dead Letter 落库。未提供时不记录。 */
      recorder?: JobRunRecorder;
    },
  ) {}

  /** 处理一个 job。抛出的错误决定 BullMQ 是否重试。 */
  async handle(job: ContentJobLike): Promise<unknown> {
    if (!isContentPipelineJob(job.name)) {
      // 挂错队列的 job 必须炸，不能静默跑成别的任务。
      throw new UnrecoverableError(`Unexpected job name on the content-pipeline queue: ${job.name}`);
    }

    const startedAt = new Date();
    const attempt = job.attemptsMade + 1;

    // 载荷畸形是**代码缺陷**（入队方写错了），重试只会重复同一个错误。
    let payloadId: string;
    try {
      payloadId = usesContentIdPayload(job.name)
        ? contentIdOfJobData(job.data)
        : rawItemIdOfJobData(job.data);
    } catch (error) {
      await this.record(job, startedAt, attempt, DEAD_LETTER_JOB_RUN_STATUS, 'INVALID_PAYLOAD');
      throw new UnrecoverableError(error instanceof Error ? error.message : String(error));
    }

    try {
      // 三个作业走同一条重试/Dead-Letter 路径，只是主体不同：
      // normalize 建内容 → dedup 找近似重复 → event-cluster 归到事件。
      const outcome = await this.runStage(job.name, payloadId);

      // ⚠ `status: 'FAILED'` 是**数据结论**，job 本身成功 —— 记 SUCCEEDED，
      // 不记 DEAD（否则运维面板会把「来源给了空条目」误报成任务故障）。
      await this.record(job, startedAt, attempt, JobRunStatus.SUCCEEDED, null);

      this.deps.logger.info(
        { payloadId, jobName: job.name, jobId: job.id, attempt },
        'content pipeline job finished',
      );
      return outcome;
    } catch (error) {
      const stop = shouldStopRetrying(error);
      const errorCode = isAppError(error) ? String(error.code) : PlatformErrorCode.INTERNAL_ERROR;

      await this.record(
        job,
        startedAt,
        attempt,
        stop ? DEAD_LETTER_JOB_RUN_STATUS : JobRunStatus.FAILED,
        errorCode,
      );

      this.deps.logger.error(
        {
          err: error,
          payloadId,
          jobName: job.name,
          jobId: job.id,
          attempt,
          errorCode,
          decision: stop ? 'STOP' : 'RETRY',
        },
        'content pipeline job failed',
      );

      if (stop) {
        throw new UnrecoverableError(
          `${errorCode}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      throw error;
    }
  }

  /** 按作业名分派到对应的服务方法。 */
  private async runStage(jobName: string, payloadId: string): Promise<unknown> {
    switch (jobName) {
      case JobName.CONTENT_NORMALIZE:
        return this.deps.service.normalize(payloadId);
      case JobName.CONTENT_DEDUP:
        return this.deps.service.runNearDedup(payloadId);
      case JobName.CONTENT_EVENT_CLUSTER:
        return this.deps.service.clusterContent(payloadId);
      default:
        // `isContentPipelineJob` 已经挡过一遍；走到这里说明两处名单不一致。
        throw new UnrecoverableError(`Unmapped content pipeline job: ${jobName}`);
    }
  }

  /** 写一行 `job_runs`。**绝不因为记录失败而掩盖原始异常。** */
  private async record(
    job: ContentJobLike,
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
        metadata: { queue: CONTENT_PIPELINE_QUEUE_NAME },
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

    // 启动期自检必须在 `new Worker()` **之前**跑（否则错误只在首次入队时暴露）。
    assertContentQueueContract();

    this.worker = new Worker(CONTENT_PIPELINE_QUEUE_NAME, async (job: Job) => this.handle(job), {
      connection: this.deps.connection,
      concurrency: this.deps.concurrency ?? QUEUE_CONCURRENCY_FOR_CONTENT_PIPELINE,
    });

    this.worker.on('failed', (job, error) => {
      this.deps.logger.error(
        { err: error, jobId: job?.id, attemptsMade: job?.attemptsMade },
        'content pipeline job moved to failed',
      );
    });

    this.deps.logger.info(
      { queue: CONTENT_PIPELINE_QUEUE_NAME, options: CONTENT_PIPELINE_JOB_OPTIONS.attempts },
      'content pipeline worker started',
    );
  }

  /** 停止消费者。 */
  async close(): Promise<void> {
    const worker = this.worker;
    this.worker = null;
    if (worker !== null) await worker.close();
  }
}
