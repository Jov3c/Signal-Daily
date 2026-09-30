/**
 * `AdminOpsService` —— 后台运维视图的读模型。
 *
 * 三个视图：作业运行历史 / AI 用量与成本 / 管理员通知。
 * 它们都是**只读**的（唯一例外是通知的已读标记），因此这一层的职责很薄：
 * 换算窗口、拼分页元数据、把「不存在」翻译成 404。
 *
 * ── ⚠ 业务日的按天聚合为什么是 N 次查询而不是一条 GROUP BY ──────────
 * 直觉写法是一条原生 SQL：
 *
 * ```sql
 * SELECT DATE(CONVERT_TZ(created_at, '+00:00', '+08:00')) AS d, SUM(...)
 * ```
 *
 * **不这么写**有两个具体理由，不是洁癖：
 *
 * 1. **时区换算只有 `@signal/config` 一个真源。** 在 SQL 里重写一遍
 *    等于把 `Asia/Shanghai` 与它的 +08:00 硬编码进第二处。Agent 03 已经
 *    为同一类错误付过代价：本机 MySQL 的 `time_zone=SYSTEM=Asia/Shanghai`
 *    而列里存的是 UTC，任何依赖会话时区的 SQL 日期函数都会**静默差 8 小时**。
 *    `businessDayRangeUtc()` 是纯函数、有测试、是冻结的契约实现。
 * 2. **`CONVERT_TZ` 还有它自己的部署问题**：MySQL 的具名时区表
 *    （`mysql.time_zone_name`）默认是空的，`CONVERT_TZ(..., 'Asia/Shanghai')`
 *    在没导入时区表的容器里返回 `NULL` —— 那种失败是**静默**的，
 *    整张图表会变成空白而不是报错。
 *
 * 代价：`days` 次带索引的小聚合查询（默认 14、上限 30）。
 * `AI_USAGE_MAX_DAYS = 30` 就是为了给这个代价封顶才不是一个更大的数。
 */

import { Inject, Injectable } from '@nestjs/common';
import {
  BUSINESS_TIMEZONE,
  PlatformErrorCode,
  AppError,
  type OffsetPaginationMeta,
} from '@signal/contracts';
import { businessDateOf, businessDayRangeUtc } from '@signal/config';
import type { Logger } from '@signal/logger';
import { toBigIntId } from '../../common/prisma/bigint-id';
import {
  ADMIN_OPS_REPOSITORY,
  type AdminAiRun,
  type AdminJobRun,
  type AdminNotification,
  type AdminOpsRepository,
  type AiUsageDailyRow,
  type AiUsageGroupRow,
  type AiUsageRollup,
  type AiUsageWindow,
  type JobRunListQuery,
  type NotificationListQuery,
} from './repository';
import { AI_USAGE_RECENT_LIMIT } from './dto/parse';

/** 注入 token：时钟（便于测试固定 `now`）。 */
export const ADMIN_OPS_CLOCK = 'ADMIN_OPS_CLOCK';
/** 注入 token：日志。 */
export const ADMIN_OPS_LOGGER = 'ADMIN_OPS_LOGGER';

export type AdminOpsClock = { now(): Date };

/** `GET /admin/ai-usage` 的响应体（放在 `data` 里）。 */
export type AiUsageView = {
  window: {
    /** 窗口覆盖的首个上海业务日（含）。 */
    from: string;
    /** 窗口覆盖的最后一个上海业务日（含）。 */
    to: string;
    days: number;
    /** 冻结的业务时区，供后台在图表上直接标注，不写死在前端。 */
    timezone: string;
  };
  totals: AiUsageRollup;
  byTaskType: AiUsageGroupRow[];
  byModel: AiUsageGroupRow[];
  daily: AiUsageDailyRow[];
  recent: AdminAiRun[];
};

/* ------------------------------------------------------------------ */
/* 业务日算术（纯函数，可单测）                                          */
/* ------------------------------------------------------------------ */

/**
 * 把 `YYYY-MM-DD` 平移若干天。
 *
 * 用 `Date.UTC` 做**纯日历**算术：不涉及任何时区，因此不存在
 * 「夏令时少一小时」这类问题（`Asia/Shanghai` 本来也没有夏令时，
 * 但这条实现不依赖那个事实）。
 */
export function shiftBusinessDate(businessDate: string, deltaDays: number): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(businessDate);
  if (match === null) {
    // 只可能来自 `businessDateOf()` 的产出，走到这里说明上游坏了。
    throw new Error(`invalid business date: ${businessDate}`);
  }
  const [, y, m, d] = match as unknown as [string, string, string, string];
  const shifted = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)) + deltaDays * 86_400_000);
  return shifted.toISOString().slice(0, 10);
}

/**
 * 最近 `days` 个业务日（**升序**，最后一个元素是今天）。
 *
 * 升序是刻意的：图表从左到右就是时间从左到右，前端不必再排一次。
 */
export function recentBusinessDates(now: Date, days: number): string[] {
  const today = businessDateOf(now);
  const dates: string[] = [];
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    dates.push(shiftBusinessDate(today, -offset));
  }
  return dates;
}

/** 一组业务日合成一个连续的 UTC 半开区间。 */
export function windowOf(businessDates: readonly string[]): AiUsageWindow {
  const first = businessDates[0];
  const last = businessDates[businessDates.length - 1];
  if (first === undefined || last === undefined) {
    throw new Error('windowOf() requires at least one business date');
  }
  return {
    fromUtc: businessDayRangeUtc(first).startUtc,
    // 半开区间：用**最后一天**的 `endUtc`，它等于次日 `startUtc`。
    toUtc: businessDayRangeUtc(last).endUtc,
  };
}

/* ------------------------------------------------------------------ */

@Injectable()
export class AdminOpsService {
  constructor(
    @Inject(ADMIN_OPS_REPOSITORY) private readonly repository: AdminOpsRepository,
    @Inject(ADMIN_OPS_CLOCK) private readonly clock: AdminOpsClock,
    @Inject(ADMIN_OPS_LOGGER) private readonly logger: Logger,
  ) {}

  /** `GET /admin/jobs`。 */
  async listJobRuns(
    query: JobRunListQuery,
  ): Promise<{ data: AdminJobRun[]; meta: OffsetPaginationMeta }> {
    const { data, total } = await this.repository.listJobRuns(query);
    return { data, meta: pageMeta(query.page, query.pageSize, total) };
  }

  /** `GET /admin/notifications`。 */
  async listNotifications(
    query: NotificationListQuery,
  ): Promise<{ data: AdminNotification[]; meta: OffsetPaginationMeta }> {
    const { data, total } = await this.repository.listNotifications(query);
    return { data, meta: pageMeta(query.page, query.pageSize, total) };
  }

  /**
   * `POST /admin/notifications/:id/read`。
   *
   * 幂等：**已经读过的不改写 `readAt`**（否则那一列会被每次点开覆盖，
   * 「什么时候读的」就失真了）。所以这里不能只看 `updateMany` 的命中数 ——
   * 命中 0 行既可能是「不存在」也可能是「已经读过」，必须回头查一次。
   *
   * ⚠ 不写审计表：`docs/09` 要求审计的是**人工 Evidence 操作**，
   * 标记通知已读不在其列。这里只记一条 info 日志（带操作者 id）。
   */
  async markNotificationRead(id: string, actorUserId: string): Promise<AdminNotification> {
    const parsed = toBigIntId(id);
    // 超出 BIGINT 上界的 id 直接当不存在 —— 绑定到 SQL 里会抛，
    // 那会变成 500，而它其实只是一个不存在的资源（Agent 09 的同款处理）。
    if (parsed === null) throw notFound();

    const updated = await this.repository.markNotificationRead(String(parsed), this.clock.now());
    if (updated === null) throw notFound();

    this.logger.info(
      { notificationId: updated.id, adminUserId: actorUserId },
      'admin notification marked read',
    );
    return updated;
  }

  /**
   * `GET /admin/ai-usage`。
   *
   * 全部按**上海业务日**切窗口（`docs/00` 的冻结时区），不是 UTC 日 ——
   * 否则「今天花了多少」在北京时间早上 8 点前会算到昨天头上。
   */
  async aiUsage(days: number): Promise<AiUsageView> {
    const businessDates = recentBusinessDates(this.clock.now(), days);
    const window = windowOf(businessDates);

    const [totals, byTaskType, byModel, recent, dailyTotals] = await Promise.all([
      this.repository.aiUsageTotals(window),
      this.repository.aiUsageByTaskType(window),
      this.repository.aiUsageByModel(window),
      this.repository.aiUsageRecent(AI_USAGE_RECENT_LIMIT),
      // 每天一个独立区间 —— 见文件头「为什么不是一条 GROUP BY」。
      Promise.all(
        businessDates.map(async (businessDate) => {
          const dayWindow = windowOf([businessDate]);
          return { businessDate, rollup: await this.repository.aiUsageForWindow(dayWindow) };
        }),
      ),
    ]);

    const daily: AiUsageDailyRow[] = dailyTotals.map((entry) => ({
      businessDate: entry.businessDate,
      ...entry.rollup,
    }));

    const first = businessDates[0] ?? '';
    const last = businessDates[businessDates.length - 1] ?? '';
    return {
      window: { from: first, to: last, days, timezone: BUSINESS_TIMEZONE },
      totals,
      byTaskType,
      byModel,
      daily,
      recent,
    };
  }
}

/* ------------------------------------------------------------------ */

/** 分页元数据（与 Agent 03 / 07 的形状一致）。 */
export function pageMeta(page: number, pageSize: number, total: number): OffsetPaginationMeta {
  return { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) };
}

/**
 * 404。
 *
 * ⚠ 刻意**不接收** id：把它回显进 `details` 等于原样返回入参，
 * 而那个入参可能是一个超长/畸形字符串（它连 BIGINT 都不是）。
 * 客户端本来就知道自己请求了什么 id，回显没有信息增量。
 */
function notFound(): AppError {
  return new AppError({
    code: PlatformErrorCode.NOT_FOUND,
    httpStatus: 404,
    safeMessage: 'Notification not found',
    // 不回显原始 id：它可能是一个超长/畸形字符串，回显等于把入参放进响应。
    details: { resource: 'admin_notification' },
  });
}
