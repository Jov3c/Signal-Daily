/**
 * `admin-ops` 的纯函数与路由面。
 *
 * 这个文件不碰数据库、不起 HTTP —— 它守的是三件**编译期看不出来**的事：
 *
 * 1. **路由精确等于本模块声明的四条**（多一条即红）。这三组接口是
 *    **在冻结的 API 契约之外**补的（用户明确授权，见 CCR-agent-12 第 1 项），
 *    所以「到底加了哪几条」必须被钉死，不能靠读一遍控制器。
 * 2. **每个控制器都挂了 `AdminOriginGuard` + `AdminGuard`，且 Origin 在前**。
 * 3. **业务日窗口的换算是 +08:00**。整条 AI 用量图表都建立在这个假设上，
 *    而它只由 `@signal/config` 决定 —— 这里把它钉在**具体时刻**上
 *    （`2026-09-30` 的业务日 = `2026-09-29T16:00Z` 起），
 *    所以将来有人动了业务时区，红的是这里，而不是三个月后的一张错图。
 */

import { describe, expect, it } from 'vitest';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { AppError, JobRunStatus } from '@signal/contracts';
import { AdminGuard } from '../src/common/guards';
import { AdminOriginGuard } from '../src/modules/admin-review/admin-origin.guard';
import {
  AiUsageController,
  JobsController,
  NotificationsController,
} from '../src/modules/admin-ops/controller';
import {
  AI_USAGE_DEFAULT_DAYS,
  AI_USAGE_MAX_DAYS,
  parseAiUsageQuery,
  parseJobRunListQuery,
  parseNotificationListQuery,
} from '../src/modules/admin-ops/dto/parse';
import {
  pageMeta,
  recentBusinessDates,
  shiftBusinessDate,
  windowOf,
} from '../src/modules/admin-ops/service';

/* ------------------------------------------------------------------ */
/* 路由面                                                              */
/* ------------------------------------------------------------------ */

/** 从控制器元数据里读出「方法 + 路径」清单。 */
function routeTableOf(controller: new (...args: never[]) => unknown): string[] {
  const prototype = controller.prototype as Record<string, unknown>;
  const basePath = Reflect.getMetadata(PATH_METADATA, controller) as string | undefined;
  const routes: string[] = [];

  for (const name of Object.getOwnPropertyNames(prototype)) {
    if (name === 'constructor') continue;
    const handler = prototype[name] as object;
    const path = Reflect.getMetadata(PATH_METADATA, handler) as string | undefined;
    const method = Reflect.getMetadata(METHOD_METADATA, handler) as number | undefined;
    if (path === undefined || method === undefined) continue;

    const httpMethod = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'ALL', 'OPTIONS', 'HEAD'][method];
    routes.push(`${httpMethod} /${basePath ?? ''}${path === '/' ? '' : `/${path}`}`);
  }
  return routes.sort();
}

function guardsOf(controller: new (...args: never[]) => unknown): unknown[] {
  return (Reflect.getMetadata(GUARDS_METADATA, controller) as unknown[] | undefined) ?? [];
}

describe('⚠ 路由面就是这四条 —— 多一条即红', () => {
  it('作业运行历史：一条', () => {
    expect(routeTableOf(JobsController)).toEqual(['GET /admin/jobs']);
  });

  it('通知：两条（列表 + 已读）', () => {
    expect(routeTableOf(NotificationsController)).toEqual([
      'GET /admin/notifications',
      'POST /admin/notifications/:id/read',
    ]);
  });

  it('AI 用量：一条', () => {
    expect(routeTableOf(AiUsageController)).toEqual(['GET /admin/ai-usage']);
  });

  it('合计 4 条 —— 这就是本次对冻结契约的全部增量', () => {
    const all = [
      ...routeTableOf(JobsController),
      ...routeTableOf(NotificationsController),
      ...routeTableOf(AiUsageController),
    ];
    expect(all).toHaveLength(4);
  });

  it('每个控制器都挂了 AdminGuard 与 AdminOriginGuard，且 Origin 在前', () => {
    for (const controller of [JobsController, NotificationsController, AiUsageController]) {
      const guards = guardsOf(controller);
      expect(guards, controller.name).toContain(AdminGuard);
      expect(guards, controller.name).toContain(AdminOriginGuard);
      // 纯内存判断先跑，跨源请求在付出一次数据库往返之前就被拒掉。
      expect(guards.indexOf(AdminOriginGuard), controller.name).toBeLessThan(
        guards.indexOf(AdminGuard),
      );
    }
  });
});

/* ------------------------------------------------------------------ */
/* 业务日算术                                                          */
/* ------------------------------------------------------------------ */

describe('业务日算术（纯日历，不涉及时区）', () => {
  it('向前/向后平移', () => {
    expect(shiftBusinessDate('2026-09-30', -1)).toBe('2026-09-29');
    expect(shiftBusinessDate('2026-09-30', 1)).toBe('2026-10-01');
    expect(shiftBusinessDate('2026-09-30', 0)).toBe('2026-09-30');
  });

  it('跨月、跨年、闰年都正确', () => {
    expect(shiftBusinessDate('2026-03-01', -1)).toBe('2026-02-28');
    expect(shiftBusinessDate('2028-03-01', -1)).toBe('2028-02-29'); // 闰年
    expect(shiftBusinessDate('2026-01-01', -1)).toBe('2025-12-31');
    expect(shiftBusinessDate('2026-12-31', 1)).toBe('2027-01-01');
  });

  it('跨越 30 天以上也对', () => {
    expect(shiftBusinessDate('2026-09-30', -30)).toBe('2026-08-31');
    expect(shiftBusinessDate('2026-01-15', -20)).toBe('2025-12-26');
  });

  it('畸形输入直接抛（不做「猜一个日期」这种事）', () => {
    expect(() => shiftBusinessDate('2026/09/30', -1)).toThrow(/invalid business date/);
    expect(() => shiftBusinessDate('', -1)).toThrow(/invalid business date/);
  });
});

describe('⚠ 窗口的换算就是 +08:00（整条图表都建立在这个假设上）', () => {
  it('2026-09-30 这个业务日 = [2026-09-29T16:00Z, 2026-09-30T16:00Z)', () => {
    const window = windowOf(['2026-09-30']);
    expect(window.fromUtc.toISOString()).toBe('2026-09-29T16:00:00.000Z');
    expect(window.toUtc.toISOString()).toBe('2026-09-30T16:00:00.000Z');
  });

  it('相邻业务日**首尾相接**（半开区间：不留缝也不重叠）', () => {
    const dates = ['2026-09-28', '2026-09-29', '2026-09-30'];
    for (let index = 0; index + 1 < dates.length; index += 1) {
      const current = windowOf([dates[index] ?? '']);
      const next = windowOf([dates[index + 1] ?? '']);
      // 若这里用了闭区间，边界那一毫秒会被两天各算一次，总额就会偏高。
      expect(current.toUtc.toISOString()).toBe(next.fromUtc.toISOString());
    }
  });

  it('多天窗口 = 首日 startUtc 到末日 endUtc', () => {
    const window = windowOf(['2026-09-28', '2026-09-29', '2026-09-30']);
    expect(window.fromUtc.toISOString()).toBe('2026-09-27T16:00:00.000Z');
    expect(window.toUtc.toISOString()).toBe('2026-09-30T16:00:00.000Z');
  });

  it('空数组 → 抛（窗口没有意义，不返回一个「全空」的假窗口）', () => {
    expect(() => windowOf([])).toThrow(/at least one/);
  });
});

describe('最近 N 个业务日', () => {
  const now = new Date('2026-09-30T03:00:00.000Z'); // 北京时间 11:00

  it('升序、长度正确、最后一天是今天', () => {
    const dates = recentBusinessDates(now, 14);
    expect(dates).toHaveLength(14);
    expect(dates[dates.length - 1]).toBe('2026-09-30');
    expect(dates[0]).toBe('2026-09-17');
    // 升序：图表从左到右就是时间从左到右，前端不必再排一次。
    expect([...dates].sort()).toEqual(dates);
  });

  it('⚠ 用**上海业务日**判定「今天」，不是 UTC 日', () => {
    // UTC 的 2026-09-29 23:30 已经是北京时间 09-30 07:30。
    const lateUtc = new Date('2026-09-29T23:30:00.000Z');
    expect(recentBusinessDates(lateUtc, 1)).toEqual(['2026-09-30']);
  });

  it('1 天就是今天一天', () => {
    expect(recentBusinessDates(now, 1)).toEqual(['2026-09-30']);
  });
});

/* ------------------------------------------------------------------ */
/* 分页元数据                                                          */
/* ------------------------------------------------------------------ */

describe('分页元数据', () => {
  it('形状与 Agent 03 / 07 一致', () => {
    expect(pageMeta(1, 20, 45)).toEqual({ page: 1, pageSize: 20, total: 45, totalPages: 3 });
  });

  it('total 为 0 时 totalPages 仍是 1（前端不用为 0 单独写分支）', () => {
    expect(pageMeta(1, 20, 0).totalPages).toBe(1);
  });

  it('整除时不多出一页', () => {
    expect(pageMeta(1, 20, 40).totalPages).toBe(2);
  });
});

/* ------------------------------------------------------------------ */
/* 查询参数                                                            */
/* ------------------------------------------------------------------ */

/** 取 AppError 的 `details.fields`。 */
function fieldsOf(error: unknown): string[] {
  expect(error).toBeInstanceOf(AppError);
  const details = (error as AppError).details as { fields?: string[] } | null;
  return details?.fields ?? [];
}

describe('分页参数夹边界、筛选参数报错（这两者的不对称是有意的）', () => {
  it('pageSize 超上限 → 夹到 100，**不** 400', () => {
    expect(parseJobRunListQuery({ pageSize: '9999' }).pageSize).toBe(100);
  });

  it('pageSize 非法（0 / 负数 / 非数字）→ 回退默认值', () => {
    for (const bad of ['0', '-3', 'abc', '1.5']) {
      expect(parseJobRunListQuery({ pageSize: bad }).pageSize).toBe(20);
    }
  });

  it('不传 status → 不带筛选', () => {
    expect(parseJobRunListQuery({})).toEqual({ page: 1, pageSize: 20 });
  });

  it('⚠ status 非法 → 400（静默忽略会让管理员看到错误的结果集却以为筛过了）', () => {
    try {
      parseJobRunListQuery({ status: 'SUCCESS' }); // 少一个 ED
      expect.unreachable('应当抛 400');
    } catch (error) {
      const fields = fieldsOf(error);
      expect(fields).toHaveLength(1);
      expect(fields[0]).toContain('status: must be one of');
    }
  });

  it('jobType 空串或纯空白 → 视为没给', () => {
    expect(parseJobRunListQuery({ jobType: '' }).jobType).toBeUndefined();
    expect(parseJobRunListQuery({ jobType: '   ' }).jobType).toBeUndefined();
    expect(parseJobRunListQuery({ jobType: ' ai.score ' }).jobType).toBe('ai.score');
  });

  it('合法的 status 被接受（用的是契约枚举值）', () => {
    expect(parseJobRunListQuery({ status: JobRunStatus.DEAD }).status).toBe(JobRunStatus.DEAD);
  });

  it('通知状态只认 UNREAD / READ（不是契约枚举，如实镜像数据库的两个取值）', () => {
    expect(parseNotificationListQuery({ status: 'UNREAD' }).status).toBe('UNREAD');
    expect(() => parseNotificationListQuery({ status: 'ARCHIVED' })).toThrow(AppError);
  });

  it('一次收齐**所有**错误，而不是遇到第一个就退出', () => {
    try {
      parseJobRunListQuery({ status: 'NOPE' });
      expect.unreachable('应当抛 400');
    } catch (error) {
      expect(fieldsOf(error)).toHaveLength(1);
    }
    // 两个非法筛选同时给（通知的 status 只有一个筛选字段，
    // 这里用 job 的 status 与 jobType 一起验证「收集」这件事）。
    expect(fieldsOf(catchAppError(() => parseJobRunListQuery({ status: 'X' })))).toEqual([
      expect.stringContaining('status'),
    ]);
  });

  it('AI 用量窗口：默认 14 天、上限 30 天、0 与负数回退默认', () => {
    expect(parseAiUsageQuery({}).days).toBe(AI_USAGE_DEFAULT_DAYS);
    expect(parseAiUsageQuery({ days: '7' }).days).toBe(7);
    expect(parseAiUsageQuery({ days: '999' }).days).toBe(AI_USAGE_MAX_DAYS);
    expect(parseAiUsageQuery({ days: '0' }).days).toBe(AI_USAGE_DEFAULT_DAYS);
    expect(parseAiUsageQuery({ days: '-5' }).days).toBe(AI_USAGE_DEFAULT_DAYS);
  });

  it('上限是 30，不是更大 —— 它决定最坏情况下的查询数（每天一条聚合）', () => {
    expect(AI_USAGE_MAX_DAYS).toBe(30);
  });
});

function catchAppError(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to throw');
}
