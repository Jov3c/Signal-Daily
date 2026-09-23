/**
 * Signal 时间契约。
 *
 * 对应 `docs/01-system-architecture.md` 与 `docs/00-product-freeze.md`：
 *   - DB 保存 UTC，UI 按 Asia/Shanghai 显示。
 *   - 日报 `businessDate` 表示上海时区业务日。
 *
 * 时区是 Frozen Contract，不得由任意 Agent 改成别的时区。
 */

/** 全系统唯一业务时区。 */
export const BUSINESS_TIMEZONE = 'Asia/Shanghai' as const;

export type BusinessTimezone = typeof BUSINESS_TIMEZONE;

/** 日报目标发布时刻（上海时间 08:00）。未审核不得自动上线。 */
export const DAILY_TARGET_PUBLISH_HOUR = 8 as const;

/** 日报 review 告警时刻（上海时间 07:30）。 */
export const DAILY_REVIEW_ALERT_HOUR = 7 as const;
export const DAILY_REVIEW_ALERT_MINUTE = 30 as const;

/** 业务日字符串格式 `YYYY-MM-DD`。 */
export const BUSINESS_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function isBusinessDate(value: string): boolean {
  if (!BUSINESS_DATE_PATTERN.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
