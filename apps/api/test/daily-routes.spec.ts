/**
 * 日报路由面与守卫的守卫。
 *
 * ── 这里验什么、不验什么 ────────────────────────────────────────────
 * `AdminGuard` / `AdminOriginGuard` 的**行为**分别由 Agent 02
 *（`auth-guards.spec.ts`）与 Agent 07（`admin-review-routes.spec.ts`）覆盖。
 * 本模块只是**应用**它们，所以这里验的是另外三件事：
 *
 * 1. **它们确实被应用了** —— 读控制器元数据，而不是靠「我写了 @UseGuards」；
 * 2. **路由精确等于约定**（`docs/04` 只写了「沿用 v1.0」，v1.0 不在包里，
 *    因此这套路径是本模块定义并提了 CCR 的；多一条、少一条都要红）；
 * 3. **路由声明顺序** —— `/daily/archive` 必须在 `/daily/:date` **之前**。
 *    这条最容易被「顺手整理代码」弄坏，而坏掉之后前台只会看到
 *    「归档接口 400」这种指向错误地方的报错。
 */

import { describe, expect, it } from 'vitest';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { AdminDailyController, PublicDailyController } from '../src/modules/daily/controller';
import { AdminGuard } from '../src/common/guards';
import { AdminOriginGuard } from '../src/modules/admin-review/admin-origin.guard';

type Controller = new (...args: never[]) => unknown;

/** 「方法 + 路径」清单（按声明顺序，不排序）。 */
function routesOf(controller: Controller): string[] {
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
  return routes;
}

function guardsOf(controller: Controller): unknown[] {
  return (Reflect.getMetadata(GUARDS_METADATA, controller) as unknown[] | undefined) ?? [];
}

describe('Admin 日报路由（本模块定义的形状，已提 CCR）', () => {
  it('六条，与约定逐字一致', () => {
    expect([...routesOf(AdminDailyController)].sort()).toEqual([
      'GET /admin/daily',
      'GET /admin/daily/:date',
      'POST /admin/daily/:date/cancel',
      'POST /admin/daily/:date/publish',
      'POST /admin/daily/:date/schedule',
      'PUT /admin/daily/:date/sections',
    ]);
  });

  it('`POST /admin/daily/:date/publish` 与 openapi-outline 里固定的那一条一致', () => {
    // `contracts/openapi-outline.yaml` 是全包唯一写死了 Admin Publishing 路径的文件。
    expect(routesOf(AdminDailyController)).toContain('POST /admin/daily/:date/publish');
  });

  it('整个控制器套了 Origin + Admin 守卫（docs/14）', () => {
    const guards = guardsOf(AdminDailyController);
    expect(guards).toContain(AdminOriginGuard);
    expect(guards).toContain(AdminGuard);
  });
});

describe('公开日报路由', () => {
  it('两条（docs/04 的 /daily/:date 与 /daily/archive）', () => {
    expect([...routesOf(PublicDailyController)].sort()).toEqual([
      'GET /daily/:date',
      'GET /daily/archive',
    ]);
  });

  it('公开面**不加守卫**（docs/00 的游客能力含日报）', () => {
    expect(guardsOf(PublicDailyController)).toEqual([]);
  });

  it('⚠ `archive` 必须声明在 `:date` 之前（否则归档会被 :date 吃掉并返回 400）', () => {
    const routes = routesOf(PublicDailyController);
    const archiveIndex = routes.indexOf('GET /daily/archive');
    const dateIndex = routes.indexOf('GET /daily/:date');

    expect(archiveIndex).toBeGreaterThanOrEqual(0);
    expect(dateIndex).toBeGreaterThanOrEqual(0);
    expect(
      archiveIndex,
      'Nest 按声明顺序匹配路由；archive 排在 :date 之后会让 /daily/archive 命中 :date',
    ).toBeLessThan(dateIndex);
  });
});
