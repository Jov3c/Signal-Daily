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
 */
export const JobId = {
  /** `collector:{sourceId}:{window}` */
  collectorFetchSource: (sourceId: string, window: string): string =>
    `collector:${sourceId}:${window}`,

  /** `normalize:{rawItemId}` */
  normalize: (rawItemId: string): string => `normalize:${rawItemId}`,

  /** `ai-score:{contentId}:{promptVersion}` */
  aiScore: (contentId: string, promptVersion: string): string =>
    `ai-score:${contentId}:${promptVersion}`,

  /** `daily-draft:{businessDate}` */
  dailyDraft: (businessDate: string): string => `daily-draft:${businessDate}`,
} as const;

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
