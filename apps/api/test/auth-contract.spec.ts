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
import { createAuthTestApp, registeredRoutes } from './support/test-app';
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

  it('★ 路由表**精确等于**契约：多挂一条未登记的端点也要红', async () => {
    const test = await boot();

    const actual = registeredRoutes(test.app);
    const expected = DOCUMENTED_ROUTES.map(([method, path]) => `${method} ${path}`).sort();

    // 这条断言与「逐条探测 404」的区别：后者在**多**出端点时依然全绿。
    // （独立审查实测：注入一条 `GET /api/v1/auth/whoami-extra` 后旧写法不红。）
    expect(actual).toEqual(expected);
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

  it('业务模块里不出现绕过 ORM 的原生写库，也不出现 ADMIN 字面量', () => {
    // ⚠ 覆盖范围的**已知残余缺口**（独立审查指出，这里如实记录而不是假装覆盖）：
    //   动态值（`role: someVar`）、计算键名（`[k]: 'ADMIN'`）、以及通过
    //   原生 SQL 改角色，静态扫描都抓不到。
    //   真正的兜底是「路由面精确等于契约」那条断言（多一个提权端点就红）
    //   以及 AdminGuard 以数据库角色为准。这里只拦住最容易发生的几种写法。
    const RAW_SQL = /\$(?:executeRaw|queryRaw|executeRawUnsafe|queryRawUnsafe)/;
    const ADMIN_LITERAL = /['"`]ADMIN['"`]/;

    const offenders = sourceFiles()
      .filter((file) => file.relativePath.startsWith('modules/'))
      .filter((file) => RAW_SQL.test(file.code) || ADMIN_LITERAL.test(file.code))
      .map((file) => file.relativePath);

    expect(offenders).toEqual([]);
  });

  it('越界守卫本身有牙齿：注入一个提权写法必须被抓到', () => {
    // 反证：把「记忆里的写库写法」喂给同一组规则，确认它们真的会命中。
    const WRITE = 'await tx.user.update({ where: { id }, data: { role: UserRole.ADMIN } });';
    const RAW = "await this.prisma.$executeRaw`UPDATE users SET role = 'ADMIN'`;";
    const LITERAL = "data: { role: 'ADMIN' }";

    expect(ROLE_ADMIN_WRITE_PATTERNS.some((p) => p.test(WRITE))).toBe(true);
    expect(/\$(?:executeRaw|queryRaw|executeRawUnsafe|queryRawUnsafe)/.test(RAW)).toBe(true);
    expect(/['"`]ADMIN['"`]/.test(LITERAL)).toBe(true);
  });

  /**
   * 可以声明 `/admin/*` 路由的模块**白名单**。
   *
   * 原始断言是「`modules/**` 里一律不许出现 admin 前缀」——那是在 Auth 是
   * 唯一业务模块时写的。Agent 03 交付的 Source Registry 是
   * `docs/04` 里 Admin 路由的**合法所有者**（`/admin/sources` 共 8 条）。
   *
   * 因此把规则改成「只有登记过的所有者可以」，保留它真正的用途：
   * 一个**没有登记**的模块突然声明 admin 路由会被抓住。
   * 新增所有者必须同时改这里 —— 那次改动会在 diff 里显式出现。
   */
  const ADMIN_ROUTE_OWNERS = ['modules/sources/controller.ts'];

  /**
   * 判定「哪个文件声明了 admin 路由」的**唯一**规则。
   *
   * 抽成函数是为了让下面那条「有牙齿」的用例能跑**同一套代码** ——
   * 独立审查指出：早先那版反证只对字符串数组调了一次 `filter`，
   * 连正则都没碰到，是纯粹的同义反复。
   *
   * ⚠ 已知残余缺口（记录而非假装没有）：正则只认 `@Controller('...')` 这种
   * 字面量写法。`@Controller(ADMIN_SOURCES)`（常量）与模板字符串
   * `@Controller(`admin/x`)` 都**读不到**。本仓库目前全是字面量写法，
   * 所以现在够用；将来若引入常量，请先修这里。
   */
  const ADMIN_CONTROLLER_PATTERN = /Controller\(\s*['"][^'"]*admin/i;

  function adminRouteOwnerOffenders(files: { relativePath: string; code: string }[]): string[] {
    return files
      .filter((file) => file.relativePath.startsWith('modules/'))
      .filter((file) => ADMIN_CONTROLLER_PATTERN.test(file.code))
      .map((file) => file.relativePath)
      .filter((path) => !ADMIN_ROUTE_OWNERS.includes(path));
  }

  it('只有登记过的模块可以声明 admin 路由前缀', () => {
    expect(adminRouteOwnerOffenders(sourceFiles())).toEqual([]);
  });

  it('守卫有牙齿：把合成样本喂给**同一套过滤**，未登记的模块必须被命中', () => {
    const synthetic = [
      // 登记过的所有者 —— 必须放行
      { relativePath: 'modules/sources/controller.ts', code: "@Controller('admin/sources')" },
      // 未登记的模块 —— 必须被抓到
      { relativePath: 'modules/bookmarks/controller.ts', code: "@Controller('admin/bookmarks')" },
      // 非 admin 路由 —— 必须放行
      { relativePath: 'modules/other/controller.ts', code: "@Controller('contents')" },
      // 不在 modules/ 下 —— 不在本守卫范围内
      { relativePath: 'common/guards/admin.guard.ts', code: "@Controller('admin/x')" },
      // 双引号写法也要认
      { relativePath: 'modules/two/controller.ts', code: '@Controller("admin/two")' },
    ];

    expect(adminRouteOwnerOffenders(synthetic)).toEqual([
      'modules/bookmarks/controller.ts',
      'modules/two/controller.ts',
    ]);
  });

  it('残留缺口有记录：常量与模板字符串写法读不到（提醒将来修）', () => {
    // 这条**不是在断言「这是对的」**，而是把已知缺口钉在测试里，
    // 免得将来有人以为守卫覆盖了所有写法。
    expect(ADMIN_CONTROLLER_PATTERN.test("@Controller(ADMIN_SOURCES)")).toBe(false);
    expect(ADMIN_CONTROLLER_PATTERN.test('@Controller(`admin/sources`)')).toBe(false);
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

describe('日志里的 URL 必须去掉查询串（docs/14：不记录 OAuth code）', () => {
  it('回调失败时日志中不出现 code / state', async () => {
    const test = await boot();

    // 带一个明显的哨兵值，便于断言它没有落进日志
    const response = await test.request(
      '/api/v1/auth/github/callback?code=SECRET_OAUTH_CODE&state=SECRET_STATE_VALUE',
    );
    expect(response.status).toBeGreaterThanOrEqual(400);

    const logs = test.logStream.lines.join('');
    expect(logs.length).toBeGreaterThan(0);
    expect(logs).not.toContain('SECRET_OAUTH_CODE');
    expect(logs).not.toContain('SECRET_STATE_VALUE');
    // 路径本身仍然要留下，否则排查问题时什么都看不到
    expect(logs).toContain('/api/v1/auth/github/callback');
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
