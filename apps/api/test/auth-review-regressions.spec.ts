/**
 * 独立审查（§23）发现的缺陷 —— **回归守卫**。
 *
 * 每个用例都对应一条实际发现，并且都做过反证（把修复改回去 → 用例变红 → 再改回）。
 * 文件名刻意独立：这些不是「功能测试」，而是「防止同一个 bug 再回来」的围栏。
 *
 * 对应关系（编号见 `work/_agent02/review-A-security.md` / `review-B-engineering.md`）：
 *   P1   GitHub 未验证邮箱可绑定既有账号   → 见 github-client.spec.ts（打真实客户端）
 *   P2-2 只带 Authorization 登出不生效
 *   P2-1/P2-4 X-Forwarded-For 可伪造 → per-IP 限流失效
 *   P2-5 + P3-3d 并发 refresh（零覆盖）
 *   P3-1 错误日志记录含查询串的 URL（OAuth code 进日志）
 *   P3-3a JWT 算法锁定 / P3-3b iss·aud 校验（原本无牙齿）
 *   P3-3c OTP 哈希绑邮箱（原本无测试）
 *   P3-3e 登出清理 Cookie 的 Path（原本断言不到具体的那个 Cookie）
 *   P3   被禁用用户登录无测试 / 超大 body 返回 500
 *   P4   会话过期未判 / refresh 限流主体名不副实
 */

import { afterEach, describe, expect, it } from 'vitest';
import jwt from 'jsonwebtoken';
import { DomainErrorCode, PlatformErrorCode, UserStatus } from '@signal/contracts';
import { rateLimitSubject } from '../src/modules/auth/rate-limiter';
import { buildAuthConfig } from '../src/modules/auth/auth.config';
import {
  ACCESS_TOKEN_AUDIENCE,
  ACCESS_TOKEN_ISSUER,
} from '../src/modules/auth/access-token.service';
import { parseEnv } from '@signal/config';
import {
  TEST_EMAIL,
  TEST_OTP_CODE,
  cookieHeader,
  cookieValue,
  setCookies,
  type AuthTestApp,
} from './support/test-app';
import { createAuthTestApp } from './support/test-app';
import { createTestEnv } from '@signal/test-utils';
import { OtpService } from '../src/modules/auth/otp.service';
import { AccessTokenService } from '../src/modules/auth/access-token.service';
import { SessionService } from '../src/modules/auth/session.service';
import type { AuthRepository } from '../src/modules/auth/repository';
import {
  FakeClock,
  InMemoryAuthRepository,
  InMemoryUserRepository,
  createTestAuthConfig,
} from './support/fakes';

const REQUEST_CODE_PATH = '/api/v1/auth/email/request-code';
const VERIFY_PATH = '/api/v1/auth/email/verify';
const REFRESH_PATH = '/api/v1/auth/refresh';
const LOGOUT_PATH = '/api/v1/auth/logout';
const ME_PATH = '/api/v1/me';

let app: AuthTestApp | undefined;

async function boot(options: Parameters<typeof createAuthTestApp>[0] = {}): Promise<AuthTestApp> {
  app = await createAuthTestApp(options);
  return app;
}

afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function login(test: AuthTestApp, email = TEST_EMAIL): Promise<string[]> {
  await test.request(REQUEST_CODE_PATH, {
    method: 'POST',
    body: JSON.stringify({ email }),
  });
  const response = await test.request(VERIFY_PATH, {
    method: 'POST',
    body: JSON.stringify({ email, code: TEST_OTP_CODE }),
  });
  expect(response.status).toBe(200);
  return setCookies(response);
}

async function errorCode(response: Response): Promise<string> {
  const payload = (await response.json()) as { error: { code: string } };
  return payload.error.code;
}

/* ------------------------------------------------------------------ */
/* P2-2 登出                                                           */
/* ------------------------------------------------------------------ */

describe('P2-2 登出必须覆盖「只用 Authorization 头」的客户端', () => {
  it('只带 Bearer、不带任何 Cookie 也能登出，且立刻失效', async () => {
    const test = await boot();
    const cookies = await login(test);
    const token = cookieValue(cookies, 'signal_access_token') ?? '';
    const auth = { authorization: `Bearer ${token}` };

    expect((await test.request(ME_PATH, { headers: auth })).status).toBe(200);

    const logout = await test.request(LOGOUT_PATH, { method: 'POST', headers: auth });
    expect(logout.status).toBe(200);

    // 修复前：logout 返回 200，但会话没被撤销，/me 依然 200（静默失效）
    expect((await test.request(ME_PATH, { headers: auth })).status).toBe(401);
    expect(test.authRepository.sessions.every((s) => s.revokedAt !== null)).toBe(true);
  });

  it('access token 已过期时登出仍然成功（不能因过期就登不出去）', async () => {
    const test = await boot();
    await login(test);
    const expired = jwt.sign({ sid: '1', role: 'USER' }, test.config.accessTokenSecret, {
      algorithm: 'HS256',
      subject: '1',
      issuer: ACCESS_TOKEN_ISSUER,
      audience: ACCESS_TOKEN_AUDIENCE,
      expiresIn: '-1s',
    });

    const response = await test.request(LOGOUT_PATH, {
      method: 'POST',
      headers: { authorization: `Bearer ${expired}` },
    });
    expect(response.status).toBe(200);
  });

  it('P3-3e 清除 Cookie 的 Path 必须与写入时逐个一致', async () => {
    const test = await boot();
    const cookies = await login(test);
    const logout = await test.request(LOGOUT_PATH, {
      method: 'POST',
      cookie: cookieHeader(cookies),
    });

    const cleared = setCookies(logout);
    const access = cleared.find((c) => c.startsWith('signal_access_token='));
    const refresh = cleared.find((c) => c.startsWith('signal_refresh_token='));

    // 修复前只断言「存在某个带 /api/v1/auth 的清除头」，refresh 那条就足以让断言通过，
    // 于是 access 的 Path 写错也发现不了。
    expect(access).toContain('Path=/;');
    expect(access).toContain('Max-Age=0');
    expect(refresh).toContain('Path=/api/v1/auth');
    expect(refresh).toContain('Max-Age=0');
  });
});

/* ------------------------------------------------------------------ */
/* P3-3a / P3-3b JWT                                                    */
/* ------------------------------------------------------------------ */

describe('P3-3a/b access token 的算法与 iss·aud 锁定有牙齿', () => {
  /**
   * ⚠ 这里必须用**真实存在的会话**（sid 与 sub 都对得上）。
   * 早期版本随便写了 sid='1'，于是 token 校验被绕过时 401 依然会出现
   * —— 只是原因变成了「会话不存在」。那种测试在反证里不会变红（实测确认）。
   * 现在每个用例都配一条「同样载荷、正确算法 → 200」的对照，
   * 因此唯一的差别就只剩被断言的那个校验点。
   */
  async function realClaims(
    test: AuthTestApp,
  ): Promise<{ sub: string; sid: string; cookie: string }> {
    const cookies = await login(test);
    const session = test.authRepository.sessions.at(-1);
    if (session === undefined) throw new Error('登录后应当有会话');
    return { sub: session.userId, sid: session.id, cookie: cookieHeader(cookies) };
  }

  const signWith = (
    test: AuthTestApp,
    claims: { sub: string; sid: string },
    options: jwt.SignOptions = {},
  ): string =>
    jwt.sign({ sid: claims.sid, role: 'USER' }, test.config.accessTokenSecret, {
      algorithm: 'HS256',
      subject: claims.sub,
      issuer: ACCESS_TOKEN_ISSUER,
      audience: ACCESS_TOKEN_AUDIENCE,
      expiresIn: 900,
      ...options,
    });

  it('换成 HS512 签发必须被拒，而同样载荷的 HS256 必须通过（算法锁定）', async () => {
    const test = await boot();
    const claims = await realClaims(test);

    const ok = await test.request(ME_PATH, {
      headers: { authorization: `Bearer ${signWith(test, claims)}` },
    });
    expect(ok.status).toBe(200);

    const hs512 = signWith(test, claims, { algorithm: 'HS512' });
    expect(
      (await test.request(ME_PATH, { headers: { authorization: `Bearer ${hs512}` } })).status,
    ).toBe(401);
  });

  it('issuer 不对必须被拒，正确 issuer 必须通过', async () => {
    const test = await boot();
    const claims = await realClaims(test);

    const wrong = signWith(test, claims, { issuer: 'evil-issuer' });
    expect(
      (await test.request(ME_PATH, { headers: { authorization: `Bearer ${wrong}` } })).status,
    ).toBe(401);

    expect(
      (
        await test.request(ME_PATH, {
          headers: { authorization: `Bearer ${signWith(test, claims)}` },
        })
      ).status,
    ).toBe(200);
  });

  it('audience 不对必须被拒，正确 audience 必须通过', async () => {
    const test = await boot();
    const claims = await realClaims(test);

    const wrong = signWith(test, claims, { audience: 'other-service' });
    expect(
      (await test.request(ME_PATH, { headers: { authorization: `Bearer ${wrong}` } })).status,
    ).toBe(401);

    expect(
      (
        await test.request(ME_PATH, {
          headers: { authorization: `Bearer ${signWith(test, claims)}` },
        })
      ).status,
    ).toBe(200);
  });
});

/* ------------------------------------------------------------------ */
/* P3-3c OTP 哈希绑邮箱                                                 */
/* ------------------------------------------------------------------ */

describe('P3-3c 验证码哈希绑定邮箱（直接断言这条不变量）', () => {
  /**
   * ⚠ 早期版本用「给 A 发的码拿去验 B」来证明绑定，但那条路径 401 的真实原因是
   * 「B 根本没有未消费的码」—— 与哈希是否绑邮箱无关，反证时不会变红（实测确认）。
   * 哈希绑邮箱本身是一个**密码学属性**，就直接断言它。
   */
  it('同一个验证码在不同邮箱下的哈希必须不同（且不等于明文）', () => {
    const service = new OtpService(
      new InMemoryAuthRepository(),
      createTestAuthConfig(),
      new FakeClock(),
      () => TEST_OTP_CODE,
    );

    const alice = service.hashCode('alice@example.com', TEST_OTP_CODE);
    const bob = service.hashCode('bob@example.com', TEST_OTP_CODE);

    // 去掉实现里的 `${email}:` 后这两个值会相等 —— 这条会红。
    expect(alice).not.toBe(bob);
    expect(alice).toMatch(/^[0-9a-f]{64}$/);
    expect(alice).not.toContain(TEST_OTP_CODE);
    expect(service.hashCode('alice@example.com', TEST_OTP_CODE)).toBe(alice);
  });

  it('给某个邮箱发的码只对那个邮箱有效（HTTP 层确认）', async () => {
    const test = await boot({ otpCodes: [TEST_OTP_CODE] });

    await test.request(REQUEST_CODE_PATH, {
      method: 'POST',
      body: JSON.stringify({ email: 'alice@example.com' }),
    });

    const response = await test.request(VERIFY_PATH, {
      method: 'POST',
      body: JSON.stringify({ email: 'bob@example.com', code: TEST_OTP_CODE }),
    });

    expect(response.status).toBe(401);
    expect(await errorCode(response)).toBe(DomainErrorCode.AUTH_OTP_INVALID);
    expect(test.userRepository.users.size).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* P2-5 / P3-3d 并发 refresh                                            */
/* ------------------------------------------------------------------ */

describe('P2-5 并发 refresh：严格轮换的后果必须被测试固定下来', () => {
  it('同一个 refresh token 并发刷新两次 → 恰好一个成功，之后该用户全部会话被撤销', async () => {
    const test = await boot();
    const cookies = await login(test);
    const refreshCookie = cookieHeader(
      cookies.filter((c) => c.startsWith('signal_refresh_token=')),
    );

    const [a, b] = await Promise.all([
      test.request(REFRESH_PATH, { method: 'POST', cookie: refreshCookie }),
      test.request(REFRESH_PATH, { method: 'POST', cookie: refreshCookie }),
    ]);

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 401]);

    const failed = a.status === 401 ? a : b;
    // 失败的一方被判定为「重放已轮换的 token」→ 视为凭据泄露
    expect(await errorCode(failed)).toBe(DomainErrorCode.AUTH_SESSION_REVOKED);
    expect(test.authRepository.sessions.every((s) => s.revokedAt !== null)).toBe(true);
  });

  it('★ 轮换竞态的败者必须撤销全部会话，且绝不能签发新会话（直接模拟竞态）', async () => {
    /**
     * ⚠ 上面那条 HTTP 用例**测不到** `if (!revoked)` 这个判定：
     * 在本地串行化的请求里，第二个请求会先撞上更早的那条
     * 「token 已撤销 → 重放」分支，根本走不到这里。
     * 所以这里直接构造真正的竞态：两个请求都通过了「会话仍有效」的检查，
     * 但条件更新时只有一方能改成功 —— 输的一方必须被当作重放处理。
     */
    const config = createTestAuthConfig();
    const users = new InMemoryUserRepository();
    const user = users.seed({ email: 'race@example.com' });
    const revokedAll: string[] = [];

    const repository = {
      findSessionByRefreshHash: async () => ({
        id: '9',
        userId: user.id,
        expiresAt: new Date(Date.now() + 86_400_000),
        revokedAt: null,
      }),
      // 模拟「另一个请求刚刚把它撤销掉了」：条件更新影响 0 行
      revokeSession: async () => false,
      revokeAllSessionsForUser: async (userId: string) => {
        revokedAll.push(userId);
        return 1;
      },
      // 走到这里就说明败者拿到了新凭据 —— 这正是要防的事
      createSession: async () => {
        throw new Error('竞态败者不得签发新会话');
      },
    } as unknown as AuthRepository;

    const service = new SessionService(
      repository,
      users,
      config,
      new FakeClock(),
      new AccessTokenService(config),
    );

    await expect(
      service.rotate('a-refresh-token', { ip: undefined, userAgent: undefined }),
    ).rejects.toMatchObject({ code: DomainErrorCode.AUTH_SESSION_REVOKED });
    expect(revokedAll).toEqual([user.id]);
  });
});

/* ------------------------------------------------------------------ */
/* P4 会话过期 / refresh 限流主体                                        */
/* ------------------------------------------------------------------ */

describe('P4 会话过期判定与 refresh 限流主体', () => {
  it('会话已过期（未撤销）→ /me 返回 401', async () => {
    const test = await boot();
    const cookies = await login(test);

    // 直接把会话的 expiresAt 改到过去：模拟「30 天到期但没被撤销」
    for (const session of test.authRepository.sessions) {
      session.expiresAt = new Date(Date.now() - 1000);
    }

    const response = await test.request(ME_PATH, { cookie: cookieHeader(cookies) });
    expect(response.status).toBe(401);
    expect(await errorCode(response)).toBe(PlatformErrorCode.UNAUTHORIZED);
  });

  it('refresh 的限流主体是 userId（不是每次都变的 token）', async () => {
    const test = await boot();
    let cookies = await login(test);
    const user = [...test.userRepository.users.values()][0];
    if (user === undefined) throw new Error('没有用户');

    const refreshCalls = (): string[] =>
      test.rateLimiter.calls.map((call) => call.key).filter((key) => key.includes('refresh'));

    await test.request(REFRESH_PATH, {
      method: 'POST',
      cookie: cookieHeader(cookies.filter((c) => c.startsWith('signal_refresh_token='))),
    });
    cookies = await login(test);
    await test.request(REFRESH_PATH, {
      method: 'POST',
      cookie: cookieHeader(cookies.filter((c) => c.startsWith('signal_refresh_token='))),
    });

    const keys = refreshCalls();
    expect(keys.length).toBeGreaterThanOrEqual(2);
    // 用 token 作 key 时，每次轮换都会产生新 key（限额永不触发）—— 这里要求两次相同。
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toContain(rateLimitSubject(user.id));
  });
});

/* ------------------------------------------------------------------ */
/* P2-1 / P2-4 X-Forwarded-For                                          */
/* ------------------------------------------------------------------ */

describe('P2-1/P2-4 伪造 X-Forwarded-For 不得绕过 per-IP 限流', () => {
  it('客户端在前缀里塞的地址不生效，取的是最后一段（代理看到的那一跳）', async () => {
    const test = await boot();

    await test.request(REQUEST_CODE_PATH, {
      method: 'POST',
      body: JSON.stringify({ email: TEST_EMAIL }),
      headers: { 'x-forwarded-for': '1.2.3.4, 9.9.9.9' },
    });

    const ipKeys = test.rateLimiter.calls
      .map((call) => call.key)
      .filter((key) => key.includes('otp:request:ip'));

    expect(ipKeys).toHaveLength(1);
    // 修复前取第一段：这里会是 1.2.3.4 的哈希，攻击者轮换它即可无限发码。
    expect(ipKeys[0]).toContain(rateLimitSubject('9.9.9.9'));
    expect(ipKeys[0]).not.toContain(rateLimitSubject('1.2.3.4'));
  });

  it('每一跳都被轮换（只有最后一段稳定）时，限流计数落在同一个 key 上', async () => {
    const test = await boot();

    for (const spoofed of ['10.0.0.1', '10.0.0.2', '10.0.0.3']) {
      await test.request(REQUEST_CODE_PATH, {
        method: 'POST',
        body: JSON.stringify({ email: `ip-${spoofed}@example.com` }),
        headers: { 'x-forwarded-for': `${spoofed}, 9.9.9.9` },
      });
    }

    const ipKeys = test.rateLimiter.calls
      .map((call) => call.key)
      .filter((key) => key.includes('otp:request:ip'));

    expect(new Set(ipKeys).size).toBe(1);
    expect(ipKeys[0]).toContain(rateLimitSubject('9.9.9.9'));
  });
});

/* ------------------------------------------------------------------ */
/* P3 被禁用用户 / 超大 body                                             */
/* ------------------------------------------------------------------ */

describe('P3 被禁用用户与超大请求体', () => {
  it('被禁用的用户即使验证码正确也不能登录', async () => {
    const test = await boot();
    test.userRepository.seed({ email: TEST_EMAIL, status: UserStatus.DISABLED });

    await test.request(REQUEST_CODE_PATH, {
      method: 'POST',
      body: JSON.stringify({ email: TEST_EMAIL }),
    });
    const response = await test.request(VERIFY_PATH, {
      method: 'POST',
      body: JSON.stringify({ email: TEST_EMAIL, code: TEST_OTP_CODE }),
    });

    expect(response.status).toBe(401);
    expect(await errorCode(response)).toBe(DomainErrorCode.AUTH_ACCOUNT_DISABLED);
    expect(test.authRepository.sessions).toHaveLength(0);
  });

  it('超大请求体 → 413（不是 500），且仍是统一错误封套', async () => {
    const test = await boot();

    const response = await test.request(REQUEST_CODE_PATH, {
      method: 'POST',
      body: JSON.stringify({ email: TEST_EMAIL, padding: 'x'.repeat(300 * 1024) }),
    });

    expect(response.status).toBe(413);
    const body = (await response.json()) as { error: { code: string; requestId: string } };
    expect(body.error.code).toBe(PlatformErrorCode.VALIDATION_FAILED);
    expect(body.error.requestId).toMatch(/^req_/);
  });
});

/* ------------------------------------------------------------------ */
/* P4 输入边界与多字节                                                  */
/* ------------------------------------------------------------------ */

describe('P4 输入边界与多字节形态', () => {
  it('254 字符邮箱可以通过，255 字符被拒（对齐列宽）', async () => {
    const test = await boot();

    const local = (length: number): string => `${'a'.repeat(length)}@example.com`;
    const okEmail = local(254 - '@example.com'.length);
    const tooLong = local(255 - '@example.com'.length);

    expect(
      (
        await test.request(REQUEST_CODE_PATH, {
          method: 'POST',
          body: JSON.stringify({ email: okEmail }),
        })
      ).status,
    ).toBe(200);

    expect(
      (
        await test.request(REQUEST_CODE_PATH, {
          method: 'POST',
          body: JSON.stringify({ email: tooLong }),
        })
      ).status,
    ).toBe(400);
  });

  it('中文 / 多字节 displayName 原样往返（utf8mb4 形态）', async () => {
    const test = await boot();
    test.github.profile = {
      ...test.github.profile,
      name: '张伟·工程师 🚀',
      email: 'zhangwei@example.com',
    };

    const start = await test.request('/api/v1/auth/github');
    const state = new URL(start.headers.get('location') ?? '').searchParams.get('state') ?? '';
    const stateCookie = `signal_oauth_state=${encodeURIComponent(
      cookieValue(setCookies(start), 'signal_oauth_state') ?? '',
    )}`;

    const callback = await test.request(
      `/api/v1/auth/github/callback?code=c&state=${encodeURIComponent(state)}`,
      { cookie: stateCookie },
    );
    expect(callback.status).toBe(302);

    const sessionCookies = setCookies(callback)
      .map((c) => c.split(';')[0]?.trim())
      .filter((pair): pair is string => pair !== undefined && pair.includes('signal_'))
      .join('; ');

    const me = await test.request(ME_PATH, { cookie: sessionCookies });
    const payload = (await me.json()) as { data: { displayName: string } };
    expect(payload.data.displayName).toBe('张伟·工程师 🚀');
  });
});

/* ------------------------------------------------------------------ */
/* P3 生产 ⇒ Secure Cookie 的推导                                       */
/* ------------------------------------------------------------------ */

describe('P3 生产环境必须给会话 Cookie 加 Secure（有测试的推导）', () => {
  it('NODE_ENV=production → secureCookies=true；development → false', () => {
    const production = buildAuthConfig(parseEnv(createTestEnv({ NODE_ENV: 'production' })));
    const development = buildAuthConfig(parseEnv(createTestEnv({ NODE_ENV: 'development' })));

    expect(production.secureCookies).toBe(true);
    expect(development.secureCookies).toBe(false);
  });
});
