/**
 * `content-pipeline` 队列的入队契约。
 *
 * ── ⚠ `JobId.normalize` 是坏的，这是本文件存在的第一个理由 ────────────
 * 契约 `packages/contracts/src/queues.ts` 里：
 *
 * ```ts
 * normalize: (rawItemId: string): string => `normalize:${rawItemId}`,
 * ```
 *
 * 它产出 **2 段**。而 `bullmq@5` 的 `Job` 构造函数有这条规则
 * （`dist/classes/job.js`，为兼容旧的 repeatable job 而留）：
 *
 * ```js
 * if (this.opts?.jobId?.includes(':') && this.opts?.jobId?.split(':').length !== 3) {
 *   throw new Error('Custom Id cannot contain :');
 * }
 * ```
 *
 * 也就是**含 `:` 的自定义 jobId 必须恰好 3 段**。真 Redis 实测（本机 6390）：
 *
 * ```text
 * REJECTED  contract JobId.normalize(rawItemId)  normalize:123      -> Custom Id cannot contain :
 * ACCEPTED  contract JobId.collectorFetchSource  collector:1:2026-09-29
 * ACCEPTED  contract JobId.aiScore               ai-score:123:v1
 * ACCEPTED  本模块的 3 段形态                     normalize:123:v1
 * ```
 *
 * 这条最早由 Agent 06 的独立审查发现并提了
 * `handoffs/CONTRACT_CHANGE_REQUEST-agent-06.md` 第 0 项，**至今无人裁决**。
 * 按 §7「一般 Agent 不得自行修改公共契约」，我不改 `packages/contracts`；
 * 改用本文件里的 3 段 builder，并把这件事记进 Agent 05 的 CCR。
 *
 * ── 第二个理由：第三段该是什么 ──────────────────────────────────────
 * `aiScore` 的第三段是 `promptVersion`，语义是「prompt 改版后要能重跑」。
 * normalize 的对应物是**归一化规则的版本**：清洗策略、正文提取算法、
 * 类型推导规则变了，历史内容就应当能被重新归一化。
 * 所以第三段取 `NORMALIZER_VERSION` —— 它不是为了让段数凑够 3，
 * 而是一个**真实存在、会变化、且需要参与幂等键**的维度。
 */

import {
  BULLMQ_JOBID_SEGMENTS,
  JobId,
  JobName,
  JOB_TO_QUEUE,
  QueueName,
  type RetryPolicy,
} from '@signal/contracts';

/**
 * 归一化规则的版本。
 *
 * **改动任何影响 `Content` 字段的规则时都要升这个号** ——
 * 包括 `html/policy.ts` 的白名单、`html/extract.ts` 的容器选择、
 * `normalize/content-type.ts` 的类型推导、以及标题/正文的回退逻辑。
 *
 * 升版本的实际效果：`normalize:{rawItemId}:{version}` 变了 →
 * 同一个 RawItem 可以再次入队（不会被 JobId 去重掉）→ 历史内容可重跑。
 */
export const NORMALIZER_VERSION = 'v1';

/**
 * 入队选项。
 *
 * ⚠ **重试策略是本地默认值，不是契约值。** `docs/13` 的 Retry 一节只定义了
 * Collector（3 次指数退避）/ AI（3、1、0 三档）/ Publishing（3 次），
 * **没有 content-pipeline**。这里取与 Collector 相同的档位
 *（3 次、指数退避），因为两者的失败模式相近：都是对外部数据的处理，
 * 瞬时故障重试有意义，而结构性错误重试无用。
 * 已记入 Agent 05 的 CCR，请 Agent 14 在契约里补齐这一档。
 */
export const CONTENT_PIPELINE_RETRY: RetryPolicy = {
  attempts: 3,
  backoff: { type: 'exponential', delayMs: 5_000 },
};

/** `content.normalize` 的 job 载荷。 */
export type ContentNormalizeJobData = {
  rawItemId: string;
};

/** 入队选项（BullMQ 的形状：`delay` 而不是契约里的 `delayMs`）。 */
export const CONTENT_PIPELINE_JOB_OPTIONS = {
  attempts: CONTENT_PIPELINE_RETRY.attempts,
  backoff:
    CONTENT_PIPELINE_RETRY.backoff === null
      ? undefined
      : {
          type: CONTENT_PIPELINE_RETRY.backoff.type,
          delay: CONTENT_PIPELINE_RETRY.backoff.delayMs,
        },
  removeOnComplete: { age: 24 * 3600, count: 1_000 },
  // `docs/13` 的 Dead Letter：最终失败 BullMQ 保留，后台可人工重试。
  removeOnFail: false,
} as const;

/**
 * 生成 `content.normalize` 的幂等 JobId。
 *
 * 见文件头：契约的 `JobId.normalize` 是 2 段、会被 BullMQ 拒绝，
 * 因此这里用 3 段形态。第三段是归一化规则版本（不是凑数）。
 */
export function normalizeJobId(rawItemId: string, version: string = NORMALIZER_VERSION): string {
  // ⚠ 委托契约的唯一真源（2026-09-30 统一）。第三段仍是**归一化规则版本** ——
  // 它不是为了凑段数，而是「规则改版后历史内容要能重跑」的幂等键。
  return JobId.normalize(rawItemId, version);
}

/** BullMQ 对自定义 jobId 的段数要求（含 `:` 时必须恰好 3 段）。 */
export const BULLMQ_JOBID_MIN_SEGMENTS = BULLMQ_JOBID_SEGMENTS;

/** 该 jobId 是否会被 BullMQ 接受。 */
/** 段数判定（唯一实现在契约里）。 */
export function isBullMqAcceptableJobId(jobId: string): boolean {
  if (!jobId.includes(':')) return true;
  return jobId.split(':').length === BULLMQ_JOBID_MIN_SEGMENTS;
}

/**
 * 启动期自检。
 *
 * ⚠ 必须**真的被调用**，否则就是死代码 —— Agent 06 的独立审查正是在
 * 那里发现「`assertQueueMapping()` 从来没有调用点，掏空它测试仍全绿」。
 * 本模块由 `ContentPipelineWorker.start()` 调用。
 */
export function assertContentQueueContract(): void {
  // 1) Job 名 → 队列的映射必须与契约一致。
  const mapped = JOB_TO_QUEUE[JobName.CONTENT_NORMALIZE];
  if (mapped !== QueueName.CONTENT_PIPELINE) {
    throw new Error(
      `Job ${JobName.CONTENT_NORMALIZE} is mapped to queue ${mapped}, ` +
        `expected ${QueueName.CONTENT_PIPELINE}`,
    );
  }

  // 2) 本模块产出的 JobId 必须能被 BullMQ 接受。
  const sample = normalizeJobId('1');
  if (!isBullMqAcceptableJobId(sample)) {
    throw new Error(
      `normalizeJobId produced "${sample}", which BullMQ will reject ` +
        `(a custom jobId containing ":" must have exactly ${BULLMQ_JOBID_MIN_SEGMENTS} segments)`,
    );
  }

  // 3) 入队 attempts 不能被调低到 handler 依赖的下限以下。
  if (CONTENT_PIPELINE_JOB_OPTIONS.attempts < 1) {
    throw new Error('content-pipeline jobs must allow at least one attempt');
  }
}

/**
 * 与契约 `JobId.aiScore` 的一致性自检（供测试断言用）。
 *
 * ⚠ **2026-09-30 已修复**：契约的 builder 原先有 2/4 个产出 2 段
 *（`normalize` 与 `dailyDraft`），照契约用等于「入队必炸」。
 * 统一之后六个 builder 全部 3 段，本模块改为**委托** `JobId.normalize`。
 *
 * 这个函数保留下来只为一件事：让「契约又被改坏」这件事**立刻可见**
 *（值从 `true` 变成 `false` 就是信号）。**不要再把它当成「契约是坏的」的证据。**
 */
export function isContractNormalizeJobIdUsable(): boolean {
  return isBullMqAcceptableJobId(JobId.normalize('1', 'v1'));
}
