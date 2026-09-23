/**
 * GitHub OAuth —— 真实 HTTP 端到端。
 *
 * 重点覆盖 `docs/14` 要求的 state 校验（验收项 24「OAuth state mismatch 拒绝」），
 * 以及账号绑定 / 复用的幂等性。
 */

import { afterEach, describe, expect, it } from 'vitest';
import { DomainErrorCode, PlatformErrorCode } from '@signal/contracts';
import { cookieValue, setCookies, type AuthTestApp } from './support/test-app';
import { createAuthTestApp } from './support/test-app';

const START_PATH = '/api/v1/auth/github';
const CALLBACK_PATH = '/api/v1/auth/github/callback';

let app: AuthTestApp | undefined;

async function boot(options: Parameters<typeof createAuthTestApp>[0] = {}): Promise<AuthTestApp> {
  app = await createAuthTestApp(options);
  return app;
}

afterEach(async () => {
  await app?.close();
  app = undefined;
});

/** 走一遍「点登录」：拿到 state 与它对应的 Cookie。 */
async function startLogin(
  test: AuthTestApp,
): Promise<{ state: string; cookie: string; location: string }> {
  const response = await test.request(START_PATH);
  expect(response.status).toBe(302);

  const location = response.headers.get('location') ?? '';
  const state = new URL(location).searchParams.get('state') ?? '';
  const stateCookie = cookieValue(setCookies(response), 'signal_oauth_state') ?? '';

  return { state, cookie: `signal_oauth_state=${encodeURIComponent(stateCookie)}`, location };
}

function callback(query: string, cookie?: string): Promise<Response> {
  if (app === undefined) throw new Error('app 尚未启动');
  return app.request(`${CALLBACK_PATH}?${query}`, cookie === undefined ? {} : { cookie });
}

async function errorCode(response: Response): Promise<string> {
  const payload = (await response.json()) as { error: { code: string } };
  return payload.error.code;
}

describe('GET /auth/github', () => {
  it('302 到 GitHub 授权页，并写入 HttpOnly 的 state Cookie', async () => {
    const test = await boot();
    const response = await test.request(START_PATH);

    expect(response.status).toBe(302);
    const location = response.headers.get('location') ?? '';
    expect(location.startsWith('https://github.com/login/oauth/authorize?')).toBe(true);

    const url = new URL(location);
    expect(url.searchParams.get('client_id')).toBe('test-client');
    expect(url.searchParams.get('state')).toBeTruthy();
    expect(url.host).toBe('github.com');

    const stateCookie = setCookies(response).find((c) => c.startsWith('signal_oauth_state='));
    expect(stateCookie).toBeDefined();
    expect(stateCookie).toContain('HttpOnly');
    expect(stateCookie).toContain('SameSite=Lax');
    expect(stateCookie).toContain('Path=/api/v1/auth');
  });

  it('每次发起都产生不同的 state（不可预测、不可复用）', async () => {
    const test = await boot();
    const first = await startLogin(test);
    const second = await startLogin(test);

    expect(first.state).not.toBe(second.state);
  });

  it('未配置 GitHub 时返回 503 AUTH_GITHUB_NOT_CONFIGURED（走真实客户端）', async () => {
    // 这里刻意用**真实的** FetchGithubClient：未配置时它在构造授权地址就抛错，
    // 不联网，因此可以端到端验证真实的错误码与状态码。
    const test = await boot({ config: { github: null }, realGithubClient: true });
    const response = await test.request(START_PATH);

    expect(response.status).toBe(503);
    expect(await errorCode(response)).toBe(DomainErrorCode.AUTH_GITHUB_NOT_CONFIGURED);
  });
});

describe('GET /auth/github/callback —— state 校验', () => {
  it('state 与 Cookie 一致 → 302 回站点、写入会话 Cookie、建用户并绑定账号', async () => {
    const test = await boot();
    const { state, cookie } = await startLogin(test);

    const response = await callback(`code=valid-code&state=${encodeURIComponent(state)}`, cookie);

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('http://localhost:3000');

    const cookies = setCookies(response);
    expect(cookieValue(cookies, 'signal_access_token')).toBeTruthy();
    expect(cookieValue(cookies, 'signal_refresh_token')).toBeTruthy();
    // state Cookie 必须被清掉，不能复用
    expect(
      cookies.some((c) => c.startsWith('signal_oauth_state=;') && c.includes('Max-Age=0')),
    ).toBe(true);

    expect(test.github.exchangedCodes).toEqual(['valid-code']);
    expect(test.userRepository.users.size).toBe(1);
    expect(test.authRepository.accounts).toHaveLength(1);
    expect(test.authRepository.accounts[0]?.provider).toBe('github');
    expect(test.authRepository.accounts[0]?.providerAccountId).toBe('42');
  });

  it('Cookie 里的 state 与 query 不一致 → 401 AUTH_OAUTH_STATE_INVALID', async () => {
    const test = await boot();
    const first = await startLogin(test);
    const second = await startLogin(test);

    // 用第二次的 state 配第一次的 Cookie —— 典型的登录 CSRF
    const response = await callback(
      `code=attacker-code&state=${encodeURIComponent(second.state)}`,
      first.cookie,
    );

    expect(response.status).toBe(401);
    expect(await errorCode(response)).toBe(DomainErrorCode.AUTH_OAUTH_STATE_INVALID);
    expect(test.github.exchangedCodes).toHaveLength(0);
    expect(test.userRepository.users.size).toBe(0);
  });

  it('完全不带 state Cookie → 401', async () => {
    const test = await boot();
    const { state } = await startLogin(test);

    const response = await callback(`code=x&state=${encodeURIComponent(state)}`);
    expect(response.status).toBe(401);
    expect(await errorCode(response)).toBe(DomainErrorCode.AUTH_OAUTH_STATE_INVALID);
  });

  it('签名被篡改的 state → 401', async () => {
    const test = await boot();
    const { state } = await startLogin(test);

    for (const tampered of [`${state}x`, state.replace(/\.[^.]*$/, '.AAAA'), 'a.b.c', 'nonsense']) {
      const response = await callback(
        `code=x&state=${encodeURIComponent(tampered)}`,
        `signal_oauth_state=${encodeURIComponent(tampered)}`,
      );
      // 前两种是「签名不匹配」，后两种是「结构不合法」，都应被拒
      expect(response.status, tampered).toBe(401);
    }
  });

  it('超过 10 分钟的 state → 401（过期）', async () => {
    const test = await boot();
    const { state, cookie } = await startLogin(test);

    test.clock.advanceSeconds(10 * 60 + 61);

    const response = await callback(`code=x&state=${encodeURIComponent(state)}`, cookie);
    expect(response.status).toBe(401);
    expect(await errorCode(response)).toBe(DomainErrorCode.AUTH_OAUTH_STATE_INVALID);
  });

  it('出现多个同名 state Cookie → 401（防 Cookie 覆盖）', async () => {
    const test = await boot();
    const { state, cookie } = await startLogin(test);

    const duplicated = `${cookie}; ${cookie}`;
    const response = await callback(`code=x&state=${encodeURIComponent(state)}`, duplicated);

    expect(response.status).toBe(401);
    expect(await errorCode(response)).toBe(DomainErrorCode.AUTH_OAUTH_STATE_INVALID);
  });

  it('query 缺少 code / state → 400 VALIDATION_FAILED', async () => {
    const test = await boot();
    const { state, cookie } = await startLogin(test);

    for (const query of ['', 'code=only-code', `state=${encodeURIComponent(state)}`]) {
      const response = await callback(query, cookie);
      expect(response.status, query).toBe(400);
      expect(await errorCode(response)).toBe(PlatformErrorCode.VALIDATION_FAILED);
    }
  });

  it('用户在 GitHub 点取消（error=access_denied）→ 302 回站点，不建用户', async () => {
    const test = await boot();
    const { cookie } = await startLogin(test);

    const response = await callback('error=access_denied&error_description=denied', cookie);

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('http://localhost:3000');
    expect(test.userRepository.users.size).toBe(0);
  });

  it('换取 access token 失败 → 502 AUTH_OAUTH_EXCHANGE_FAILED', async () => {
    const test = await boot();
    const { state, cookie } = await startLogin(test);
    test.github.failExchange = true;

    const response = await callback(`code=x&state=${encodeURIComponent(state)}`, cookie);
    expect(response.status).toBe(502);
    expect(await errorCode(response)).toBe(DomainErrorCode.AUTH_OAUTH_EXCHANGE_FAILED);
  });
});

describe('GitHub 账号绑定', () => {
  it('同一 GitHub 账号二次登录复用已有用户，不重复建号', async () => {
    const test = await boot();

    const first = await startLogin(test);
    await callback(`code=c1&state=${encodeURIComponent(first.state)}`, first.cookie);
    const second = await startLogin(test);
    const response = await callback(
      `code=c2&state=${encodeURIComponent(second.state)}`,
      second.cookie,
    );

    expect(response.status).toBe(302);
    expect(test.userRepository.users.size).toBe(1);
    expect(test.authRepository.accounts).toHaveLength(1);
    expect(test.authRepository.sessions).toHaveLength(2);
  });

  it('GitHub 邮箱与既有 Email 用户相同 → 绑定到同一用户，而不是新建', async () => {
    const test = await boot();
    const existing = test.userRepository.seed({ email: 'octocat@example.com' });

    const { state, cookie } = await startLogin(test);
    await callback(`code=c&state=${encodeURIComponent(state)}`, cookie);

    expect(test.userRepository.users.size).toBe(1);
    expect(test.authRepository.accounts[0]?.userId).toBe(existing.id);
  });

  it('GitHub 未提供已验证邮箱 → 建出 email 为 null 的用户', async () => {
    const test = await boot();
    test.github.profile = { ...test.github.profile, email: null };

    const { state, cookie } = await startLogin(test);
    const response = await callback(`code=c&state=${encodeURIComponent(state)}`, cookie);

    expect(response.status).toBe(302);
    const users = [...test.userRepository.users.values()];
    expect(users).toHaveLength(1);
    expect(users[0]?.email).toBeNull();
    expect(users[0]?.displayName).toBe('Mona Lisa');
  });

  it('OAuth 登录后可以立刻访问 /me', async () => {
    const test = await boot();
    const { state, cookie } = await startLogin(test);
    const callbackResponse = await callback(`code=c&state=${encodeURIComponent(state)}`, cookie);
    const sessionCookies = setCookies(callbackResponse)
      .map((c) => c.split(';')[0]?.trim())
      .filter((pair): pair is string => pair !== undefined && pair.includes('signal_'))
      .join('; ');

    const me = await test.request('/api/v1/me', { cookie: sessionCookies });
    expect(me.status).toBe(200);
    const payload = (await me.json()) as { data: { email: string } };
    expect(payload.data.email).toBe('octocat@example.com');
  });
});
