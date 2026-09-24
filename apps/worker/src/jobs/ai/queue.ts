/**
 * AI 任务的入队契约 —— 供 Agent 05 / 07 / 08 调用。
 *
 * ── 为什么入队要单独抽一层 ───────────────────────────────────────────
 * `docs/13` 的 JobId 幂等规则与「AI 重试 3 次」的策略都必须在**入队时**确定
 * （BullMQ 的 `attempts` 是 job 属性，跑起来之后改不了）。
 * 如果让每个调用方自己 `new Queue(...).add(...)`，就会出现
 * 「有的地方忘了带 JobId、有的地方 attempts 写成了 5」这类静默不一致。
 *
 * ── 重试策略的落法（关键）──────────────────────────────────────────
 * 入队时统一给 `attempts = AI_RETRY.transient.attempts`（最大档，3 次），
 * 实际该重试几次由 **handler 在失败时**用 `UnrecoverableError` 提前终止
 * （见 `ai.worker.ts` 的 `retryDecision`）。
 *
 * 为什么反过来做：`attempts` 只能在入队时设置，而**失败原因只有跑完才知道**。
 * 一个 401（凭据错）和一个 503（上游抖动）在入队那一刻是完全一样的。
 * 所以取最大档位入队，再在失败处按 `AiError.kind` 收紧 ——
 * 这是 BullMQ 唯一能表达「按失败原因决定重试」的方式。
 */

import {
  AI_RETRY,
  JobId,
  JobName,
  JOB_TO_QUEUE,
  QueueName,
  type AiTaskType,
} from '@signal/contracts';
import { AI_QUEUE_NAME } from './queue-names';

/** `ai.translate` 的 job 载荷。 */
export type AiTranslateJobData = {
  contentId: string;
};

/** `ai.classify-score` 的 job 载荷。 */
export type AiClassifyScoreJobData = {
  contentId: string;
};

export type AiJobData = AiTranslateJobData | AiClassifyScoreJobData;

/** 任务 → Job 名。**只有本模块支持的任务才有出口。** */
export const TASK_TO_JOB_NAME: Readonly<Partial<Record<AiTaskType, string>>> = {
  TRANSLATE: JobName.AI_TRANSLATE,
  SCORE: JobName.AI_CLASSIFY_SCORE,
};

/**
 * 入队选项。
 *
 * `attempts` 取 `AI_RETRY.transient.attempts` —— 见文件头说明。
 */
export const AI_JOB_OPTIONS = {
  attempts: AI_RETRY.transient.attempts,
  backoff:
    AI_RETRY.transient.backoff === null
      ? undefined
      : { type: AI_RETRY.transient.backoff.type, delay: AI_RETRY.transient.backoff.delayMs },
  /**
   * 完成的 job 保留一段时间便于排查，失败的长期保留（`docs/13`：
   * 「BullMQ 保留」）。具体数值是运维取舍，Agent 11 可调。
   */
  removeOnComplete: { age: 24 * 3600, count: 1_000 },
  removeOnFail: false,
} as const;

/** 校验 Job 名与队列的映射没写错（`docs/13` 的 Frozen Contract）。 */
export function assertQueueMapping(): void {
  for (const jobName of Object.values(TASK_TO_JOB_NAME)) {
    const mapped = JOB_TO_QUEUE[jobName as keyof typeof JOB_TO_QUEUE];
    if (mapped !== QueueName.AI) {
      throw new Error(`Job ${jobName} is mapped to queue ${mapped}, expected ${QueueName.AI}`);
    }
  }
}

/** AI 队列名（与 `queue-names.ts` 同源，供调用方少 import 一个文件）。 */
export { AI_QUEUE_NAME };

/**
 * 生成 `ai.classify-score` 的幂等 JobId。
 *
 * `docs/13` 的示例是 `ai-score:{contentId}:{promptVersion}`，
 * 契约里也有现成的 builder（`JobId.aiScore`）——
 * **必须用它**，不要自己拼字符串（Agent 00 的硬性要求）。
 *
 * 带 `promptVersion` 的直接后果：prompt 改版后重新入队**不会被去重**，
 * 因而历史内容可以被新标准重评，而旧分数仍能追溯到旧版本。
 */
export function classifyScoreJobId(contentId: string, promptVersion: string): string {
  return JobId.aiScore(contentId, promptVersion);
}

/**
 * 生成 `ai.translate` 的幂等 JobId。
 *
 * 契约里没有 translate 专用的 builder（`JobId` 只有 4 个），
 * 因此这里沿用 `normalize:` 的形状扩展成 `translate:{contentId}`。
 * ⚠ 这是**在契约给出的 builder 之外新增的一个格式**，已按 §7 提 CCR，
 * 建议 Agent 14 把它补进 `packages/contracts/src/queues.ts` 的 `JobId`。
 */
export function translateJobId(contentId: string): string {
  return `translate:${contentId}`;
}
