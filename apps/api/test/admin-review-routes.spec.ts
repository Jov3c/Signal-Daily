/**
 * 路由面与守卫的守卫。
 *
 * ── 为什么这里不测 `AdminGuard` 的 HTTP 行为 ────────────────────────
 * `AdminGuard` / `AuthGuard` 是 **Agent 02 交付的**，它们的行为
 *（401 vs 403、撤权即时生效、token 提取顺序）已由 Agent 02 的
 * `auth-guards.spec.ts`（18 项）在真 HTTP 上覆盖。
 * 本模块只是**应用**它们，所以这里验的是另外两件事：
 *
 * 1. **它们确实被应用了**（读控制器元数据，而不是靠「我写了 @UseGuards」这句话）；
 * 2. **路由精确等于 `docs/04` 的契约** —— 多一条即红。
 *
 * `AdminOriginGuard` 是本模块自己的实现（Agent 03 那份的 CCR 未裁决），
 * 所以它的行为在这里直接测。
 */

import { describe, expect, it } from 'vitest';
import {
  GUARDS_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import type { ExecutionContext } from '@nestjs/common';
import { AppError, PlatformErrorCode } from '@signal/contracts';
import {
  AdminOriginGuard,
  createAdminOriginConfig,
} from '../src/modules/admin-review/admin-origin.guard';
import {
  DashboardController,
  EvidenceController,
  ReviewController,
} from '../src/modules/admin-review/controller';
import { AdminGuard } from '../src/common/guards';

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

/** 该控制器上应用的守卫类。 */
function guardsOf(controller: new (...args: never[]) => unknown): unknown[] {
  return (Reflect.getMetadata(GUARDS_METADATA, controller) as unknown[] | undefined) ?? [];
}

describe('路由面精确等于 docs/04 的契约', () => {
  it('审核队列四条', () => {
    expect(routeTableOf(ReviewController)).toEqual([
      'GET /admin/review',
      'GET /admin/review/:contentId',
      'POST /admin/review/:contentId/decision',
      'POST /admin/review/bulk',
    ]);
  });

  it('Evidence 五条', () => {
    expect(routeTableOf(EvidenceController)).toEqual([
      'DELETE /admin/events/:eventId/evidence/:evidenceId',
      'GET /admin/events/:eventId/evidence',
      'PATCH /admin/events/:eventId/evidence/:evidenceId',
      'POST /admin/events/:eventId/evidence',
      'POST /admin/events/:eventId/evidence/:evidenceId/set-primary',
    ]);
  });

  it('Dashboard 一条（docs/09 要求）', () => {
    expect(routeTableOf(DashboardController)).toEqual(['GET /admin/dashboard']);
  });

  it('**没有多出来的路由**（多一条即红 —— 防止顺手加接口）', () => {
    const all = [
      ...routeTableOf(ReviewController),
      ...routeTableOf(EvidenceController),
      ...routeTableOf(DashboardController),
    ];
    expect(all).toHaveLength(10);
  });

  it('**每个控制器都挂了 AdminGuard**（不是靠「我写了 @UseGuards」这句话）', () => {
    for (const controller of [ReviewController, EvidenceController, DashboardController]) {
      expect(guardsOf(controller)).toContain(AdminGuard);
    }
  });

  it('**每个控制器都挂了 AdminOriginGuard**（docs/14 的 Origin check）', () => {
    for (const controller of [ReviewController, EvidenceController, DashboardController]) {
      expect(guardsOf(controller)).toContain(AdminOriginGuard);
    }
  });

  it('**Origin 在认证之前**（纯内存判断先跑，省一次数据库往返）', () => {
    for (const controller of [ReviewController, EvidenceController, DashboardController]) {
      const guards = guardsOf(controller);
      expect(guards.indexOf(AdminOriginGuard)).toBeLessThan(guards.indexOf(AdminGuard));
    }
  });
});

describe('AdminOriginGuard 的行为', () => {
  const config = createAdminOriginConfig({
    APP_BASE_URL: 'https://signal.example.com',
    API_BASE_URL: 'https://signal.example.com/api',
  });
  const guard = new AdminOriginGuard(config);

  function contextOf(method: string, origin?: string): ExecutionContext {
    return {
      switchToHttp: () => ({
        getRequest: () => ({ method, headers: origin === undefined ? {} : { origin } }),
      }),
    } as unknown as ExecutionContext;
  }

  it('GET / HEAD / OPTIONS 直接放行（它们不改状态）', () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS']) {
      expect(guard.canActivate(contextOf(method, 'https://evil.example'))).toBe(true);
    }
  });

  it('**没有 Origin 头就放行**（同源的 curl / 服务端调用不带它，也不是 CSRF 的攻击面）', () => {
    expect(guard.canActivate(contextOf('POST'))).toBe(true);
    expect(guard.canActivate(contextOf('POST', ''))).toBe(true);
  });

  it('允许列表内的 Origin 放行', () => {
    expect(guard.canActivate(contextOf('POST', 'https://signal.example.com'))).toBe(true);
  });

  it('**跨源 Origin 被拒**（403）', () => {
    expect(() => guard.canActivate(contextOf('POST', 'https://evil.example'))).toThrow(AppError);
  });

  it('**`Origin: null` 也被拒**（沙箱 iframe / file:// 会发它）', () => {
    expect(() => guard.canActivate(contextOf('DELETE', 'null'))).toThrow(AppError);
  });

  it('**错误详情不回显收到的 Origin**（那是攻击者可控的字符串）', () => {
    try {
      guard.canActivate(contextOf('POST', 'https://evil.example'));
      throw new Error('should have thrown');
    } catch (error) {
      const appError = error as AppError;
      expect(appError.code).toBe(PlatformErrorCode.FORBIDDEN);
      expect(JSON.stringify(appError.details)).not.toContain('evil.example');
      // 但要把自己的允许列表回显出来，方便排查部署配置
      expect(JSON.stringify(appError.details)).toContain('signal.example.com');
    }
  });

  it('配置里的 URL 非法时不炸（只是那条不进允许列表）', () => {
    const broken = createAdminOriginConfig({
      APP_BASE_URL: 'not-a-url',
      API_BASE_URL: 'https://ok.example.com/api',
    });
    const brokenGuard = new AdminOriginGuard(broken);
    expect(brokenGuard.canActivate(contextOf('POST', 'https://ok.example.com'))).toBe(true);
    expect(() => brokenGuard.canActivate(contextOf('POST', 'https://not-a-url'))).toThrow();
  });
});
