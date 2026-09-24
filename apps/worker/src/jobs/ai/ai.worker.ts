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
 * `retryDecision()` 是纯函数，因此「哪种错重试几次」可以被直接断言，
 * 而不需要真的把 Redis 跑起来。真实 Redis 上的端到端次数由
 * `ai-queue.integration.spec.ts` 再验一遍。
 *
 * ── `attemptsMade` 的语义假设 ────────────────────────────────────────
 * BullMQ 的 `job.attemptsMade` 在不同版本里对「本次是否已计入」的处理不一致，
 * 因此本文件统一按 **`attemptsMade + 1` = 含本次的累计尝试次数** 来解释，
 * 并把这一假设**写成可被真 Redis 测试推翻的断言**
 * （`ai-queue.integration.spec.ts` 断言：瞬时错误恰好 3 次、凭据错误恰好 1 次）。
 * 如果 BullMQ 的实际语义不同，那条测试会变红而不是让重试次数静默翻倍。
 */

import { UnrecoverableError, Worker, type ConnectionOptions, type Job } from 'bullmq';
import { AiTaskType } from '@signal/contracts';
import type { Logger } from '@signal/logger';
import { isAiError } from './ai.errors';
import type { AiService, AiTaskOutcome } from './ai.service';
import { retryPolicyFor } from './ai.errors';
import type { AiFailureKind } from './ai.types';
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

/** Job 名 → 任务类型。未登记的 Job 名一律拒绝。 */
export function taskTypeOfJobName(jobName: string): AiTaskType {
  switch (jobName) {
    case 'ai.translate':
      return AiTaskType.TRANSLATE;
    case 'ai.classify-score':
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

/**
 * AI 队列消费者。
 *
 * `handle()` 与 BullMQ 解耦（只依赖 `{name, data, attemptsMade}` 三个字段），
 * 因此可以在没有 Redis 的情况下完整测试重试判定与错误收敛；
 * `start()` / `close()` 才真正接触 Redis。
 */
export class AiQueueWorker {
  private worker: Worker | null = null;

  constructor(
    private readonly deps: {
      service: AiService;
      connection: ConnectionOptions;
      logger: Logger;
      concurrency?: number;
    },
  ) {}

  /** 处理一个 job。抛出的错误决定 BullMQ 是否重试。 */
  async handle(job: { name: string; data: unknown; attemptsMade: number }): Promise<AiTaskOutcome> {
    const taskType = taskTypeOfJobName(job.name);
    const contentId = contentIdOfJobData(job.data);
    const attempt = job.attemptsMade + 1;

    try {
      const outcome = await this.deps.service.runTask({ taskType, contentId });
      this.deps.logger.info({ contentId, taskType, attempt }, 'ai job finished');
      return outcome;
    } catch (error) {
      const kind = failureKindOf(error);
      const decision = retryDecision(kind, attempt);

      this.deps.logger.error(
        { err: error, contentId, taskType, attempt, failureKind: kind, decision },
        'ai job failed',
      );

      if (decision === 'STOP') {
        // 终止重试。原始错误放进 `cause`，BullMQ 会把它记在 failedReason 上。
        throw new UnrecoverableError(
          `${kind}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      throw error;
    }
  }

  /** 启动消费者。幂等：重复调用不会创建第二个 Worker。 */
  async start(): Promise<void> {
    if (this.worker !== null) return;

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
