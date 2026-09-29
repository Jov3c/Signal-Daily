/**
 * 日报请求解析的守卫。
 *
 * 手写校验的价值在这里体现得最清楚：**结构性错误必须报错、
 * 展示字段必须截断**，而这两类混在一个装饰器里表达不出来。
 * 另外把「所有错误一次收齐」也钉住 —— 管理员不该修一个错、再看到下一个。
 *
 * ⚠ 断言的是 `AppError.details.fields`，**不是** `message`。
 * `safeMessage` 刻意是固定的 "Request validation failed"：字段错误属于
 * **调用方要修的东西**，放在 `details` 里；把它拼进面向用户的 message
 * 会让「错误消息」变成内部实现的回显面（`docs/15`）。
 */

import { describe, expect, it } from 'vitest';
import { isAppError } from '@signal/contracts';
import {
  MAX_ITEMS_PER_SECTION,
  MAX_SECTIONS,
  MAX_SECTION_TITLE_LENGTH,
} from '../src/modules/daily/limits';
import {
  monthRange,
  parseBusinessDate,
  parseOptionalStatus,
  parseScheduleBody,
  parseSectionsBody,
  parseYearMonth,
} from '../src/modules/daily/dto';

/**
 * 跑一个「应当校验失败」的调用，返回它报的字段错误清单（换行连接）。
 *
 * 用 `details.fields` 而不是 message：那才是字段级错误所在的地方。
 */
function fieldsFrom(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (isAppError(error)) {
      const details = error.details as { fields?: string[] } | null;
      return (details?.fields ?? []).join('\n');
    }
    throw error;
  }
  throw new Error('expected a validation error, but the call succeeded');
}

/** 一条合法的版块。 */
function section(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'AI',
    title: 'AI',
    sortOrder: 1,
    items: [
      { contentId: '100', displayStyle: 'MAJOR', sortOrder: 0 },
      { contentId: '101', displayStyle: 'STANDARD', sortOrder: 1 },
    ],
    ...overrides,
  };
}

describe('业务日与年月', () => {
  it('合法业务日通过，非法一律报错', () => {
    expect(parseBusinessDate('2026-09-29')).toBe('2026-09-29');
    for (const bad of ['2026-13-01', '2026-02-30', '20260929', '2026-9-9', '', 'archive']) {
      expect(
        fieldsFrom(() => parseBusinessDate(bad)),
        `${bad} 应当被拒`,
      ).toMatch(/date/);
    }
  });

  it('`archive` 不是合法业务日 —— 这正是 `/daily/archive` 必须声明在 `:date` 之前的原因', () => {
    // 路由顺序搞反的话，`/daily/archive` 会被 `:date` 吃掉，
    // 然后返回 400「date 必须是合法业务日」——
    // 前台看到的是「归档接口坏了」，而不是「路由写反了」。
    expect(fieldsFrom(() => parseBusinessDate('archive'))).toMatch(/date/);
  });

  it('年月缺省取**上海业务时区的当月**（不是 UTC 当月）', () => {
    // 上海 2026-10-01 00:30 = UTC 2026-09-30 16:30。
    // 用 UTC 会得到 9 月，而管理员在上海，他要看的是 10 月。
    const shanghaiOct = new Date('2026-09-30T16:30:00.000Z');
    expect(parseYearMonth({}, shanghaiOct)).toEqual({ year: 2026, month: 10 });

    const shanghaiSep = new Date('2026-09-30T15:30:00.000Z');
    expect(parseYearMonth({}, shanghaiSep)).toEqual({ year: 2026, month: 9 });
  });

  it('非法年月报错（静默回落到当月会让管理员以为筛选生效了）', () => {
    expect(fieldsFrom(() => parseYearMonth({ year: '2026', month: '13' }, new Date()))).toMatch(
      /month/,
    );
    expect(fieldsFrom(() => parseYearMonth({ year: '1999' }, new Date()))).toMatch(/year/);
    expect(fieldsFrom(() => parseYearMonth({ month: 'abc' }, new Date()))).toMatch(/month/);
  });

  it('monthRange 是半开区间，且跨年正确', () => {
    expect(monthRange({ year: 2026, month: 9 })).toEqual({
      from: '2026-09-01',
      to: '2026-10-01',
    });
    expect(monthRange({ year: 2026, month: 12 })).toEqual({
      from: '2026-12-01',
      to: '2027-01-01',
    });
  });

  it('status 只接受契约里的值', () => {
    expect(parseOptionalStatus({ status: 'SCHEDULED' })).toBe('SCHEDULED');
    expect(parseOptionalStatus({})).toBeUndefined();
    expect(fieldsFrom(() => parseOptionalStatus({ status: 'PUBLISHING' }))).toMatch(/status/);
  });
});

describe('版块整体替换的校验', () => {
  it('合法的结构通过', () => {
    const parsed = parseSectionsBody({ headline: '今日信号', sections: [section()] });
    expect(parsed.headline).toBe('今日信号');
    expect(parsed.sections).toHaveLength(1);
    expect(parsed.sections[0]?.items).toHaveLength(2);
  });

  it('未知版块类型报错', () => {
    expect(
      fieldsFrom(() => parseSectionsBody({ sections: [section({ type: 'SPORTS' })] })),
    ).toMatch(/type/);
  });

  it('同一期不允许两个同类型版块', () => {
    expect(
      fieldsFrom(() => parseSectionsBody({ sections: [section(), section({ sortOrder: 2 })] })),
    ).toMatch(/duplicate section type/);
  });

  it('sortOrder 重复报错（否则会以 500 的形式从 DB 唯一约束冒出来）', () => {
    expect(
      fieldsFrom(() =>
        parseSectionsBody({ sections: [section(), section({ type: 'TECH', sortOrder: 1 })] }),
      ),
    ).toMatch(/duplicate sortOrder/);
  });

  it('同一版块内 contentId 重复报错', () => {
    expect(
      fieldsFrom(() =>
        parseSectionsBody({
          sections: [
            section({
              items: [
                { contentId: '100', displayStyle: 'MAJOR', sortOrder: 0 },
                { contentId: '100', displayStyle: 'STANDARD', sortOrder: 1 },
              ],
            }),
          ],
        }),
      ),
    ).toMatch(/duplicate contentId/);
  });

  it('条目 displayStyle 必须在契约里', () => {
    expect(
      fieldsFrom(() =>
        parseSectionsBody({
          sections: [
            section({ items: [{ contentId: '100', displayStyle: 'HERO', sortOrder: 0 }] }),
          ],
        }),
      ),
    ).toMatch(/displayStyle/);
  });

  it('**把所有错误一次收齐**（管理员不该修一个看到一个）', () => {
    const fields = fieldsFrom(() =>
      parseSectionsBody({
        sections: [
          section({ type: 'SPORTS', title: '' }), // 2 条：type 非法 + title 空
          section({ type: 'NEWS', sortOrder: 1 }), // 2 条：type 非法 + sortOrder 重复
        ],
      }),
    );
    expect(fields.split('\n').length).toBeGreaterThanOrEqual(4);
  });

  it('版块数上限', () => {
    const sections = Array.from({ length: MAX_SECTIONS + 1 }, (_unused, index) =>
      section({ type: 'AI', sortOrder: index }),
    );
    expect(fieldsFrom(() => parseSectionsBody({ sections }))).toMatch(/at most/);
  });

  it('单个版块的条目数上限', () => {
    const items = Array.from({ length: MAX_ITEMS_PER_SECTION + 1 }, (_unused, index) => ({
      contentId: String(1000 + index),
      displayStyle: 'STANDARD',
      sortOrder: index,
    }));
    expect(fieldsFrom(() => parseSectionsBody({ sections: [section({ items })] }))).toMatch(
      /at most/,
    );
  });

  it('超长标题被**截断**而不是报错（管理员刚写完一段话）', () => {
    const long = '标'.repeat(MAX_SECTION_TITLE_LENGTH + 50);
    const parsed = parseSectionsBody({ sections: [section({ title: long })] });
    expect(Array.from(parsed.sections[0]?.title ?? '')).toHaveLength(MAX_SECTION_TITLE_LENGTH);
  });

  it('`headline` 不传时是 undefined（表示「不改」），传 null 表示「清空」', () => {
    expect(parseSectionsBody({ sections: [section()] }).headline).toBeUndefined();
    expect(parseSectionsBody({ sections: [section()], headline: null }).headline).toBeNull();
  });

  it('body 必须是 JSON 对象', () => {
    for (const bad of [null, [], 'x', 42]) {
      expect(fieldsFrom(() => parseSectionsBody(bad))).toMatch(/body/);
    }
  });
});

describe('排期请求体 —— ⚠ 不接受自定义时刻', () => {
  it('空体 / 无体通过（这个接口没有参数）', () => {
    expect(() => parseScheduleBody({})).not.toThrow();
    expect(() => parseScheduleBody(undefined)).not.toThrow();
    expect(() => parseScheduleBody(null)).not.toThrow();
  });

  it('传 `scheduledAt` → 400，并**说清**排期用的是哪个时刻、要立刻发该走哪条路', () => {
    const fields = fieldsFrom(() => parseScheduleBody({ scheduledAt: '2026-09-29T12:00:00.000Z' }));
    // 只是「报错」不够 —— 必须告诉管理员正确的做法，
    // 否则他只会换个时间再试一次。
    expect(fields).toMatch(/scheduledAt/);
    expect(fields).toMatch(/08:00/);
    expect(fields).toMatch(/\/publish/);
  });

  it('传**任何**未知字段也 400（把「这个接口没有参数」讲明白）', () => {
    const fields = fieldsFrom(() => parseScheduleBody({ when: 'tonight' }));
    expect(fields).toMatch(/no parameters/);
    expect(fields).toMatch(/when/);
  });

  it('非对象体 → 400', () => {
    for (const bad of [[], 'x', 42]) {
      expect(fieldsFrom(() => parseScheduleBody(bad))).toMatch(/body/);
    }
  });
});
