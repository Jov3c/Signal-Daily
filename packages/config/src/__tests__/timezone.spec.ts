import { describe, expect, it } from 'vitest';
import {
  businessDateOf,
  businessDayRangeUtc,
  businessTimeToUtc,
  businessTimezoneOffsetMs,
  formatInBusinessTimezone,
} from '../index';

const HOUR_MS = 60 * 60 * 1000;

describe('businessTimezoneOffsetMs', () => {
  it('Asia/Shanghai 相对 UTC 偏移为 +8 小时', () => {
    expect(businessTimezoneOffsetMs(new Date('2026-09-23T00:00:00.000Z'))).toBe(8 * HOUR_MS);
  });

  it('跨月与跨年时刻偏移不变（无夏令时）', () => {
    expect(businessTimezoneOffsetMs(new Date('2026-01-01T00:00:00.000Z'))).toBe(8 * HOUR_MS);
    expect(businessTimezoneOffsetMs(new Date('2026-07-01T12:00:00.000Z'))).toBe(8 * HOUR_MS);
  });
});

describe('businessDateOf — 上海业务日', () => {
  it('UTC 15:59:59 仍属于当天上海业务日', () => {
    expect(businessDateOf(new Date('2026-09-23T15:59:59.000Z'))).toBe('2026-09-23');
  });

  it('UTC 16:00:00 已跨到次日上海业务日', () => {
    expect(businessDateOf(new Date('2026-09-23T16:00:00.000Z'))).toBe('2026-09-24');
  });

  it('UTC 午夜对应上海当天上午 08:00', () => {
    expect(businessDateOf(new Date('2026-09-23T00:00:00.000Z'))).toBe('2026-09-23');
  });
});

describe('businessDayRangeUtc — 业务日 UTC 区间', () => {
  it('2026-09-23 的区间为 [09-22T16:00Z, 09-23T16:00Z)', () => {
    const { startUtc, endUtc } = businessDayRangeUtc('2026-09-23');
    expect(startUtc.toISOString()).toBe('2026-09-22T16:00:00.000Z');
    expect(endUtc.toISOString()).toBe('2026-09-23T16:00:00.000Z');
  });

  it('区间长度恒为 24 小时', () => {
    const { startUtc, endUtc } = businessDayRangeUtc('2026-01-01');
    expect(endUtc.getTime() - startUtc.getTime()).toBe(24 * HOUR_MS);
  });

  it('区间端点上的业务日自洽', () => {
    const { startUtc, endUtc } = businessDayRangeUtc('2026-09-23');
    expect(businessDateOf(startUtc)).toBe('2026-09-23');
    expect(businessDateOf(new Date(endUtc.getTime() - 1))).toBe('2026-09-23');
    expect(businessDateOf(endUtc)).toBe('2026-09-24');
  });

  it('拒绝非法业务日', () => {
    expect(() => businessDayRangeUtc('2026-13-01')).toThrow(RangeError);
    expect(() => businessDayRangeUtc('26-01-01')).toThrow(RangeError);
  });
});

describe('businessTimeToUtc — 上海钟点转 UTC', () => {
  it('上海 08:00 = UTC 00:00（日报目标发布时刻）', () => {
    expect(businessTimeToUtc('2026-09-23', 8).toISOString()).toBe('2026-09-23T00:00:00.000Z');
  });

  it('上海 00:00 = 前一日 UTC 16:00', () => {
    expect(businessTimeToUtc('2026-09-23', 0).toISOString()).toBe('2026-09-22T16:00:00.000Z');
  });

  it('上海 07:30 = UTC 前一日 23:30（日报 review 告警时刻）', () => {
    expect(businessTimeToUtc('2026-09-23', 7, 30).toISOString()).toBe('2026-09-22T23:30:00.000Z');
  });
});

describe('formatInBusinessTimezone', () => {
  it('按上海时区格式化', () => {
    const text = formatInBusinessTimezone(new Date('2026-09-23T00:00:00.000Z'), {
      dateStyle: 'short',
      timeStyle: 'short',
    });
    expect(text).toContain('2026');
    // 上海时间应为 08:00，而不是 UTC 00:00。
    expect(text).toMatch(/08:00/);
  });
});
