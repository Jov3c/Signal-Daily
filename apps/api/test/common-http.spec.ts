/**
 * `common/http` 的单元测试 —— Cookie 序列化/解析、requestId、错误封套。
 *
 * 这些是**所有模块都要用的地基**（下游 03/07/09/12 也会依赖），
 * 而且都在处理外部输入，所以边界值必须逐条钉死。
 */

import { afterEach, describe, expect, it } from 'vitest';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Controller, Get, UseGuards } from '@nestjs/common';
import {
  AppError,
  DomainErrorCode,
  PlatformErrorCode,
  REQUEST_ID_HEADER,
  isAppError,
} from '@signal/contracts';
import {
  REQUEST_ID_PATTERN,
  countCookie,
  generateRequestId,
  mapExceptionToApiError,
  parseCookieHeader,
  readCookie,
  resolveRequestId,
  serializeClearedCookie,
  serializeCookie,
} from '../src/common/http';
import type { HttpRequestLike } from '../src/common/http/http-types';
import { createAuthTestApp, type AuthTestApp } from './support/test-app';
import { AdminGuard } from '../src/common/guards';

let app: AuthTestApp | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('serializeCookie', () => {
  it('默认 Path=/ 且 HttpOnly 打开，不擅自加 Secure', () => {
    expect(serializeCookie('a', 'b')).toContain('Path=/');
    expect(serializeCookie('a', 'b')).toContain('HttpOnly');
    expect(serializeCookie('a', 'b')).not.toContain('Secure');
    expect(serializeCookie('a', 'b')).not.toContain('SameSite');
  });

  it('值做 URL 编码，分号、逗号、空格、非 ASCII 都不会破坏语法', () => {
    const value = 'a;b,c d=e/你';
    const cookie = serializeCookie('token', value);

    expect(cookie).toBe(`token=${encodeURIComponent(value)}; Path=/; HttpOnly`);
    expect(cookie.split(';').length).toBe(3);
    expect(parseCookieHeader(cookie.split('; ').join('; '))['token']).toBe(value);
  });

  it('支持全部属性', () => {
    const cookie = serializeCookie('t', 'v', {
      path: '/api/v1/auth',
      maxAgeSeconds: 60,
      secure: true,
      sameSite: 'Lax',
      domain: 'signal.example.com',
    });

    expect(cookie).toContain('Path=/api/v1/auth');
    expect(cookie).toContain('Max-Age=60');
    expect(cookie).toContain('Domain=signal.example.com');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('HttpOnly');
  });

  it('Max-Age 取整且不为负', () => {
    expect(serializeCookie('a', 'b', { maxAgeSeconds: 10.7 })).toContain('Max-Age=10');
    expect(serializeCookie('a', 'b', { maxAgeSeconds: -5 })).toContain('Max-Age=0');
  });

  it('清除 Cookie 用 Max-Age=0 且保留同一套 Path', () => {
    const cleared = serializeClearedCookie('signal_refresh_token', { path: '/api/v1/auth' });
    expect(cleared).toContain('Max-Age=0');
    expect(cleared).toContain('Path=/api/v1/auth');
    expect(cleared.startsWith('signal_refresh_token=;')).toBe(true);
  });
});

describe('parseCookieHeader', () => {
  it('解析多个 Cookie，容忍空格', () => {
    expect(parseCookieHeader('a=1;  b=2;c=3')).toEqual({ a: '1', b: '2', c: '3' });
  });

  it('值里可以包含 =', () => {
    expect(parseCookieHeader('token=abc=def==')).toEqual({ token: 'abc=def==' });
  });

  it('空值、缺 = 的片段不会让解析失败', () => {
    expect(parseCookieHeader('a=; b; =c; d=1')).toEqual({ a: '', d: '1' });
  });

  it('URL 编码的值会被解码；解码失败时退回原值而不是抛异常', () => {
    expect(parseCookieHeader('a=hello%20world')['a']).toBe('hello world');
    expect(parseCookieHeader('a=%E4%BD%A0%E5%A5%BD')['a']).toBe('你好');
    // 单独的 % 是非法编码
    expect(() => parseCookieHeader('a=100%')).not.toThrow();
    expect(parseCookieHeader('a=100%')['a']).toBe('100%');
  });

  it('未定义的头返回空对象', () => {
    expect(parseCookieHeader(undefined)).toEqual({});
  });

  it('同名 Cookie 第一个生效（RFC 6265 允许服务端自选）', () => {
    expect(parseCookieHeader('a=first; a=second')['a']).toBe('first');
  });

  it('countCookie 能数出同名 Cookie 的数量', () => {
    expect(countCookie('a=1; a=2; b=3', 'a')).toBe(2);
    expect(countCookie('a=1; b=3', 'a')).toBe(1);
    expect(countCookie(undefined, 'a')).toBe(0);
  });

  it('readCookie 按名字取值', () => {
    expect(readCookie('a=1; b=2', 'b')).toBe('2');
    expect(readCookie('a=1', 'zzz')).toBeUndefined();
  });
});

describe('requestId', () => {
  it('只接受安全形状的传入值', () => {
    for (const value of ['req_abc-123', 'a.b:c_d', 'A'.repeat(128)]) {
      expect(REQUEST_ID_PATTERN.test(value), value).toBe(true);
    }
    for (const value of ['', 'a b', 'a/b', 'a'.repeat(129), '中文', 'a\nb']) {
      expect(REQUEST_ID_PATTERN.test(value), value).toBe(false);
    }
  });

  it('生成的 ID 形如 req_ + 24 位十六进制', () => {
    expect(generateRequestId()).toMatch(/^req_[0-9a-f]{24}$/);
    expect(generateRequestId()).not.toBe(generateRequestId());
  });

  it('沿用合法的 x-request-id，非法则重新生成', () => {
    const valid: HttpRequestLike = { headers: { [REQUEST_ID_HEADER]: 'req_caller_1' } };
    expect(resolveRequestId(valid)).toBe('req_caller_1');

    const invalid: HttpRequestLike = { headers: { [REQUEST_ID_HEADER]: 'bad id with spaces' } };
    const generated = resolveRequestId(invalid);
    expect(generated).toMatch(/^req_[0-9a-f]{24}$/);

    // 超长值不会被回显（否则等于把任意字符串灌进日志与响应头）
    const oversized: HttpRequestLike = { headers: { [REQUEST_ID_HEADER]: 'x'.repeat(500) } };
    expect(resolveRequestId(oversized).length).toBeLessThanOrEqual(32);
  });

  it('重复请求同一对象返回同一个值（幂等）', () => {
    const req: HttpRequestLike = { headers: {} };
    expect(resolveRequestId(req)).toBe(resolveRequestId(req));
  });

  it('请求头是数组时取第一个', () => {
    const req: HttpRequestLike = { headers: { [REQUEST_ID_HEADER]: ['req_a', 'req_b'] } };
    expect(resolveRequestId(req)).toBe('req_a');
  });
});

describe('mapExceptionToApiError', () => {
  it('AppError 原样透传（业务码不会被平台码覆盖）', () => {
    const error = new AppError({
      code: DomainErrorCode.AUTH_OTP_EXPIRED,
      httpStatus: 401,
      safeMessage: 'This code has expired',
      details: { a: 1 },
    });

    expect(mapExceptionToApiError(error)).toEqual({
      httpStatus: 401,
      code: DomainErrorCode.AUTH_OTP_EXPIRED,
      message: 'This code has expired',
      details: { a: 1 },
    });
  });

  it('框架异常映射为平台码，并采用通用安全文案', () => {
    expect(mapExceptionToApiError(new BadRequestException('内部细节'))).toMatchObject({
      httpStatus: 400,
      code: PlatformErrorCode.VALIDATION_FAILED,
      message: 'Request validation failed',
    });
    expect(mapExceptionToApiError(new ForbiddenException())).toMatchObject({
      httpStatus: 403,
      code: PlatformErrorCode.FORBIDDEN,
    });
    expect(mapExceptionToApiError(new NotFoundException())).toMatchObject({
      httpStatus: 404,
      code: PlatformErrorCode.NOT_FOUND,
    });
  });

  it('400 只把「字符串数组形式的字段消息」放进 details', () => {
    const withArray = new BadRequestException({ message: ['email must be a string'] });
    expect(mapExceptionToApiError(withArray).details).toEqual({
      fields: ['email must be a string'],
    });

    // 含非字符串元素 → 整个丢弃，避免把输入值回显出去
    const withValues = new BadRequestException({ message: [{ value: 'secret', property: 'x' }] });
    expect(mapExceptionToApiError(withValues).details).toBeNull();

    const notArray = new BadRequestException({ message: 'plain' });
    expect(mapExceptionToApiError(notArray).details).toBeNull();
  });

  it('未知异常降级为 INTERNAL_ERROR，不带任何内部信息', () => {
    const mapped = mapExceptionToApiError(new Error('db password is hunter2'));
    expect(mapped).toEqual({
      httpStatus: 500,
      code: PlatformErrorCode.INTERNAL_ERROR,
      message: 'Internal server error',
      details: null,
    });
    expect(JSON.stringify(mapped)).not.toContain('hunter2');
  });
});

/** 探针：抛出一个「内部异常」，验证过滤器不会把它泄漏出去。 */
@Controller('__probe/boom')
class BoomProbeController {
  @Get()
  boom(): never {
    throw new Error('internal failure containing secret-xyz');
  }
}

/** 探针：验证下游如何套 AdminGuard。 */
@Controller('__probe/boom-admin')
@UseGuards(AdminGuard)
class BoomAdminProbeController {
  @Get()
  guarded(): string {
    return 'should not reach here';
  }
}

describe('全局异常过滤器（真实 HTTP）', () => {
  it('未预期的异常 → 500 + 统一封套，且不泄漏内部信息', async () => {
    app = await createAuthTestApp({
      probeControllers: [BoomProbeController, BoomAdminProbeController],
    });

    const response = await app.request('/api/v1/__probe/boom');
    expect(response.status).toBe(500);

    const text = await response.text();
    expect(text).not.toContain('secret-xyz');
    expect(text).not.toContain('internal failure');
    expect(text).not.toContain('at ');

    const body = JSON.parse(text) as { error: { code: string; requestId: string } };
    expect(body.error.code).toBe(PlatformErrorCode.INTERNAL_ERROR);
    expect(response.headers.get('x-request-id')).toBe(body.error.requestId);
  });

  it('未知路由 → 404 且同样是统一封套', async () => {
    app = await createAuthTestApp();
    const response = await app.request('/api/v1/definitely-not-a-route');

    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toContain('application/json');
    const body = (await response.json()) as { error: { code: string; requestId: string } };
    expect(body.error.code).toBe(PlatformErrorCode.NOT_FOUND);
    expect(body.error.requestId).toMatch(/^req_/);
  });

  it('isAppError 不会把普通 Error 误判为业务错误', () => {
    expect(isAppError(new AppError({ code: 'X_Y', safeMessage: 'm' }))).toBe(true);
    expect(isAppError(new Error('m'))).toBe(false);
    expect(isAppError({ code: 'X_Y', safeMessage: 'm' })).toBe(false);
  });
});
