/**
 * 请求解析与校验（`admin-ops` 的三组只读接口 + 一个已读标记）。
 *
 * 与 Agent 02 / 03 / 07 同一取舍：**手写**而不是 class-validator ——
 * 校验规则本身就是契约，写在代码里比写在装饰器里好读，
 * 而且手写能把**所有**错误一次收齐再返回。
 *
 * ── 分页参数与筛选参数的处理**刻意不同** ────────────────────────────
 * `page` / `pageSize` 非法时**夹到边界而不报错**（分页参数不值得 400）；
 * `jobType` / `status` 非法时**必须报错** —— 它们是筛选条件，
 * 静默忽略会让管理员看到一个**完全不同**的结果集却以为筛过了。
 * 这个不对称是有意的，不是疏忽。
 */

import {
  AppError,
  AI_RUN_STATUSES,
  DEFAULT_PAGE_SIZE,
  JOB_RUN_STATUSES,
  MAX_PAGE_SIZE,
  PlatformErrorCode,
  type AiRunStatus,
  type JobRunStatus,
} from '@signal/contracts';
import {
  NOTIFICATION_STATUSES,
  type JobRunListQuery,
  type NotificationListQuery,
  type NotificationStatusValue,
} from '../repository';

/** 校验失败的统一抛出。`details.fields` 只含字段名与原因（不回显值）。 */
export function invalid(errors: string[]): AppError {
  return new AppError({
    code: PlatformErrorCode.VALIDATION_FAILED,
    httpStatus: 400,
    safeMessage: 'Request validation failed',
    details: { fields: errors },
  });
}

/** 解析正整数；缺省时用默认值，越界时夹到边界（**不报错**）。 */
export function parsePositiveInt(value: unknown, fallback: number, max: number): number {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, max);
}

/** 可选字符串筛选；空串视为「没给」。 */
function parseOptionalText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/** 可选枚举筛选；非法值**报错**（见文件头）。 */
function parseOptionalEnum<T extends string>(
  value: unknown,
  field: string,
  allowed: readonly T[],
  errors: string[],
): T | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    errors.push(`${field}: must be one of ${allowed.join(', ')}`);
    return undefined;
  }
  return value as T;
}

/** `GET /admin/jobs` 的查询参数。 */
export function parseJobRunListQuery(query: Record<string, unknown>): JobRunListQuery {
  const errors: string[] = [];
  const jobType = parseOptionalText(query['jobType']);
  const status = parseOptionalEnum<JobRunStatus>(
    query['status'],
    'status',
    JOB_RUN_STATUSES,
    errors,
  );

  if (errors.length > 0) throw invalid(errors);

  return {
    page: parsePositiveInt(query['page'], 1, Number.MAX_SAFE_INTEGER),
    pageSize: parsePositiveInt(query['pageSize'], DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE),
    ...(jobType === undefined ? {} : { jobType }),
    ...(status === undefined ? {} : { status }),
  };
}

/** `GET /admin/notifications` 的查询参数。 */
export function parseNotificationListQuery(query: Record<string, unknown>): NotificationListQuery {
  const errors: string[] = [];
  const status = parseOptionalEnum<NotificationStatusValue>(
    query['status'],
    'status',
    NOTIFICATION_STATUSES,
    errors,
  );

  if (errors.length > 0) throw invalid(errors);

  return {
    page: parsePositiveInt(query['page'], 1, Number.MAX_SAFE_INTEGER),
    pageSize: parsePositiveInt(query['pageSize'], DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE),
    ...(status === undefined ? {} : { status }),
  };
}

/**
 * AI 用量窗口的天数。
 *
 * ```text
 * 默认 14 天（够看出趋势）
 * 上限 30 天 —— 不是拍脑袋：服务层对**每一个业务日**各发一次聚合查询，
 *              上限决定最坏情况下的查询数。30 次带索引的小聚合可以接受，
 *              90 次就开始像在打自己的库了。
 * 下限 1 天，超过上限**夹到 30**（分页/窗口参数按上面的约定不报错）。
 * ```
 */
export const AI_USAGE_DEFAULT_DAYS = 14;
export const AI_USAGE_MAX_DAYS = 30;

export function parseAiUsageQuery(query: Record<string, unknown>): { days: number } {
  return { days: parsePositiveInt(query['days'], AI_USAGE_DEFAULT_DAYS, AI_USAGE_MAX_DAYS) };
}

/** 最近调用列表的长度（不开放给调用方：多给几条没有信息增量）。 */
export const AI_USAGE_RECENT_LIMIT = 20;

/**
 * 供守卫与测试使用：这些取值就是契约里的枚举。
 * 导出成数组是为了让「DTO 允许的值」与「契约枚举」不可能漂移。
 */
export const ALLOWED_AI_RUN_STATUSES: readonly AiRunStatus[] = AI_RUN_STATUSES;
