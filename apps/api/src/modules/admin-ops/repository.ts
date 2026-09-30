/**
 * `admin-ops` 的持久化端口。
 *
 * ── 这个模块为什么存在（且是**新建**的）──────────────────────────────
 * `tasks/agent-12-admin-ui.md` 要 9 个后台页面，而 `docs/04` 只定义了其中 6 组接口。
 * **Jobs / Notifications / AI Usage 三页一个接口都没有**：
 *
 * ```text
 * 数据             表                    写入方                      读取接口
 * ---------------- --------------------- --------------------------- ----------------
 * 作业运行历史      job_runs              worker 的 04/05/06/08       ❌ 没有
 * AI 用量与成本     ai_runs               worker 的 06                ❌ 没有
 * 管理员通知        admin_notifications   Agent 07 的通知扫描          ❌ 没有
 * ```
 *
 * 三张表都有真实写入方，所以这三页不是「没数据可显示」，而是「读完没有出口」。
 * 用户已明确授权补这三组接口（原本属 Agent 00 / 14 的契约权限），
 * 已记入 `CONTRACT_CHANGE_REQUEST-agent-12.md`。
 *
 * ── 为什么是新模块而不是改 Agent 07 的 `admin-review` ────────────────
 * `admin_notifications` 的**写**在 07 的 `notification.service.ts` 里，
 * 但 07 已经交付。把三个只读的运维视图塞进它的模块要改它的控制器、
 * 服务与仓储三处；新建一个模块只读同样的表，爆炸半径小得多。
 *
 * 代价：`admin_notifications` 现在有**两个**使用方（07 写、本模块读）。
 * 这是读写分离的常规形态，但**已知**：表结构的任何变化会影响两处。
 *
 * ── 端口返回的是**对外形状**（ISO 字符串 / string 化的 BIGINT / 契约枚举）──
 * 与 Agent 07 的 `ReviewListRow` 同一约定：序列化在仓储层完成，
 * 服务层与控制器不再碰 `Date` / `bigint` / Prisma 枚举。
 */

import type { AiRunStatus, AiTaskType, JobRunStatus } from '@signal/contracts';

/** 注入 token。 */
export const ADMIN_OPS_REPOSITORY = 'ADMIN_OPS_REPOSITORY';

/* ------------------------------------------------------------------ */
/* Jobs                                                                */
/* ------------------------------------------------------------------ */

/** 一行作业运行记录（`GET /admin/jobs` 的 `data[]`）。 */
export type AdminJobRun = {
  id: string;
  jobType: string;
  jobKey: string | null;
  status: JobRunStatus;
  startedAt: string;
  finishedAt: string | null;
  /**
   * 派生值（`finishedAt - startedAt`），**不是数据库列**。
   *
   * 仍在跑（`finishedAt` 为空）或时钟回拨时为 `null` —— 不用 `0` 冒充，
   * 否则后台会把「还没跑完」显示成「0 毫秒完成」。
   */
  durationMs: number | null;
  attempts: number;
  errorCode: string | null;
  /** `job_runs.metadata`（Json 列）—— 原样透出，内容由各 Job 自己决定。 */
  metadata: unknown;
};

export type JobRunListQuery = {
  page: number;
  pageSize: number;
  jobType?: string;
  status?: JobRunStatus;
};

/* ------------------------------------------------------------------ */
/* Notifications                                                       */
/* ------------------------------------------------------------------ */

/**
 * 通知的读状态。
 *
 * ⚠ **不是契约枚举**：`docs/05` 没有为通知状态定义枚举，Agent 01 的 schema
 * 按 reference 把它留成了字符串列（默认 `UNREAD`）。这里如实镜像那两个
 * 已知取值，并在 DTO 层拒绝其它值 —— 而不是假装它是一份契约。
 */
export const NOTIFICATION_STATUSES = ['UNREAD', 'READ'] as const;
export type NotificationStatusValue = (typeof NOTIFICATION_STATUSES)[number];

/** 一行管理员通知（`GET /admin/notifications` 的 `data[]`）。 */
export type AdminNotification = {
  id: string;
  type: string;
  title: string;
  body: string;
  /** 后台内部的跳转目标（`/admin/review/<id>` 这类），**不是**外部 URL。 */
  targetUrl: string | null;
  status: string;
  /** 邮件投递状态（`NONE` / `SENT` / `FAILED` 等，由 07 的邮件链路写）。 */
  emailStatus: string;
  createdAt: string;
  readAt: string | null;
};

export type NotificationListQuery = {
  page: number;
  pageSize: number;
  status?: NotificationStatusValue;
};

/* ------------------------------------------------------------------ */
/* AI Usage                                                            */
/* ------------------------------------------------------------------ */

/** 一行 AI 调用（`GET /admin/ai-usage` 的 `recent[]`）。 */
export type AdminAiRun = {
  id: string;
  contentId: string | null;
  taskType: AiTaskType;
  provider: string;
  model: string;
  promptVersion: string;
  status: AiRunStatus;
  inputTokens: number | null;
  outputTokens: number | null;
  /** `Decimal(12,6)` → number（与 Agent 07 的 `aiCostTodayUsd` 同一处理）。 */
  estimatedCostUsd: number | null;
  durationMs: number | null;
  errorCode: string | null;
  createdAt: string;
};

/** 一个时间窗口（UTC 半开区间，由上海业务日换算而来）。 */
export type AiUsageWindow = {
  /** 含。 */
  fromUtc: Date;
  /** 不含。 */
  toUtc: Date;
};

/** 汇总行（总量 / 按 taskType / 按 model 都用这个形状）。 */
export type AiUsageRollup = {
  runs: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  /** `status` 非 `SUCCEEDED` 的调用数 —— 单独列出来才看得出「花了钱没结果」。 */
  failedRuns: number;
};

/** 带分组键的汇总。 */
export type AiUsageGroupRow = AiUsageRollup & { key: string };

/** 单个业务日的汇总。 */
export type AiUsageDailyRow = AiUsageRollup & { businessDate: string };

/* ------------------------------------------------------------------ */
/* 端口                                                                */
/* ------------------------------------------------------------------ */

export type AdminOpsRepository = {
  /** 分页列出作业运行，按 `startedAt DESC, id DESC`。 */
  listJobRuns(query: JobRunListQuery): Promise<{ data: AdminJobRun[]; total: number }>;

  /** 分页列出通知，按 `createdAt DESC, id DESC`。 */
  listNotifications(
    query: NotificationListQuery,
  ): Promise<{ data: AdminNotification[]; total: number }>;

  /** 单条通知；不存在返回 `null`。 */
  findNotification(id: string): Promise<AdminNotification | null>;

  /**
   * 把通知标记为已读。
   *
   * ⚠ 幂等：**已经读过的不改动 `readAt`** —— 否则「什么时候读的」会被
   * 每一次点开覆盖，那一列就没意义了。返回值是更新后的行，已读时原样返回。
   */
  markNotificationRead(id: string, readAt: Date): Promise<AdminNotification | null>;

  /** 窗口内的总量。 */
  aiUsageTotals(window: AiUsageWindow): Promise<AiUsageRollup>;

  /** 按 `task_type` 分组。 */
  aiUsageByTaskType(window: AiUsageWindow): Promise<AiUsageGroupRow[]>;

  /** 按 `model` 分组。 */
  aiUsageByModel(window: AiUsageWindow): Promise<AiUsageGroupRow[]>;

  /**
   * **单个**业务日的汇总。
   *
   * 参数是「业务日的 UTC 区间」而不是日期字符串 —— 换算由服务层用
   * `@signal/config` 的 `businessDayRangeUtc()` 做（那是冻结的时区真源），
   * 仓储层不重新实现一遍时区逻辑。
   */
  aiUsageForWindow(window: AiUsageWindow): Promise<AiUsageRollup>;

  /** 最近若干条调用，按 `createdAt DESC, id DESC`。 */
  aiUsageRecent(limit: number): Promise<AdminAiRun[]>;
};
