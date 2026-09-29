/**
 * 收藏 / 阅读进度 / 偏好的请求解析守卫。
 *
 * ⚠ 断言的是 `AppError.details.fields`，**不是** `message`：
 * `safeMessage` 刻意是固定的 "Request validation failed"，字段错误属于
 * **调用方要修的东西**，放在 `details` 里（`docs/15`）。
 */

import { describe, expect, it } from 'vitest';
import { ArticleFontSize, UserTheme, isAppError } from '@signal/contracts';
import { MAX_BOOKMARK_LIMIT, parseBookmarkListQuery } from '../src/modules/bookmarks/dto';
import {
  MAX_LAST_POSITION_LENGTH,
  parseUpsertProgressBody,
} from '../src/modules/reading-progress/dto';
import { READING_RESOURCE_TYPES } from '../src/modules/reading-progress/resource-type';
import { PREFERENCE_KEYS, parseUpdatePreferencesBody } from '../src/modules/user-preferences/dto';

/** 跑一个「应当校验失败」的调用，返回它报的字段错误清单（换行连接）。 */
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

/* ------------------------------------------------------------------ */
/* 收藏列表查询                                                        */
/* ------------------------------------------------------------------ */

describe('收藏列表查询参数', () => {
  it('缺省用默认值', () => {
    const parsed = parseBookmarkListQuery({});
    expect(parsed.limit).toBeGreaterThan(0);
    expect(parsed.cursor).toBeUndefined();
  });

  it('`limit` 越界**夹到上限**而不报错（分页参数不值得 400）', () => {
    expect(parseBookmarkListQuery({ limit: '9999' }).limit).toBe(MAX_BOOKMARK_LIMIT);
  });

  it('`limit` 非正整数报错', () => {
    expect(fieldsFrom(() => parseBookmarkListQuery({ limit: '0' }))).toMatch(/limit/);
    expect(fieldsFrom(() => parseBookmarkListQuery({ limit: 'abc' }))).toMatch(/limit/);
  });

  it('⚠ 非法 `cursor` 报错 —— 静默忽略会让用户以为翻到了下一页', () => {
    // 复合游标 `{ms}-{contentId}`；只写一个 contentId 是不合法的
    expect(fieldsFrom(() => parseBookmarkListQuery({ cursor: '100' }))).toMatch(/cursor/);
    expect(fieldsFrom(() => parseBookmarkListQuery({ cursor: 'abc' }))).toMatch(/cursor/);
    expect(fieldsFrom(() => parseBookmarkListQuery({ cursor: '1-2-3' }))).toMatch(/cursor/);
  });

  it('合法复合游标通过', () => {
    expect(parseBookmarkListQuery({ cursor: '1759107600000-100' }).cursor).toBe(
      '1759107600000-100',
    );
  });
});

/* ------------------------------------------------------------------ */
/* 阅读进度                                                            */
/* ------------------------------------------------------------------ */

describe('阅读进度请求体（docs/04 没给形状，本模块定义并提了 CCR）', () => {
  const valid = {
    resourceType: 'CONTENT',
    resourceId: '100',
    progress: 0.5,
  };

  it('合法请求通过', () => {
    expect(parseUpsertProgressBody(valid)).toMatchObject({
      resourceType: 'CONTENT',
      resourceId: '100',
      progress: 0.5,
      lastPosition: null,
    });
  });

  it('⚠ **`progress` 的边界是闭区间 [0, 1]** —— 而列类型 `Decimal(5,4)` 存得下 1.5', () => {
    // 数据库不会替我们挡住越界值，所以必须在这一层拒
    expect(fieldsFrom(() => parseUpsertProgressBody({ ...valid, progress: 1.5 }))).toMatch(
      /progress/,
    );
    expect(fieldsFrom(() => parseUpsertProgressBody({ ...valid, progress: -0.001 }))).toMatch(
      /progress/,
    );
    // 边界值本身是合法的
    expect(() => parseUpsertProgressBody({ ...valid, progress: 0 })).not.toThrow();
    expect(() => parseUpsertProgressBody({ ...valid, progress: 1 })).not.toThrow();
  });

  it('⚠ `NaN` / `Infinity` 被拒（`NaN >= 0` 是 false，用比较运算会漏掉）', () => {
    expect(fieldsFrom(() => parseUpsertProgressBody({ ...valid, progress: Number.NaN }))).toMatch(
      /progress/,
    );
    expect(
      fieldsFrom(() => parseUpsertProgressBody({ ...valid, progress: Number.POSITIVE_INFINITY })),
    ).toMatch(/progress/);
    // 字符串形式的数字也不行（客户端传错类型时要立刻知道）
    expect(fieldsFrom(() => parseUpsertProgressBody({ ...valid, progress: '0.5' }))).toMatch(
      /progress/,
    );
  });

  it('`resourceType` 只接受 V1 支持的取值', () => {
    expect(READING_RESOURCE_TYPES).toEqual(['CONTENT']);
    expect(fieldsFrom(() => parseUpsertProgressBody({ ...valid, resourceType: 1 }))).toMatch(
      /resourceType/,
    );
  });

  it('⚠ **形状对但不支持的取值**返回专门的码（不是 `VALIDATION_FAILED`）（F1 回归）', () => {
    // §23 审查的 F1：`READING_RESOURCE_TYPE_UNSUPPORTED` 曾被登记进冻结契约、
    // CCR 也声称会返回它，但实现里**从未抛出**。这条守卫保证它真的会出现 ——
    // 一个「注册了却零使用」的码是一份会误导下游的契约表面。
    let captured: { code: string; httpStatus: number; details: unknown } | null = null;
    try {
      parseUpsertProgressBody({ ...valid, resourceType: 'EPISODE' });
    } catch (error) {
      if (isAppError(error)) {
        captured = {
          code: String(error.code),
          httpStatus: error.httpStatus,
          details: error.details,
        };
      }
    }

    expect(captured?.code).toBe('READING_RESOURCE_TYPE_UNSUPPORTED');
    expect(captured?.httpStatus).toBe(400);
    // 错误里要带上**支持哪些**，否则调用方只能去翻文档
    expect(captured?.details).toMatchObject({ supported: ['CONTENT'] });
  });

  it('`resourceId` 必须是十进制字符串', () => {
    expect(fieldsFrom(() => parseUpsertProgressBody({ ...valid, resourceId: 'abc' }))).toMatch(
      /resourceId/,
    );
    expect(fieldsFrom(() => parseUpsertProgressBody({ ...valid, resourceId: 100 }))).toMatch(
      /resourceId/,
    );
  });

  it('⚠ 超长 `lastPosition` 按**字符**截断（不报错，也不劈开代理对）', () => {
    const emoji = '🙂';
    const long = emoji.repeat(MAX_LAST_POSITION_LENGTH + 5);

    const parsed = parseUpsertProgressBody({ ...valid, lastPosition: long });
    expect(Array.from(parsed.lastPosition as string)).toHaveLength(MAX_LAST_POSITION_LENGTH);
    expect((parsed.lastPosition as string).includes('�')).toBe(false);
  });

  it('body 必须是 JSON 对象', () => {
    for (const bad of [null, [], 'x', 42]) {
      expect(fieldsFrom(() => parseUpsertProgressBody(bad))).toMatch(/body/);
    }
  });
});

/* ------------------------------------------------------------------ */
/* 阅读偏好                                                            */
/* ------------------------------------------------------------------ */

describe('阅读偏好请求体', () => {
  it('单个字段通过', () => {
    expect(parseUpdatePreferencesBody({ theme: 'DARK' })).toEqual({ theme: UserTheme.DARK });
    expect(parseUpdatePreferencesBody({ defaultTranslation: false })).toEqual({
      defaultTranslation: false,
    });
  });

  it('三个字段一起通过', () => {
    expect(
      parseUpdatePreferencesBody({
        theme: 'DARK',
        articleFontSize: 'LARGE',
        defaultTranslation: true,
      }),
    ).toEqual({
      theme: UserTheme.DARK,
      articleFontSize: ArticleFontSize.LARGE,
      defaultTranslation: true,
    });
  });

  it('枚举取值非法时报错', () => {
    expect(fieldsFrom(() => parseUpdatePreferencesBody({ theme: 'SEPIA' }))).toMatch(/theme/);
    expect(fieldsFrom(() => parseUpdatePreferencesBody({ articleFontSize: 'HUGE' }))).toMatch(
      /articleFontSize/,
    );
  });

  it('⚠ **未知字段 400**（静默忽略会让客户端以为保存成功）', () => {
    const fields = fieldsFrom(() => parseUpdatePreferencesBody({ articleFontsize: 'LARGE' }));
    expect(fields).toMatch(/unknown field/);
    expect(fields).toMatch(/articleFontsize/);
    // 错误里要列出允许的键，否则调用方只能去翻文档
    for (const key of PREFERENCE_KEYS) expect(fields).toContain(key);
  });

  it('⚠ 空体 400（一次没有效果的写入被回报成 200 会让状态悄悄分叉）', () => {
    expect(fieldsFrom(() => parseUpdatePreferencesBody({}))).toMatch(/at least one/);
  });

  it('`defaultTranslation` 必须是布尔（不接受 `"true"`）', () => {
    expect(fieldsFrom(() => parseUpdatePreferencesBody({ defaultTranslation: 'true' }))).toMatch(
      /defaultTranslation/,
    );
  });

  it('body 必须是 JSON 对象', () => {
    for (const bad of [null, [], 'x', 42]) {
      expect(fieldsFrom(() => parseUpdatePreferencesBody(bad))).toMatch(/body/);
    }
  });
});
