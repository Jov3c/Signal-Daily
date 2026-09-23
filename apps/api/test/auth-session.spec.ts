/**
 * Session 生命周期 —— 真实 HTTP 端到端。
 *
 * 覆盖 `docs/11`：Access Token 15min、Refresh Session 30d、
 * 轮换（rotation）、重放响应、登出、禁用用户。
 */

import { afterEach, describe, expect, it } from 'vitest';
import jwt from 'jsonwebtoken';
import { DomainErrorCode, PlatformErrorCode, UserStatus } from '@signal/contracts';
import {
  TEST_EMAIL,
  TEST_OTP_CODE,
  cookieHeader,
  cookieValue,
  setCookies,
  type AuthTestApp,
} from './support/test-app';
import { createAuthTestApp } from './support/test-app';
import {
  ACCESS_TOKEN_AUDIENCE,
  ACCESS_TOKEN_ISSUER,
} from '../src/modules/auth/access-token.service';

const REQUEST_CODE_PATH = '/api/v1/auth/email/request-code';
const VERIFY_PATH = '/api/v1/auth/email/verify';
const REFRESH_PATH = '/api/v1/auth/refresh';
const LOGOUT_PATH = '/api/v1/auth/logout';
const ME_PATH = '/api/v1/me';

let app: AuthTestApp | undefined;

async function boot(): Promise<AuthTestApp> {
  app = await createAuthTestApp();
  return app;
}

afterEach(async () => {
  await app?.close();
  app = undefined;
});

/** 走一遍完整登录，返回 Cookie 列表。 */
async function login(test: AuthTestApp): Promise<string[]> {
  await test.request(REQUEST_CODE_PATH, {
    method: 'POST',
    body: JSON.stringify({ email: TEST_EMAIL }),
  });
  const response = await test.request(VERIFY_PATH, {
    method: 'POST',
    body: JSON.stringify({ email: TEST_EMAIL, code: TEST_OTP_CODE }),
  });
  expect(response.status).toBe(200);
  return setCookies(response);
}

function post(path: string, cookie?: string): Promise<Response> {
  if (app === undefined) throw new Error('app 尚未启动');
  return app.request(path, { method: 'POST', ...(cookie === undefined ? {} : { cookie }) });
}

async function errorCode(response: Response): Promise<string> {
  const payload = (await response.json()) as { error: { code: string } };
  return payload.error.code;
}

/** 只保留需要的 Cookie 拼成 Cookie 头。 */
function only(cookies: string[], ...names: string[]): string {
  return cookieHeader(cookies.filter((c) => names.some((n) => c.startsWith(`${n}=`))));
}

describe('GET /me 的认证要求', () => {
  it('没有 Cookie 也没有 Authorization → 401 UNAUTHORIZED', async () => {
    const test = await boot();
    const response = await test.request(ME_PATH);

    expect(response.status).toBe(401);
    expect(await errorCode(response)).toBe(PlatformErrorCode.UNAUTHORIZED);
  });

  it('Authorization 不是 Bearer 形态 → 401', async () => {
    const test = await boot();
    for (const authorization of ['Bearer', 'Basic abc', 'Token abc', 'Bearer  ']) {
      const response = await test.request(ME_PATH, { headers: { authorization } });
      expect(response.status, authorization).toBe(401);
    }
  });

  it('签名被篡改的 access token → 401', async () => {
    const test = await boot();
    const cookies = await login(test);
    const token = cookieValue(cookies, 'signal_access_token') ?? '';
    const tampered = `${token.slice(0, -3)}xyz`;

    const response = await test.request(ME_PATH, {
      headers: { authorization: `Bearer ${tampered}` },
    });
    expect(response.status).toBe(401);
  });

  it('用别的密钥签发的 access token → 401（不被信任的签发方）', async () => {
    const test = await boot();
    const forged = jwt.sign({ sid: '1', role: 'ADMIN' }, 'another-secret', {
      algorithm: 'HS256',
      subject: '1',
      issuer: ACCESS_TOKEN_ISSUER,
      audience: ACCESS_TOKEN_AUDIENCE,
      expiresIn: 900,
    });

    const response = await test.request(ME_PATH, {
      headers: { authorization: `Bearer ${forged}` },
    });
    expect(response.status).toBe(401);
  });

  it('alg=none 的 token → 401（算法混淆）', async () => {
    const test = await boot();
    const encode = (value: unknown): string =>
      Buffer.from(JSON.stringify(value)).toString('base64url');
    const noneToken = `${encode({ alg: 'none', typ: 'JWT' })}.${encode({
      sub: '1',
      sid: '1',
      role: 'ADMIN',
      iss: ACCESS_TOKEN_ISSUER,
      aud: ACCESS_TOKEN_AUDIENCE,
      exp: Math.floor(Date.now() / 1000) + 900,
    })}.`;

    const response = await test.request(ME_PATH, {
      headers: { authorization: `Bearer ${noneToken}` },
    });
    expect(response.status).toBe(401);
  });

  it('已过期的 access token → 401', async () => {
    const test = await boot();
    const expired = jwt.sign({ sid: '1', role: 'USER' }, test.config.accessTokenSecret, {
      algorithm: 'HS256',
      subject: '1',
      issuer: ACCESS_TOKEN_ISSUER,
      audience: ACCESS_TOKEN_AUDIENCE,
      expiresIn: '-1s',
    });

    const response = await test.request(ME_PATH, {
      headers: { authorization: `Bearer ${expired}` },
    });
    expect(response.status).toBe(401);
  });

  it('载荷里 sid 缺失 / role 非法 → 401（token 是外部输入）', async () => {
    const test = await boot();
    const sign = (payload: Record<string, unknown>, subject = '1'): string =>
      jwt.sign(payload, test.config.accessTokenSecret, {
        algorithm: 'HS256',
        subject,
        issuer: ACCESS_TOKEN_ISSUER,
        audience: ACCESS_TOKEN_AUDIENCE,
        expiresIn: 900,
      });

    const cases: [Record<string, unknown>, string][] = [
      [{ role: 'USER' }, '1'], // 缺 sid
      [{ sid: '', role: 'USER' }, '1'], // 空 sid
      [{ sid: '1', role: 'SUPERADMIN' }, '1'], // 契约外的角色
      [{ sid: '1' }, '1'], // 缺 role
      [{ sid: '1', role: 'ADMIN' }, 'not-a-number'], // sub 不是 BIGINT
    ];

    for (const [payload, subject] of cases) {
      const response = await test.request(ME_PATH, {
        headers: { authorization: `Bearer ${sign(payload, subject)}` },
      });
      expect(response.status, `${JSON.stringify(payload)} sub=${subject}`).toBe(401);
    }
  });
});

describe('POST /auth/refresh（轮换）', () => {
  it('用 refresh Cookie 换到新的一套凭据', async () => {
    const test = await boot();
    const cookies = await login(test);

    const response = await post(REFRESH_PATH, only(cookies, 'signal_refresh_token'));
    expect(response.status).toBe(200);

    const payload = (await response.json()) as {
      data: { user: { email: string }; accessTokenExpiresInSeconds: number };
    };
    expect(payload.data.user.email).toBe(TEST_EMAIL);
    expect(payload.data.accessTokenExpiresInSeconds).toBe(900);

    const rotated = setCookies(response);
    expect(cookieValue(rotated, 'signal_access_token')).not.toBe(
      cookieValue(cookies, 'signal_access_token'),
    );
    expect(cookieValue(rotated, 'signal_refresh_token')).not.toBe(
      cookieValue(cookies, 'signal_refresh_token'),
    );
    expect(test.authRepository.sessions).toHaveLength(2);
  });

  it('轮换后旧 refresh token 视为重放：401 AUTH_SESSION_REVOKED，并撤销该用户全部会话', async () => {
    const test = await boot();
    const cookies = await login(test);
    const oldRefresh = cookieValue(cookies, 'signal_refresh_token') ?? '';

    const rotated = await post(REFRESH_PATH, only(cookies, 'signal_refresh_token'));
    expect(rotated.status).toBe(200);
    const newCookies = setCookies(rotated);

    // 重放旧的 refresh token
    const replay = await post(
      REFRESH_PATH,
      `signal_refresh_token=${encodeURIComponent(oldRefresh)}`,
    );
    expect(replay.status).toBe(401);
    expect(await errorCode(replay)).toBe(DomainErrorCode.AUTH_SESSION_REVOKED);

    // 连刚换出来的新会话也一起被撤销了（凭据泄露的响应）
    const afterReplay = await test.request(ME_PATH, { cookie: cookieHeader(newCookies) });
    expect(afterReplay.status).toBe(401);
    expect(test.authRepository.sessions.every((s) => s.revokedAt !== null)).toBe(true);
  });

  it('未知 / 缺失 / 非法 refresh token → 401 AUTH_SESSION_INVALID', async () => {
    await boot();

    for (const cookie of [
      undefined,
      'signal_refresh_token=',
      'signal_refresh_token=not-a-real-token',
      'other_cookie=1',
    ]) {
      const response = await post(REFRESH_PATH, cookie);
      expect(response.status, String(cookie)).toBe(401);
      expect(await errorCode(response)).toBe(DomainErrorCode.AUTH_SESSION_INVALID);
    }
  });

  it('超过 30 天的 refresh token → 401 AUTH_SESSION_INVALID', async () => {
    const test = await boot();
    const cookies = await login(test);

    test.clock.advanceSeconds(30 * 24 * 60 * 60 + 1);

    const response = await post(REFRESH_PATH, only(cookies, 'signal_refresh_token'));
    expect(response.status).toBe(401);
    expect(await errorCode(response)).toBe(DomainErrorCode.AUTH_SESSION_INVALID);
  });

  it('被禁用的用户在 refresh 时被拒绝，且会话全部撤销', async () => {
    const test = await boot();
    const cookies = await login(test);
    const user = [...test.userRepository.users.values()][0];
    if (user === undefined) throw new Error('没有用户');
    user.status = UserStatus.DISABLED;

    const response = await post(REFRESH_PATH, only(cookies, 'signal_refresh_token'));
    expect(response.status).toBe(401);
    expect(await errorCode(response)).toBe(DomainErrorCode.AUTH_ACCOUNT_DISABLED);
    expect(test.authRepository.sessions.every((s) => s.revokedAt !== null)).toBe(true);
  });
});

describe('POST /auth/logout', () => {
  it('撤销会话、清 Cookie，且**立刻**失去访问权限', async () => {
    const test = await boot();
    const cookies = await login(test);

    expect((await test.request(ME_PATH, { cookie: cookieHeader(cookies) })).status).toBe(200);

    const response = await post(LOGOUT_PATH, cookieHeader(cookies));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: { loggedOut: true } });

    const cleared = setCookies(response);
    expect(cleared.some((c) => c.startsWith('signal_access_token=;'))).toBe(true);
    expect(cleared.some((c) => c.startsWith('signal_refresh_token=;'))).toBe(true);
    expect(cleared.every((c) => c.includes('Max-Age=0'))).toBe(true);
    // 清除时必须使用与写入相同的 Path，否则浏览器会留下同名残留
    expect(cleared.some((c) => c.includes('Path=/api/v1/auth'))).toBe(true);

    // 关键：access token 还没过期，但会话已撤销 —— 必须立刻 401
    const afterLogout = await test.request(ME_PATH, { cookie: cookieHeader(cookies) });
    expect(afterLogout.status).toBe(401);
  });

  it('幂等：重复登出、无 Cookie 登出都返回 200', async () => {
    const test = await boot();
    const cookies = await login(test);

    expect((await post(LOGOUT_PATH, cookieHeader(cookies))).status).toBe(200);
    expect((await post(LOGOUT_PATH, cookieHeader(cookies))).status).toBe(200);
    expect((await post(LOGOUT_PATH)).status).toBe(200);
  });

  it('登出后原 refresh token 也不能再用', async () => {
    const test = await boot();
    const cookies = await login(test);

    await post(LOGOUT_PATH, cookieHeader(cookies));
    const response = await post(REFRESH_PATH, only(cookies, 'signal_refresh_token'));

    expect(response.status).toBe(401);
    expect(await errorCode(response)).toBe(DomainErrorCode.AUTH_SESSION_REVOKED);
  });
});

describe('禁用用户即时生效', () => {
  it('会话仍有效但用户被禁用 → /me 返回 401 AUTH_ACCOUNT_DISABLED', async () => {
    const test = await boot();
    const cookies = await login(test);

    const user = [...test.userRepository.users.values()][0];
    if (user === undefined) throw new Error('没有用户');
    user.status = UserStatus.DISABLED;

    const response = await test.request(ME_PATH, { cookie: cookieHeader(cookies) });
    expect(response.status).toBe(401);
    expect(await errorCode(response)).toBe(DomainErrorCode.AUTH_ACCOUNT_DISABLED);
  });
});
