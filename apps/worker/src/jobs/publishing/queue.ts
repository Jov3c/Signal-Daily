/**
 * `publishing` 队列的入队契约。
 *
 * ── ⚠⚠ `JobId.dailyDraft` 是坏的，这是本文件存在的第一个理由 ──────────
 * 契约 `packages/contracts/src/queues.ts` 里：
 *
 * ```ts
 * dailyDraft: (businessDate: string): string => `daily-draft:${businessDate}`,
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
 * REJECTED  contract JobId.dailyDraft   daily-draft:2026-09-29  -> Custom Id cannot contain :
 * ACCEPTED  contract JobId.aiScore      ai-score:123:v1
 * ACCEPTED  本模块的 3 段形态            daily-draft:2026-09-29:0530
 * ```
 *
 * 这条最早由 Agent 06 的独立审查发现并提了
 * `handoffs/CONTRACT_CHANGE_REQUEST-agent-06.md` 第 0 项，
 * Agent 05 也重申过一次，**至今无人裁决**。按 §7「一般 Agent 不得自行修改
 * 公共契约」，我不改 `packages/contracts`；改用本文件里的 3 段 builder，
 * 并把这件事记进 Agent 08 的 CCR。
 *
 * ── 第二个理由：第三段该是什么（这不是凑段数）──────────────────────
 * `aiScore` 的第三段是 `promptVersion`（prompt 改版后要能重跑），
 * `normalize` 的第三段是归一化规则版本。它们的共性是：
 * **一个真实存在、会变化、且需要参与幂等键的维度**。
 *
 * 本模块的这个维度是**调度槽（slot）**，而且比上面两个更硬：
 * `docs/10` 的「建议调度」在**同一个业务日**上有**两次草稿生成**
 *（05:30 生成初始 draft、07:00 刷新候选）。如果第三段不区分它们，
 * 两次会得到同一个 jobId —— BullMQ 会把第二次**直接丢掉**，
 * 07:00 的刷新**永远不会执行**，而且不报任何错。
 *
 * 所以 `slot` 不是为了让段数凑够 3：它是「这一天里的哪一趟」，
 * 天然就该在幂等键里。同一趟重试复用同一个 jobId（这正是要的），
 * 不同趟各自独立。
 *
 * ── 槽位与 Job 的映射 ──────────────────────────────────────────────
 *
 * ```text
 * 0010  INIT_DRAFT      初始化当天 DRAFT        -> job publishing.daily-draft
 * 0530  GENERATE_DRAFT  生成初始 draft          -> job publishing.daily-draft
 * 0700  REFRESH_DRAFT   刷新候选                -> job publishing.daily-draft
 * 0730  REVIEW_REMINDER 未 REVIEWING 则提醒管理员 -> **不产生 Job**（见下）
 * 0800  PUBLISH         只有 SCHEDULED 才发布    -> job publishing.daily-publish
 * ```
 *
 * ⚠ `0730` 那一趟**刻意不入队**：`docs/13` 固定了 10 个 Job 名，
 * 里面**没有**「日报提醒」这一类，而 §6 禁止创建近义 Job。
 * 它由 `scheduler.ts` 在进程内直接完成（写一行 `admin_notifications`），
 * 与 Agent 07 的通知做法一致。
 */

import {
  BULLMQ_JOBID_SEGMENTS as CONTRACT_BULLMQ_JOBID_SEGMENTS,
  isBullMqAcceptableJobId,
  JobId,
  JobName,
  JOB_TO_QUEUE,
  PUBLISHING_RETRY,
  QueueName,
  type RetryPolicy,
} from '@signal/contracts';

/* ------------------------------------------------------------------ */
/* 调度槽                                                              */
/* ------------------------------------------------------------------ */

/**
 * 槽位标识（`HHmm`，**上海业务时区**的钟点）。
 *
 * 用字符串而不是数字：它是幂等键的一段，`0530` 与 `530` 在数字上是同一个值，
 * 但在 jobId 里是**两个不同的键** —— 一处写成数字、一处写成补零字符串，
 * 就会静默产生两趟互不认识的执行。
 */
export const PUBLISHING_SLOT = {
  INIT_DRAFT: '0010',
  GENERATE_DRAFT: '0530',
  REFRESH_DRAFT: '0700',
  REVIEW_REMINDER: '0730',
  PUBLISH: '0800',
} as const;

export type PublishingSlot = (typeof PUBLISHING_SLOT)[keyof typeof PUBLISHING_SLOT];

/** 槽位 → 上海时间的小时/分钟。 */
export const SLOT_TIME: Readonly<Record<PublishingSlot, { hour: number; minute: number }>> = {
  [PUBLISHING_SLOT.INIT_DRAFT]: { hour: 0, minute: 10 },
  [PUBLISHING_SLOT.GENERATE_DRAFT]: { hour: 5, minute: 30 },
  [PUBLISHING_SLOT.REFRESH_DRAFT]: { hour: 7, minute: 0 },
  [PUBLISHING_SLOT.REVIEW_REMINDER]: { hour: 7, minute: 30 },
  [PUBLISHING_SLOT.PUBLISH]: { hour: 8, minute: 0 },
};

/** 全部槽位，**按时间先后**（调度器依赖这个顺序做追赶）。 */
export const PUBLISHING_SLOTS_IN_ORDER: readonly PublishingSlot[] = [
  PUBLISHING_SLOT.INIT_DRAFT,
  PUBLISHING_SLOT.GENERATE_DRAFT,
  PUBLISHING_SLOT.REFRESH_DRAFT,
  PUBLISHING_SLOT.REVIEW_REMINDER,
  PUBLISHING_SLOT.PUBLISH,
];

/** 会产生 Job 的槽位 → Job 名。 */
export const SLOT_JOB_NAME: Readonly<Partial<Record<PublishingSlot, string>>> = {
  [PUBLISHING_SLOT.INIT_DRAFT]: JobName.PUBLISHING_DAILY_DRAFT,
  [PUBLISHING_SLOT.GENERATE_DRAFT]: JobName.PUBLISHING_DAILY_DRAFT,
  [PUBLISHING_SLOT.REFRESH_DRAFT]: JobName.PUBLISHING_DAILY_DRAFT,
  [PUBLISHING_SLOT.PUBLISH]: JobName.PUBLISHING_DAILY_PUBLISH,
};

/* ------------------------------------------------------------------ */
/* 入队选项                                                            */
/* ------------------------------------------------------------------ */

/**
 * 入队选项。
 *
 * 重试策略**取契约值**（`docs/13`：Publishing 3 次指数退避）——
 * 这一档契约里有，不需要本地兜底（与 Agent 05 的 content-pipeline 不同）。
 *
 * `attempts` 必须真的是 3：`docs/13` 说「publish job 必须自身幂等」，
 * 而重试 3 次的前提正是幂等 —— 两者是配套的，改一个要改另一个。
 */
export const PUBLISHING_JOB_OPTIONS = {
  attempts: PUBLISHING_RETRY.attempts,
  backoff:
    PUBLISHING_RETRY.backoff === null
      ? undefined
      : { type: PUBLISHING_RETRY.backoff.type, delay: PUBLISHING_RETRY.backoff.delayMs },
  removeOnComplete: { age: 24 * 3600, count: 1_000 },
  // `docs/13` 的 Dead Letter：最终失败 BullMQ 保留，后台可人工重试。
  removeOnFail: false,
} as const;

/** 本模块用到的重试策略（导出给测试断言，避免测试自己抄一遍数字）。 */
export const PUBLISHING_RETRY_POLICY: RetryPolicy = PUBLISHING_RETRY;

/* ------------------------------------------------------------------ */
/* JobId                                                               */
/* ------------------------------------------------------------------ */

/** BullMQ 对自定义 jobId 的段数要求（含 `:` 时必须恰好 3 段）。 */
export const BULLMQ_JOBID_SEGMENTS = CONTRACT_BULLMQ_JOBID_SEGMENTS;

/** 该 jobId 是否会被 BullMQ 接受。实现见 `@signal/contracts`，全仓唯一。 */
export { isBullMqAcceptableJobId };

/**
 * 生成 `publishing.daily-draft` 的幂等 JobId。
 *
 * 见文件头：契约的 `JobId.dailyDraft` 是 2 段、会被 BullMQ 拒绝，
 * 因此这里用 3 段形态。第三段是**调度槽**（不是凑数）。
 */
export function dailyDraftJobId(businessDate: string, slot: PublishingSlot): string {
  // ⚠ 委托契约的唯一真源（2026-09-30 统一；此前是本模块自造的）。
  // 第三段 `slot` 是必需的：同一业务日有多趟草稿生成。
  return JobId.dailyDraft(businessDate, slot);
}

/** 生成 `publishing.daily-publish` 的幂等 JobId（同样是 3 段，理由同上）。 */
export function dailyPublishJobId(businessDate: string, slot: PublishingSlot): string {
  return JobId.dailyPublish(businessDate, slot);
}

/* ------------------------------------------------------------------ */
/* Job 载荷                                                            */
/* ------------------------------------------------------------------ */

/** 两个 publishing Job 的载荷 —— 都只需要业务日（槽位在 jobId 里）。 */
export type PublishingJobData = {
  /** 上海业务日 `YYYY-MM-DD`。 */
  businessDate: string;
  /** 该 job 属于哪一趟调度。进了载荷是为了日志与审计可读，**不参与幂等**。 */
  slot: PublishingSlot;
};

/** 校验一个未知载荷是不是本模块的 Job 载荷。 */
export function isPublishingJobData(value: unknown): value is PublishingJobData {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  if (typeof record['businessDate'] !== 'string') return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(record['businessDate'])) return false;
  return (
    typeof record['slot'] === 'string' &&
    Object.values(PUBLISHING_SLOT).includes(record['slot'] as PublishingSlot)
  );
}

/* ------------------------------------------------------------------ */
/* 启动期自检                                                          */
/* ------------------------------------------------------------------ */

/**
 * 自检的**可注入**输入。
 *
 * ⚠ 为什么把这几项做成参数而不是让函数直接读常量：
 * §23 独立审查指出，此前 `assertPublishingQueueContract` 的测试**只有
 * `not.toThrow()`** —— 那是一条**没有牙齿**的断言：
 * 把函数体掏空、或者删掉其中任何一条检查，测试**仍然是绿的**。
 * （同一份审查还指出：本模块的文件头逐字写着「必须真的被调用，否则就是死代码
 *  —— Agent 06 的独立审查正是在那里发现 `assertQueueMapping()` 从来没有调用点」，
 *  却在同一交付里造了个新的死守卫 `assertStateMachineCoversContract()`。
 *  两条都已修。）
 *
 * 把输入参数化之后，测试可以喂**坏的**输入，断言它**真的会报错**。
 */
export type PublishingQueueChecks = {
  slotJobName?: Readonly<Partial<Record<PublishingSlot, string>>>;
  jobIdSamples?: readonly string[];
  attempts?: number;
};

/** 跑一遍自检，**返回**问题清单（不抛）。 */
export function publishingQueueProblems(checks: PublishingQueueChecks = {}): string[] {
  const problems: string[] = [];
  const slotJobName = checks.slotJobName ?? SLOT_JOB_NAME;

  for (const [slot, jobName] of Object.entries(slotJobName)) {
    if (jobName === undefined) continue;
    const queue = JOB_TO_QUEUE[jobName as keyof typeof JOB_TO_QUEUE];
    if (queue !== QueueName.PUBLISHING) {
      problems.push(`${slot}: job ${jobName} maps to queue ${String(queue)}, not publishing`);
    }
  }

  // ⚠ 这一条是真正的目标：契约的 `dailyDraft` 是 2 段、会被 BullMQ 拒绝。
  // 如果将来有人「顺手改成用契约 builder」，这里会在**启动期**立刻炸掉，
  // 而不是等到第一次入队时抛一个 `Custom Id cannot contain :`。
  const samples = checks.jobIdSamples ?? [
    dailyDraftJobId('2026-09-29', PUBLISHING_SLOT.GENERATE_DRAFT),
    dailyPublishJobId('2026-09-29', PUBLISHING_SLOT.PUBLISH),
  ];
  for (const jobId of samples) {
    if (!isBullMqAcceptableJobId(jobId)) {
      problems.push(`jobId ${jobId} has ${jobId.split(':').length} segments; BullMQ needs 3`);
    }
  }

  const attempts = checks.attempts ?? PUBLISHING_JOB_OPTIONS.attempts;
  if (attempts !== PUBLISHING_RETRY.attempts) {
    problems.push('PUBLISHING_JOB_OPTIONS.attempts drifted from the contract retry policy');
  }

  return problems;
}

/**
 * 启动期自检。
 *
 * ⚠ 必须**真的被调用**，否则就是死代码 —— Agent 06 的独立审查正是在那里
 * 发现「`assertQueueMapping()` 从来没有调用点，掏空它测试仍全绿」。
 * 本模块由 `PublishingQueueWorker.start()` 调用。
 */
export function assertPublishingQueueContract(): void {
  const problems = publishingQueueProblems();
  if (problems.length > 0) {
    throw new Error(`publishing queue contract violated:\n- ${problems.join('\n- ')}`);
  }
}
