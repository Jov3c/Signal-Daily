/**
 * 契约与越界守卫。
 *
 * 这些用例不是「功能测试」，而是**防回归的围栏**：
 *   - 路由面必须与 `docs/04` 精确一致：多一条未登记的公开端点都应该让测试红。
 *   - V1 已取消订阅模块（`docs/13`）：仓库里不该出现任何订阅端点或表名字样。
 *   - 不允许出现 USER→ADMIN 的提权入口。
 *   - 错误码必须符合 `DOMAIN_REASON` 且已在契约里登记。
 *   - 验证码 / 令牌绝不进结构化日志（`docs/14`）。
 */

import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DomainErrorCode,
  PlatformErrorCode,
  isAppError,
  isValidErrorCode,
} from '@signal/contracts';
import {
  TEST_EMAIL,
  TEST_OTP_CODE,
  cookieValue,
  setCookies,
  type AuthTestApp,
} from './support/test-app';
import { createAuthTestApp } from './support/test-app';
import { ROLE_ADMIN_WRITE_PATTERNS, readSourceFiles } from './support/source-scan';

const API_SRC = fileURLToPath(new URL('../src', import.meta.url));

/** 读一次即可，多个用例复用。 */
let cachedSources: ReturnType<typeof readSourceFiles> | undefined;
function sourceFiles(): ReturnType<typeof readSourceFiles> {
  cachedSources ??= readSourceFiles(API_SRC);
  return cachedSources;
}

let app: AuthTestApp | undefined;

async function boot(options: Parameters<typeof createAuthTestApp>[0] = {}): Promise<AuthTestApp> {
  app = await createAuthTestApp(options);
  return app;
}

afterEach(async () => {
  await app?.close();
  app = undefined;
});

/**
 * GET / HEAD 不允许带请求体（fetch 会直接抛 TypeError），
 * 而路由是否挂载与有没有 body 无关。
 */
function withBody(method: string): RequestInit {
  return method === 'GET' || method === 'HEAD' ? { method } : { method, body: '{}' };
}

describe('路由面（真实 HTTP）', () => {
  const DOCUMENTED_ROUTES: [string, string][] = [
    ['POST', '/api/v1/auth/email/request-code'],
    ['POST', '/api/v1/auth/email/verify'],
    ['GET', '/api/v1/auth/github'],
    ['GET', '/api/v1/auth/github/callback'],
    ['POST', '/api/v1/auth/refresh'],
    ['POST', '/api/v1/auth/logout'],
    ['GET', '/api/v1/me'],
  ];

  it('docs/04 Auth 段的 7 条路由全部挂载', async () => {
    const test = await boot();

    for (const [method, path] of DOCUMENTED_ROUTES) {
      const response = await test.request(path, {
        method,
        ...(method === 'POST' ? { body: '{}' } : {}),
      });
      // 404 才会说明路由不存在；其余状态（400/401/302/503）都说明路由已挂载。
      expect(response.status, `${method} ${path}`).not.toBe(404);
    }
  });

  it('V1 已取消的订阅端点不存在', async () => {
    const test = await boot();

    for (const path of [
      '/api/v1/subscriptions',
      '/api/v1/subscriptions/feed',
      '/api/v1/me/subscriptions',
      '/api/v1/people/karpathy/subscribe',
      '/api/v1/topics/ai/subscribe',
    ]) {
      const get = await test.request(path);
      expect(get.status, `GET ${path}`).toBe(404);
      const post = await test.request(path, { method: 'POST', body: '{}' });
      expect(post.status, `POST ${path}`).toBe(404);
    }
  });

  it('不存在任何 USER→ADMIN 的提权入口', async () => {
    const test = await boot();

    for (const [method, path] of [
      ['POST', '/api/v1/admin/users/1/role'],
      ['PATCH', '/api/v1/me'],
      ['PUT', '/api/v1/me/role'],
      ['POST', '/api/v1/me/role'],
      ['POST', '/api/v1/auth/role'],
      ['POST', '/api/v1/users/1/role'],
    ] as [string, string][]) {
      const response = await test.request(path, withBody(method));
      expect(response.status, `${method} ${path}`).toBe(404);
    }
  });

  it('Auth 模块也没有实现其他 Agent 的端点（偏好、收藏、阅读进度）', async () => {
    const test = await boot();

    for (const [method, path] of [
      ['GET', '/api/v1/me/preferences'],
      ['PUT', '/api/v1/me/preferences'],
      ['GET', '/api/v1/bookmarks'],
      ['PUT', '/api/v1/reading-progress'],
      ['GET', '/api/v1/admin/sources'],
    ] as [string, string][]) {
      const response = await test.request(path, withBody(method));
      expect(response.status, `${method} ${path}`).toBe(404);
    }
  });

  it('方法不匹配时是 404（路由按 HTTP 方法精确挂载）', async () => {
    const test = await boot();

    expect((await test.request('/api/v1/auth/email/verify')).status).toBe(404);
    expect((await test.request('/api/v1/auth/email/request-code')).status).toBe(404);
    expect((await test.request('/api/v1/me', { method: 'POST', body: '{}' })).status).toBe(404);
  });
});

describe('源码围栏（静态扫描 apps/api/src）', () => {
  it('扫描到了源码（防止测试空跑）', () => {
    expect(sourceFiles().length).toBeGreaterThan(10);
  });

  it('源码里不出现 subscription 字样', () => {
    const offenders = sourceFiles()
      .filter((file) => /subscription/i.test(file.code))
      .map((file) => file.relativePath);

    expect(offenders).toEqual([]);
  });

  it('业务模块里不存在「把角色写成 ADMIN」的代码路径', () => {
    // 只禁止**写入**（Prisma data 里的 `role: ...ADMIN`、属性赋值 `.role = ...ADMIN`）。
    // 比较（`role !== UserRole.ADMIN`，例如 access token 载荷校验）是合法的，
    // 所以不能简单地禁掉 `UserRole.ADMIN` 这个字符串本身。
    const offenders = sourceFiles()
      .filter((file) => file.relativePath.startsWith('modules/'))
      .filter((file) => ROLE_ADMIN_WRITE_PATTERNS.some((pattern) => pattern.test(file.code)))
      .map((file) => file.relativePath);

    expect(offenders).toEqual([]);
  });

  it('业务模块里不声明 admin 路由前缀', () => {
    const offenders = sourceFiles()
      .filter((file) => file.relativePath.startsWith('modules/'))
      .filter((file) => /Controller\(\s*['"][^'"]*admin/i.test(file.code))
      .map((file) => file.relativePath);

    expect(offenders).toEqual([]);
  });

  it('代码里出现的错误码字面量都符合 DOMAIN_REASON 且已登记', () => {
    const registered = new Set<string>([
      ...Object.values(PlatformErrorCode),
      ...Object.values(DomainErrorCode),
    ]);

    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      const content = file.code;
      for (const match of content.matchAll(/\bcode:\s*'([A-Z0-9_]+)'/g)) {
        const code = match[1];
        if (code === undefined) continue;
        if (!isValidErrorCode(code) || !registered.has(code)) {
          offenders.push(`${file.relativePath}: ${code}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('Agent 02 新增的错误码全部符合命名规则且互不相同', () => {
    const authCodes = Object.entries(DomainErrorCode).filter(
      ([, value]) => value.startsWith('AUTH_') || value === 'USER_NOT_FOUND',
    );

    expect(authCodes.length).toBeGreaterThan(5);
    for (const [key, value] of authCodes) {
      expect(isValidErrorCode(value), value).toBe(true);
      expect(key).toBe(value); // key 与值一致，避免别名造成同义码
    }
    expect(new Set(authCodes.map(([, value]) => value)).size).toBe(authCodes.length);
  });
});

describe('Cookie 策略', () => {
  it('生产形态（secureCookies=true）会带上 Secure 与正确的 Max-Age', async () => {
    const test = await boot({ config: { secureCookies: true } });
    await test.request('/api/v1/auth/email/request-code', {
      method: 'POST',
      body: JSON.stringify({ email: TEST_EMAIL }),
    });
    const login = await test.request('/api/v1/auth/email/verify', {
      method: 'POST',
      body: JSON.stringify({ email: TEST_EMAIL, code: TEST_OTP_CODE }),
    });

    const cookies = setCookies(login);
    const access = cookies.find((c) => c.startsWith('signal_access_token=')) ?? '';
    const refresh = cookies.find((c) => c.startsWith('signal_refresh_token=')) ?? '';

    expect(access).toContain('Secure');
    expect(refresh).toContain('Secure');
    expect(access).toContain('Max-Age=900'); // 15 分钟
    expect(refresh).toContain('Max-Age=2592000'); // 30 天
    expect(access).toContain('HttpOnly');
    expect(refresh).toContain('HttpOnly');
    expect(access).toContain('SameSite=Lax');
    expect(refresh).toContain('SameSite=Lax');
  });
});

describe('日志不泄漏凭据（docs/14）', () => {
  it('验证码、access token、refresh token 都不进结构化日志', async () => {
    const test = await boot();

    await test.request('/api/v1/auth/email/request-code', {
      method: 'POST',
      body: JSON.stringify({ email: TEST_EMAIL }),
    });
    const login = await test.request('/api/v1/auth/email/verify', {
      method: 'POST',
      body: JSON.stringify({ email: TEST_EMAIL, code: TEST_OTP_CODE }),
    });
    await test.request('/api/v1/auth/refresh', {
      method: 'POST',
      cookie: `signal_refresh_token=${encodeURIComponent(
        cookieValue(setCookies(login), 'signal_refresh_token') ?? '',
      )}`,
    });
    // 制造一次失败请求，确认错误路径同样不泄漏
    await test.request('/api/v1/auth/email/verify', {
      method: 'POST',
      body: JSON.stringify({ email: TEST_EMAIL, code: '000000' }),
    });

    const logs = test.logStream.lines.join('');
    expect(logs.length).toBeGreaterThan(0);
    expect(logs).not.toContain(TEST_OTP_CODE);
    expect(logs).not.toContain(cookieValue(setCookies(login), 'signal_access_token') ?? '@@none@@');
    expect(logs).not.toContain(
      cookieValue(setCookies(login), 'signal_refresh_token') ?? '@@none@@',
    );
    // 邮箱本身也不应明文进日志（PII）
    expect(logs).not.toContain('"reader@example.com"');
  });
});

describe('GET /me 的载荷', () => {
  it('只含身份字段，不含任何凭据或内部字段', async () => {
    const test = await boot();
    await test.request('/api/v1/auth/email/request-code', {
      method: 'POST',
      body: JSON.stringify({ email: TEST_EMAIL }),
    });
    const login = await test.request('/api/v1/auth/email/verify', {
      method: 'POST',
      body: JSON.stringify({ email: TEST_EMAIL, code: TEST_OTP_CODE }),
    });
    const cookies = setCookies(login)
      .map((c) => c.split(';')[0]?.trim())
      .filter((pair): pair is string => pair !== undefined && pair.includes('signal_'))
      .join('; ');

    const me = await test.request('/api/v1/me', { cookie: cookies });
    const payload = (await me.json()) as { data: Record<string, unknown> };

    expect(Object.keys(payload.data).sort()).toEqual([
      'avatarUrl',
      'createdAt',
      'displayName',
      'email',
      'id',
      'role',
    ]);
    expect(payload.data.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/); // ISO 8601 UTC
  });
});

describe('错误封套契约（docs/02）', () => {
  it('所有对外错误都是 {error:{code,message,requestId,details}}', async () => {
    const test = await boot();

    const responses = [
      await test.request('/api/v1/me'),
      await test.request('/api/v1/auth/email/verify', { method: 'POST', body: '{}' }),
      await test.request('/api/v1/auth/email/request-code', { method: 'POST', body: '{}' }),
    ];

    for (const response of responses) {
      expect(response.status).toBeGreaterThanOrEqual(400);
      const body = (await response.json()) as { error: Record<string, unknown> };
      expect(Object.keys(body)).toEqual(['error']);
      expect(Object.keys(body.error).sort()).toEqual(['code', 'details', 'message', 'requestId']);

      // ⚠ 只有**业务码**必须满足 DOMAIN_REASON；平台级码（UNAUTHORIZED / FORBIDDEN /
      // CONFLICT）是 Agent 00 既有的注册表取值，不带下划线，不适用该正则。
      const code = String(body.error.code);
      const isPlatformCode = Object.values(PlatformErrorCode).includes(
        code as (typeof PlatformErrorCode)[keyof typeof PlatformErrorCode],
      );
      expect(isPlatformCode || isValidErrorCode(code), code).toBe(true);
      expect(typeof body.error.message).toBe('string');
      expect(String(body.error.requestId)).toMatch(/^req_[0-9a-f]{24}$/);
      expect(response.headers.get('x-request-id')).toBe(body.error.requestId);
    }
  });

  it('未登录访问 /me 的错误不泄漏栈或内部类名', async () => {
    const test = await boot();
    const response = await test.request('/api/v1/me');
    const text = await response.text();

    expect(text).not.toContain('AppError');
    expect(text).not.toContain('at ');
    expect(text).not.toContain('node_modules');
  });
});

describe('错误对象本身', () => {
  it('AppError 的 code 与 httpStatus 一一对应（用真实守卫触发）', async () => {
    const test = await boot();
    const response = await test.request('/api/v1/auth/refresh', { method: 'POST', body: '{}' });

    const body = (await response.json()) as { error: { code: string } };
    expect(response.status).toBe(401);
    expect(body.error.code).toBe(DomainErrorCode.AUTH_SESSION_INVALID);
    expect(isAppError(new Error('x'))).toBe(false);
  });
});
