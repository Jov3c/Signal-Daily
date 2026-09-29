/**
 * 精选路由面与守卫的守卫（与 `daily-routes.spec.ts` 同一手法）。
 *
 * `docs/04` 的 Public 段固定了 `GET /featured?cursor=&topic=&type=&limit=`，
 * 因此公开面那一条是**有契约依据**的；Admin 面的四条则是本模块的设计决定
 *（`docs/04` 只写了「沿用 v1.0」，而 v1.0 不在包里），已提 CCR。
 */

import { describe, expect, it } from 'vitest';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import {
  AdminFeaturedController,
  PublicFeaturedController,
} from '../src/modules/featured/controller';
import { AdminGuard } from '../src/common/guards';
import { AdminOriginGuard } from '../src/modules/admin-review/admin-origin.guard';

type Controller = new (...args: never[]) => unknown;

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

describe('Admin 精选路由', () => {
  it('四条', () => {
    expect([...routesOf(AdminFeaturedController)].sort()).toEqual([
      'DELETE /admin/featured/:contentId',
      'GET /admin/featured',
      'PATCH /admin/featured/:contentId',
      'POST /admin/featured',
    ]);
  });

  it('套了 Origin + Admin 守卫', () => {
    const guards = guardsOf(AdminFeaturedController);
    expect(guards).toContain(AdminOriginGuard);
    expect(guards).toContain(AdminGuard);
  });
});

describe('公开精选路由', () => {
  it('`GET /featured` 一条，与 docs/04 的契约一致', () => {
    expect(routesOf(PublicFeaturedController)).toEqual(['GET /featured']);
  });

  it('公开面不加守卫', () => {
    expect(guardsOf(PublicFeaturedController)).toEqual([]);
  });
});
