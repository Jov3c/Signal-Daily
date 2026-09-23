/**
 * 业务时区工具 — Asia/Shanghai。
 *
 * 契约（`docs/01`）：DB 保存 UTC，UI 按 Asia/Shanghai 显示；
 * 日报 `businessDate` 表示上海时区业务日。
 *
 * 实现说明：Asia/Shanghai 自 1991 年起固定 UTC+8 且无夏令时，
 * 但此处仍用 Intl 计算偏移，以便同一套工具在契约时区变更时依然正确。
 */

import { BUSINESS_TIMEZONE, isBusinessDate, type BusinessDate } from '@signal/contracts';

const OFFSET_PARTS_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: BUSINESS_TIMEZONE,
  hour12: false,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

/**
 * 返回 `instant` 该时刻在业务时区相对 UTC 的偏移（毫秒）。
 * 例：Asia/Shanghai 返回 8 * 3600 * 1000。
 */
export function businessTimezoneOffsetMs(instant: Date): number {
  const parts = OFFSET_PARTS_FORMATTER.formatToParts(instant);
  const read = (type: string): number => {
    const found = parts.find((part) => part.type === type);
    return found ? Number(found.value) : 0;
  };
  // `hour12: false` 在部分 ICU 版本下会把午夜格式化为 "24"。
  const hour = read('hour') % 24;
  const asUtc = Date.UTC(
    read('year'),
    read('month') - 1,
    read('day'),
    hour,
    read('minute'),
    read('second'),
  );
  // formatToParts 丢弃毫秒，比较时同样把毫秒抹掉。
  const instantToSecond = instant.getTime() - instant.getMilliseconds();
  return asUtc - instantToSecond;
}

/** 该时刻所属的上海业务日（`YYYY-MM-DD`）。 */
export function businessDateOf(instant: Date): BusinessDate {
  const shifted = new Date(instant.getTime() + businessTimezoneOffsetMs(instant));
  return shifted.toISOString().slice(0, 10);
}

function assertBusinessDate(value: string): asserts value is BusinessDate {
  if (!isBusinessDate(value)) {
    throw new RangeError(`Invalid business date: ${value} (expected YYYY-MM-DD)`);
  }
}

function utcMidnightOf(businessDate: BusinessDate): number {
  const year = Number(businessDate.slice(0, 4));
  const month = Number(businessDate.slice(5, 7));
  const day = Number(businessDate.slice(8, 10));
  return Date.UTC(year, month - 1, day);
}

/**
 * 业务日的 UTC 区间 `[startUtc, endUtc)`。
 * 用于按业务日查询 UTC 存储的数据。
 */
export function businessDayRangeUtc(businessDate: string): { startUtc: Date; endUtc: Date } {
  assertBusinessDate(businessDate);
  const startGuess = utcMidnightOf(businessDate);
  const startInstant = new Date(startGuess - businessTimezoneOffsetMs(new Date(startGuess)));
  // 再算一次，处理偏移在边界上变化的情况（DST 边界）。
  const start = startGuess - businessTimezoneOffsetMs(startInstant);

  const endGuess = startGuess + 24 * 60 * 60 * 1000;
  const endInstant = new Date(endGuess - businessTimezoneOffsetMs(new Date(endGuess)));
  const end = endGuess - businessTimezoneOffsetMs(endInstant);

  return { startUtc: new Date(start), endUtc: new Date(end) };
}

/**
 * 把「上海业务日的某个钟点」转成 UTC 时刻。
 * 日报默认目标 08:00 即用此函数换算。
 */
export function businessTimeToUtc(
  businessDate: string,
  hour: number,
  minute = 0,
  second = 0,
): Date {
  assertBusinessDate(businessDate);
  const naive = utcMidnightOf(businessDate) + ((hour * 60 + minute) * 60 + second) * 1000;
  const guess = new Date(naive - businessTimezoneOffsetMs(new Date(naive)));
  return new Date(naive - businessTimezoneOffsetMs(guess));
}

/** 按业务时区格式化，供 UI 与日志使用。 */
export function formatInBusinessTimezone(
  instant: Date,
  options: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'short' },
  locale = 'zh-CN',
): string {
  return new Intl.DateTimeFormat(locale, { ...options, timeZone: BUSINESS_TIMEZONE }).format(
    instant,
  );
}
