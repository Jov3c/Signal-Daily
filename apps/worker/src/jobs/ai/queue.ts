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

/** AI 队列名（与 `queue-names.ts` 同源，供调用方少 import 一个文件）。 */
export { AI_QUEUE_NAME };

/* ------------------------------------------------------------------ */
/* 启动期自检                                                          */
/* ------------------------------------------------------------------ */

/**
 * BullMQ 对自定义 jobId 的硬性要求。
 *
 * `bullmq@5` 的 `Job` 构造函数里有这么一条（为兼容旧的 repeatable job 留下的规则）：
 *
 * ```js
 * if (this.opts?.jobId?.includes(':') && this.opts?.jobId?.split(':').length !== 3) {
 *   throw new Error('Custom Id cannot contain :');
 * }
 * ```
 *
 * 也就是**含 `:` 的自定义 jobId 必须恰好 3 段**。
 * 这条约束是运行期的，`tsc` 完全管不着 —— 独立审查实测：
 * 本模块的 `translateJobId()` 曾经产出 `translate:{contentId}`（2 段），
 * 于是 `ai.translate` **一入队就抛异常**，翻译链路整体不可用，
 * 而当时 886 项单测 + 21 项集成测试**全绿**
 * （集成测试自己拼 `it-<random>` 字面量，从不调用 builder）。
 */
export const BULLMQ_JOBID_MIN_SEGMENTS = 3;

/** 该 jobId 是否会被 BullMQ 接受。 */
export function isBullMqAcceptableJobId(jobId: string): boolean {
  if (!jobId.includes(':')) return true;
  return jobId.split(':').length === BULLMQ_JOBID_MIN_SEGMENTS;
}

/**
 * 启动期自检：**在真正入队之前**把两类静默错误打出来。
 *
 * 1. Job 名 → 队列的映射与 `docs/13` 的冻结契约是否一致；
 * 2. 本模块产出的 JobId 是否满足 BullMQ 的段数要求。
 *
 * ⚠ 这个函数**必须被真的调用**，否则就是死代码。
 * 独立审查的反证：把它掏空后作者测试全绿 —— 因为它从来没有调用点。
 * 现在由 `AiQueueWorker.start()` 调用（见 `ai.worker.ts`），
 * 且 `ai-jobid.spec.ts` 会直接断言它会抛错。
 */
export function assertQueueMapping(): void {
  for (const jobName of Object.values(TASK_TO_JOB_NAME)) {
    const mapped = JOB_TO_QUEUE[jobName as keyof typeof JOB_TO_QUEUE];
    if (mapped !== QueueName.AI) {
      throw new Error(`Job ${jobName} is mapped to queue ${mapped}, expected ${QueueName.AI}`);
    }
  }

  // JobId 的段数：用真实的样例参数跑一遍每个 builder。
  const sampleJobIds: [string, string][] = [
    ['classifyScoreJobId', classifyScoreJobId('1', 'v1')],
    ['translateJobId', translateJobId('1', 'v1')],
  ];
  for (const [name, jobId] of sampleJobIds) {
    if (!isBullMqAcceptableJobId(jobId)) {
      throw new Error(
        `${name} produced "${jobId}", which BullMQ will reject ` +
          `(a custom jobId containing ":" must have exactly ${BULLMQ_JOBID_MIN_SEGMENTS} segments)`,
      );
    }
  }
}

/**
 * 入队前对 options 的自检：**重试分档的前提**。
 *
 * `ai.worker.ts` 每次失败都给出 `RETRY` / `STOP`，但 BullMQ 是否再跑一次
 * 完全取决于**入队时**的 `attempts`。若下游自己 `queue.add(...)` 用了
 * BullMQ 默认的 `attempts: 1`，瞬时抖动会在第 1 次就永久失败，
 * 而 handler 那边看不到任何异常。
 */
export function assertEnqueueOptions(attempts: number): void {
  if (attempts < AI_RETRY.transient.attempts) {
    throw new Error(
      `AI jobs must be enqueued with attempts >= ${AI_RETRY.transient.attempts} ` +
        `(AI_RETRY.transient); got ${attempts}. ` +
        'A lower value silently disables the handler retry decisions.',
    );
  }
}

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
 * 因此这里沿用 `aiScore` 的形状扩展成 `translate:{contentId}:{promptVersion}`。
 *
 * ⚠ 两处都是**踩过坑才定下来的**，改动前请先读 `isBullMqAcceptableJobId` 的说明：
 *
 * 1. **必须带 `promptVersion`**。第一版写的是 `translate:{contentId}`，
 *    结果是 prompt 改版后入队会被 JobId 去重掉，历史内容永远无法重新翻译 ——
 *    而契约里 `JobId.aiScore(contentId, promptVersion)` 带版本正是为了避免这件事。
 * 2. **必须是 3 段**。含 `:` 的自定义 jobId 只有恰好 3 段 BullMQ 才接受，
 *    2 段的 `translate:{contentId}` 会在 `queue.add()` 时直接抛
 *    `Custom Id cannot contain :` —— 翻译任务永远进不了队列。
 *
 * ⚠ 这是**在契约给出的 builder 之外新增的一个格式**，已按 §7 提 CCR 第 1 项，
 * 建议 Agent 14 把它补进 `packages/contracts/src/queues.ts` 的 `JobId`。
 */
export function translateJobId(contentId: string, promptVersion: string): string {
  return `translate:${contentId}:${promptVersion}`;
}
