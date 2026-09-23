import { describe, expect, it } from 'vitest';
import {
  BUSINESS_DATE_PATTERN,
  BUSINESS_TIMEZONE,
  DAILY_REVIEW_ALERT_HOUR,
  DAILY_REVIEW_ALERT_MINUTE,
  DAILY_TARGET_PUBLISH_HOUR,
  isBusinessDate,
} from '../index';

describe('业务时区契约常量（docs/00 / docs/01）', () => {
  it('业务时区冻结为 Asia/Shanghai', () => {
    expect(BUSINESS_TIMEZONE).toBe('Asia/Shanghai');
  });

  it('日报目标发布时刻为上海时间 08:00', () => {
    expect(DAILY_TARGET_PUBLISH_HOUR).toBe(8);
  });

  it('日报 review 告警时刻为上海时间 07:30', () => {
    expect(DAILY_REVIEW_ALERT_HOUR).toBe(7);
    expect(DAILY_REVIEW_ALERT_MINUTE).toBe(30);
  });

  it('业务日格式 YYYY-MM-DD', () => {
    expect(BUSINESS_DATE_PATTERN.test('2026-09-23')).toBe(true);
    expect(BUSINESS_DATE_PATTERN.test('2026-9-23')).toBe(false);
  });
});

describe('isBusinessDate', () => {
  it('接受合法业务日', () => {
    expect(isBusinessDate('2026-09-23')).toBe(true);
    expect(isBusinessDate('2024-02-29')).toBe(true);
  });

  it('拒绝其它形态与不存在的日期', () => {
    expect(isBusinessDate('2026-9-23')).toBe(false);
    expect(isBusinessDate('2026-13-01')).toBe(false);
    expect(isBusinessDate('2026-02-30')).toBe(false);
    expect(isBusinessDate('')).toBe(false);
  });
});
