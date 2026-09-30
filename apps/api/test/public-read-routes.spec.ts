/**
 * 公开读与搜索的路由面守卫。
 *
 * 两条断言：
 * 1. 路由**精确等于** `docs/04` 的 Public 段里属于本模块的那些（多一条即红）；
 * 2. **公开面没有守卫** —— 它们是游客可读的（`docs/00`），
 *    误加一个 `@UseGuards` 会让游客全部 401 而没有任何测试变红。
 */

import { describe, expect, it } from 'vitest';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { PublicReadController } from '../src/modules/public-read/controller';
import { SearchController } from '../src/modules/search/controller';

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
    // ⚠ 空前缀要处理：`PublicReadController` 用的是 `@Controller()`（无前缀），
    // 因为它的路由是 `/today` / `/contents/:id` 这种**顶层**路径。
    // 第一版无条件拼 `/${basePath}`，于是得到 `//contents/:id`。
    // Nest 对 `@Controller()`（无前缀）给出的元数据是 `'/'`，不是 `''`。
    const prefix =
      basePath === undefined || basePath === '' || basePath === '/' ? '' : `/${basePath}`;
    routes.push(`${httpMethod} ${prefix}${path === '/' ? '' : `/${path}`}`);
  }
  return routes.sort();
}

describe('公开读的路由面', () => {
  it('精确等于 docs/04 Public 段里属于本模块的十条', () => {
    expect(routesOf(PublicReadController)).toEqual([
      'GET /contents/:id',
      'GET /contents/:id/evidence',
      'GET /people',
      'GET /people/:slug',
      'GET /sources/:slug',
      'GET /today',
      'GET /topics',
      'GET /topics/:slug',
      'GET /x',
    ]);
  });

  it('搜索一条', () => {
    expect(routesOf(SearchController)).toEqual(['GET /search']);
  });

  it('⚠ **公开面一个守卫都没有**（docs/00：游客可读）', () => {
    for (const controller of [PublicReadController, SearchController]) {
      expect(
        (Reflect.getMetadata(GUARDS_METADATA, controller) as unknown[] | undefined) ?? [],
        `${controller.name} 不该有守卫`,
      ).toEqual([]);
    }
  });

  it('⚠ 本模块**不**声明 `/featured` 或 `/daily/*`（那是 Agent 08 的所有权）', () => {
    const all = [...routesOf(PublicReadController), ...routesOf(SearchController)];
    for (const path of all) {
      expect(path).not.toContain('/featured');
      expect(path).not.toContain('/daily');
    }
  });
});
