/**
 * `ai` 队列的消费者。
 *
 * ── 「按失败原因决定重试几次」是这里的全部难点 ────────────────────────
 * BullMQ 的 `attempts` 是 **job 的属性，只能在入队时设定**；
 * 而失败原因只有跑完才知道。一个 401（凭据错，重试会烧额度）
 * 和一个 503（上游抖了一下，重试就好）在入队那一刻完全无从区分。
 *
 * 解法是两段式：
 * 1. 入队时统一给**最大档位** `attempts = 3`（`queue.ts` 的 `AI_JOB_OPTIONS`）；
 * 2. 失败时按 `AiError.kind` 在 handler 里判定，**该停就抛
 *    `UnrecoverableError`** —— BullMQ 收到它就不会再重试。
 *
 * `retryDecision()` 是纯函数，因此「哪种错重试几次」可以被直接断言。
 *
 * ── `attemptsMade` 的语义 ────────────────────────────────────────────
 * 本文件统一按 **`attemptsMade + 1` = 含本次的累计尝试次数** 来解释。
 *
 * ⚠ 独立审查做反证时发现一处**声称错位**，已修正（P3）：
 * 把 `+ 1` 去掉后，真正变红的是 **`schema 非法恰好只尝试 1 次`** 那条，
 * 而不是原先注释里点名的「瞬时失败恰好重试到 3 次」——
 * 因为 `attempts = 3` 时 handler 的上限（`attempt >= 3`）与 BullMQ 自己的
 * 上限重合，去掉 `+1` 后 TRANSIENT 在两次实现下都恰好跑 3 次，**看不出差别**。
 * 有牙齿的是 `attempts = 1` 的那条（差一次就是 1 vs 2）。
 * `ai-queue.integration.spec.ts` 里现在**两条都验**，并且把 TRANSIENT 那条
 * 的入队 attempts 临时提到 5，让它也真正压到语义上。
 *
 * ── Dead Letter（docs/13）────────────────────────────────────────────
 * 最终失败时除了抛 `UnrecoverableError`，还会写一行 `job_runs`，
 * 状态取 `DEAD_LETTER_JOB_RUN_STATUS`。独立审查指出第一版**完全没写 JobRun**，
 * 于是运维面板无法按契约看到 DEAD 的 AI 任务、也无法「后台人工重试」。
 */

import { UnrecoverableError, Worker, type ConnectionOptions, type Job } from 'bullmq';
import { AiTaskType, DEAD_LETTER_JOB_RUN_STATUS, JobName, JobRunStatus } from '@signal/contracts';
import type { Logger } from '@signal/logger';
import { isAiError } from './ai.errors';
import type { AiService, AiTaskOutcome } from './ai.service';
import { retryPolicyFor } from './ai.errors';
import type { AiFailureKind } from './ai.types';
import type { JobRunRecorder } from './job-run.repository';
import { assertQueueMapping } from './queue';
import { AI_QUEUE_NAME, QUEUE_CONCURRENCY_FOR_AI } from './queue-names';

/** 重试判定结果。 */
export type RetryDecision = 'RETRY' | 'STOP';

/**
 * 是否还允许重试。
 *
 * @param kind         失败分类
 * @param attemptsMade **含本次**的累计尝试次数（从 1 开始）
 *
 * `RetryPolicy.attempts` 的契约定义是「最大尝试次数（含首次）」
 * （`packages/contracts/src/queues.ts`），所以：
 * - TRANSIENT（attempts=3）：第 1、2 次失败后继续，第 3 次失败后停 → 共 3 次
 * - SCHEMA_INVALID（attempts=1）：第 1 次失败后就停 → 共 1 次
 * - UNAUTHORIZED / NOT_CONFIGURED / BUDGET_EXCEEDED（attempts=0）：立即停
 */
export function retryDecision(kind: AiFailureKind, attemptsMade: number): RetryDecision {
  const maxAttempts = retryPolicyFor(kind).attempts;
  return attemptsMade >= maxAttempts ? 'STOP' : 'RETRY';
}

/** 未知异常一律按 PERMANENT 处理（不重试）—— 见文件头。 */
export function failureKindOf(error: unknown): AiFailureKind {
  return isAiError(error) ? error.kind : 'PERMANENT';
}

/** 该错误是否应当立刻终止重试。 */
export function shouldStopRetrying(error: unknown, attemptsMade: number): boolean {
  return retryDecision(failureKindOf(error), attemptsMade) === 'STOP';
}

/**
 * Job 名 → 任务类型。
 *
 * ⚠ 必须用 `JobName.*` 常量而不是裸字符串（独立审查 P4）：
 * 生产者侧（`queue.ts` 的 `TASK_TO_JOB_NAME`）用的是常量，
 * 消费者侧写死字面量时，契约改名会变成「我自己的队列拒收我自己的 job」——
 * 而且只有集成测试会间接变红。
 */
export function taskTypeOfJobName(jobName: string): AiTaskType {
  switch (jobName) {
    case JobName.AI_TRANSLATE:
      return AiTaskType.TRANSLATE;
    case JobName.AI_CLASSIFY_SCORE:
      return AiTaskType.SCORE;
    default:
      throw new Error(`Unexpected job name on the ai queue: ${jobName}`);
  }
}

/** 从 job 载荷里读 `contentId`。 */
export function contentIdOfJobData(data: unknown): string {
  const contentId = (data as { contentId?: unknown } | null)?.contentId;
  if (typeof contentId !== 'string' || !/^\d{1,20}$/.test(contentId)) {
    throw new Error(
      `ai job payload must contain a decimal string contentId, got: ${typeof contentId}`,
    );
  }
  return contentId;
}

/** handler 收到的最小 job 形状（与 BullMQ 解耦，便于无 Redis 测试）。 */
export type AiJobLike = {
  /** BullMQ 的 job id（决定幂等键），可选。 */
  id?: string;
  name: string;
  data: unknown;
  attemptsMade: number;
};

/**
 * AI 队列消费者。
 *
 * `handle()` 与 BullMQ 解耦（只依赖 4 个字段），因此可以在没有 Redis 的情况下
 * 完整测试重试判定与错误收敛；`start()` / `close()` 才真正接触 Redis。
 */
export class AiQueueWorker {
  private worker: Worker | null = null;

  constructor(
    private readonly deps: {
      service: AiService;
      connection: ConnectionOptions;
      logger: Logger;
      concurrency?: number;
      /** `docs/13` 的 Dead Letter 落库。未提供时不记录（测试可显式省略）。 */
      recorder?: JobRunRecorder;
    },
  ) {}

  /** 处理一个 job。抛出的错误决定 BullMQ 是否重试。 */
  async handle(job: AiJobLike): Promise<AiTaskOutcome> {
    const taskType = taskTypeOfJobName(job.name);
    const contentId = contentIdOfJobData(job.data);
    const attempt = job.attemptsMade + 1;
    const startedAt = new Date();

    try {
      const outcome = await this.deps.service.runTask({ taskType, contentId });
      await this.recordJobRun({
        job,
        startedAt,
        attempt,
        status: JobRunStatus.SUCCEEDED,
        errorCode: null,
      });
      this.deps.logger.info({ contentId, taskType, attempt }, 'ai job finished');
      return outcome;
    } catch (error) {
      const kind = failureKindOf(error);
      const decision = retryDecision(kind, attempt);
      const errorCode = isAiError(error) ? String(error.code) : 'AI_REQUEST_FAILED';

      await this.recordJobRun({
        job,
        startedAt,
        attempt,
        // 只有**最终**失败才记 DEAD；中间态由 BullMQ 自己保存。
        status: decision === 'STOP' ? DEAD_LETTER_JOB_RUN_STATUS : JobRunStatus.FAILED,
        errorCode,
      });

      this.deps.logger.error(
        { err: error, contentId, taskType, attempt, failureKind: kind, decision },
        'ai job failed',
      );

      if (decision === 'STOP') {
        // 终止重试。原始错误放进消息里，BullMQ 会把它记在 failedReason 上。
        throw new UnrecoverableError(
          `${kind}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      throw error;
    }
  }

  /**
   * 写一行 `job_runs`。
   *
   * ⚠ **绝不因为记录失败而掩盖原始异常** —— 与 `AiService.recordFailure`
   * 同一原则：JobRun 是观测设施，观测设施坏了不该改变业务结果。
   */
  private async recordJobRun(params: {
    job: AiJobLike;
    startedAt: Date;
    attempt: number;
    status: string;
    errorCode: string | null;
  }): Promise<void> {
    const recorder = this.deps.recorder;
    if (recorder === undefined) return;

    try {
      await recorder.record({
        jobType: params.job.name,
        jobKey: params.job.id ?? null,
        status: params.status as never,
        startedAt: params.startedAt,
        finishedAt: new Date(),
        attempts: params.attempt,
        errorCode: params.errorCode,
        metadata: { queue: AI_QUEUE_NAME },
      });
    } catch (recordingError) {
      this.deps.logger.error(
        { err: recordingError, jobId: params.job.id, jobType: params.job.name },
        'failed to record job run',
      );
    }
  }

  /** 启动消费者。幂等：重复调用不会创建第二个 Worker。 */
  async start(): Promise<void> {
    if (this.worker !== null) return;

    // 启动期自检：Job 名→队列映射、JobId 段数。
    // ⚠ 必须在 `new Worker()` **之前**跑 —— 否则消费者已经起来了，
    // 而映射错误只会在第一次入队时才暴露（那时错误已经离现场很远了）。
    assertQueueMapping();

    this.worker = new Worker(AI_QUEUE_NAME, async (job: Job) => this.handle(job), {
      connection: this.deps.connection,
      concurrency: this.deps.concurrency ?? QUEUE_CONCURRENCY_FOR_AI,
    });

    this.worker.on('failed', (job, error) => {
      this.deps.logger.error(
        { err: error, jobId: job?.id, attemptsMade: job?.attemptsMade },
        'ai job moved to failed',
      );
    });

    this.deps.logger.info({ queue: AI_QUEUE_NAME }, 'ai queue worker started');
  }

  /** 停止消费者。 */
  async close(): Promise<void> {
    const worker = this.worker;
    this.worker = null;
    if (worker !== null) await worker.close();
  }
}
