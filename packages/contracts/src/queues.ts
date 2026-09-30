/**
 * Signal Queue / Job 契约 — BullMQ 名称、幂等 JobId 与重试策略。
 *
 * 对应 `docs/13-queue-scheduler.md` v1.1。
 * Frozen Contract：禁止创建近义 Queue 或近义 Job 名。
 */

/* ------------------------------------------------------------------ */
/* Queue names                                                         */
/* ------------------------------------------------------------------ */

export const QueueName = {
  COLLECTOR: 'collector',
  CONTENT_PIPELINE: 'content-pipeline',
  AI: 'ai',
  PUBLISHING: 'publishing',
  NOTIFICATION: 'notification',
  MAINTENANCE: 'maintenance',
} as const;

export type QueueNameValue = (typeof QueueName)[keyof typeof QueueName];

export const QUEUE_NAMES = Object.values(QueueName);

/* ------------------------------------------------------------------ */
/* Job names                                                           */
/* ------------------------------------------------------------------ */

export const JobName = {
  COLLECTOR_FETCH_SOURCE: 'collector.fetch-source',
  CONTENT_NORMALIZE: 'content.normalize',
  CONTENT_DEDUP: 'content.dedup',
  CONTENT_EVENT_CLUSTER: 'content.event-cluster',
  AI_TRANSLATE: 'ai.translate',
  AI_CLASSIFY_SCORE: 'ai.classify-score',
  PUBLISHING_DAILY_DRAFT: 'publishing.daily-draft',
  PUBLISHING_DAILY_PUBLISH: 'publishing.daily-publish',
  NOTIFICATION_ADMIN_EMAIL: 'notification.admin-email',
  MAINTENANCE_CLEANUP: 'maintenance.cleanup',
} as const;

export type JobNameValue = (typeof JobName)[keyof typeof JobName];

export const JOB_NAMES = Object.values(JobName);

/** Job 名 → 所属 Queue。用于注册 Worker 时避免挂错队列。 */
export const JOB_TO_QUEUE: Readonly<Record<JobNameValue, QueueNameValue>> = {
  [JobName.COLLECTOR_FETCH_SOURCE]: QueueName.COLLECTOR,
  [JobName.CONTENT_NORMALIZE]: QueueName.CONTENT_PIPELINE,
  [JobName.CONTENT_DEDUP]: QueueName.CONTENT_PIPELINE,
  [JobName.CONTENT_EVENT_CLUSTER]: QueueName.CONTENT_PIPELINE,
  [JobName.AI_TRANSLATE]: QueueName.AI,
  [JobName.AI_CLASSIFY_SCORE]: QueueName.AI,
  [JobName.PUBLISHING_DAILY_DRAFT]: QueueName.PUBLISHING,
  [JobName.PUBLISHING_DAILY_PUBLISH]: QueueName.PUBLISHING,
  [JobName.NOTIFICATION_ADMIN_EMAIL]: QueueName.NOTIFICATION,
  [JobName.MAINTENANCE_CLEANUP]: QueueName.MAINTENANCE,
};

/* ------------------------------------------------------------------ */
/* Idempotent JobId builders                                           */
/* ------------------------------------------------------------------ */

/**
 * JobId 决定 BullMQ 幂等。同参数重复入队必须得到同一个 JobId。
 * 禁止各模块自行拼接 JobId 字符串，一律使用下列 builder。
 *
 * ── ⚠ `bullmq@5` 的硬规则：含 `:` 的 jobId 必须**恰好 3 段** ────────
 *
 * `bullmq` 的 `Job` 构造函数里有这条（为兼容旧的 repeatable job 而留）：
 *
 * ```js
 * if (this.opts?.jobId?.includes(':') && this.opts?.jobId?.split(':').length !== 3) {
 *   throw new Error('Custom Id cannot contain :');
 * }
 * ```
 *
 * 也就是 2 段会被**同步拒绝**（`queue.add()` 直接抛，不是异步失败）。
 *
 * ── 这段注释记着一件不该再发生的事 ──────────────────────────────────
 * 本契约原先有 **2/4 个 builder 产出 2 段**（`normalize` 与 `dailyDraft`），
 * 于是「照着契约用」等于「入队必炸」。这件事被**四个 Agent 各自发现、
 * 各自绕过了一遍**：
 *
 * ```text
 * Agent 06  独立审查发现，提 CCR 第 0 项（并自造 translateJobId）
 * Agent 05  在自己的 CCR 里重申（并自造 3 段 normalizeJobId）
 * Agent 08  自造 dailyDraftJobId / dailyPublishJobId，并补了**真 Redis 证据**
 * Agent 10  再次记录
 * ```
 *
 * **四份重复实现就是「没在源头修」的成本。** 2026-09-30 统一：
 * 六个 builder 全部产出 3 段，第三段都是**真实存在、会变化、且需要参与
 * 幂等键**的维度（不是为了让段数凑够 3）：
 *
 * | builder | 第三段 | 为什么它必须在幂等键里 |
 * | ------- | ------ | ---------------------- |
 * | `collectorFetchSource` | `window` | 同一来源的不同抓取窗口是不同任务 |
 * | `normalize` | `ruleVersion` | 清洗/提取规则改版后，历史内容要能重新归一化 |
 * | `aiScore` / `aiTranslate` | `promptVersion` | prompt 改版后必须能重评/重译 |
 * | `dailyDraft` / `dailyPublish` | `slot` | **同一业务日有多趟**（00:10/05:30/07:00/08:00）—— 段数不区分的话，BullMQ 会把后一趟当重复任务**直接丢掉且不报错** |
 *
 * `assertAllJobIdBuildersAreAcceptable()` 是执行期的不变式，
 * `queues.spec.ts` 里有一条守卫对着**每一个** builder 断言它可以被 BullMQ 接受。
 */
export const JobId = {
  /** `collector:{sourceId}:{window}` */
  collectorFetchSource: (sourceId: string, window: string): string =>
    `collector:${sourceId}:${window}`,

  /** `normalize:{rawItemId}:{ruleVersion}` —— ⚠ 第三段是**必需**的（见上方说明）。 */
  normalize: (rawItemId: string, ruleVersion: string): string =>
    `normalize:${rawItemId}:${ruleVersion}`,

  /** `ai-score:{contentId}:{promptVersion}` */
  aiScore: (contentId: string, promptVersion: string): string =>
    `ai-score:${contentId}:${promptVersion}`,

  /** `translate:{contentId}:{promptVersion}` */
  aiTranslate: (contentId: string, promptVersion: string): string =>
    `translate:${contentId}:${promptVersion}`,

  /** `daily-draft:{businessDate}:{slot}` —— ⚠ 第三段是**必需**的（见上方说明）。 */
  dailyDraft: (businessDate: string, slot: string): string => `daily-draft:${businessDate}:${slot}`,

  /** `daily-publish:{businessDate}:{slot}` */
  dailyPublish: (businessDate: string, slot: string): string =>
    `daily-publish:${businessDate}:${slot}`,
} as const;

/** `bullmq@5` 对含 `:` 的自定义 jobId 要求的段数。 */
export const BULLMQ_JOBID_SEGMENTS = 3;

/** 该 jobId 是否会被 BullMQ 接受（不含 `:` 的 id 不受这条规则约束）。 */
export function isBullMqAcceptableJobId(jobId: string): boolean {
  if (!jobId.includes(':')) return true;
  return jobId.split(':').length === BULLMQ_JOBID_SEGMENTS;
}

/**
 * 执行期不变式：**每一个** builder 的产物都必须能被 BullMQ 接受。
 *
 * ⚠ 必须**真的被调用**，否则就是死代码 —— 本项目已经有过一次教训
 *（Agent 06 的独立审查发现「`assertQueueMapping()` 从来没有调用点，
 * 掏空它测试仍全绿」）。
 *
 * 调用点：`queues.spec.ts` 的守卫，以及各 worker 模块的启动自检。
 */
export function assertAllJobIdBuildersAreAcceptable(): void {
  const samples: [string, string][] = [
    ['collectorFetchSource', JobId.collectorFetchSource('1', 'w')],
    ['normalize', JobId.normalize('1', 'v1')],
    ['aiScore', JobId.aiScore('1', 'v1')],
    ['aiTranslate', JobId.aiTranslate('1', 'v1')],
    ['dailyDraft', JobId.dailyDraft('2026-09-30', '0530')],
    ['dailyPublish', JobId.dailyPublish('2026-09-30', '0800')],
  ];

  const problems = samples
    .filter(([, jobId]) => !isBullMqAcceptableJobId(jobId))
    .map(
      ([name, jobId]) =>
        `${name} -> ${jobId}（${String(jobId.split(':').length)} 段，BullMQ 要求 ${String(BULLMQ_JOBID_SEGMENTS)} 段）`,
    );

  if (problems.length > 0) {
    throw new Error(
      `JobId 契约被破坏 —— 这些 builder 的产物会让 queue.add() 同步抛错：\n- ${problems.join('\n- ')}`,
    );
  }
}

/* ------------------------------------------------------------------ */
/* Concurrency                                                         */
/* ------------------------------------------------------------------ */

/** 初始并发度。 */
export const QUEUE_CONCURRENCY: Readonly<Record<QueueNameValue, number>> = {
  [QueueName.COLLECTOR]: 5,
  [QueueName.CONTENT_PIPELINE]: 8,
  [QueueName.AI]: 3,
  [QueueName.PUBLISHING]: 1,
  [QueueName.NOTIFICATION]: 2,
  [QueueName.MAINTENANCE]: 1,
};

/* ------------------------------------------------------------------ */
/* Retry policy                                                        */
/* ------------------------------------------------------------------ */

export type RetryPolicy = {
  /** 最大尝试次数（含首次）。0 表示不重试。 */
  attempts: number;
  /** 退避策略。 */
  backoff: { type: 'exponential' | 'fixed'; delayMs: number } | null;
};

/** Collector：3 次指数退避。 */
export const COLLECTOR_RETRY: RetryPolicy = {
  attempts: 3,
  backoff: { type: 'exponential', delayMs: 5_000 },
};

/**
 * AI：timeout / 429 / 5xx 重试 3 次；
 * schema invalid 只重试 1 次；unsupported 不重试。
 */
export const AI_RETRY: Readonly<{
  transient: RetryPolicy;
  schemaInvalid: RetryPolicy;
  unsupported: RetryPolicy;
}> = {
  transient: { attempts: 3, backoff: { type: 'exponential', delayMs: 3_000 } },
  schemaInvalid: { attempts: 1, backoff: null },
  unsupported: { attempts: 0, backoff: null },
};

/** Publishing：3 次，但 publish job 必须自身幂等。 */
export const PUBLISHING_RETRY: RetryPolicy = {
  attempts: 3,
  backoff: { type: 'exponential', delayMs: 10_000 },
};

/** 最终失败后 JobRun 记为 DEAD，BullMQ 保留，后台可人工重试。 */
export const DEAD_LETTER_JOB_RUN_STATUS = 'DEAD' as const;
