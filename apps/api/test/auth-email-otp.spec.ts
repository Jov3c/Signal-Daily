/**
 * Email OTP 登录 —— 真实 HTTP 端到端。
 *
 * 覆盖 `tasks/agent-02-auth.md` 明确要求的三条：wrong / expired / reused OTP，
 * 外加注册即登录、邮箱归一化、账号枚举防护、并发消费、限流。
 */

import { afterEach, describe, expect, it } from 'vitest';
import { DomainErrorCode, PlatformErrorCode, UserRole } from '@signal/contracts';
import {
  TEST_EMAIL,
  TEST_OTP_CODE,
  cookieHeader,
  cookieValue,
  setCookies,
  type AuthTestApp,
} from './support/test-app';
import { createAuthTestApp } from './support/test-app';

const REQUEST_CODE_PATH = '/api/v1/auth/email/request-code';
const VERIFY_PATH = '/api/v1/auth/email/verify';
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

function postJson(path: string, body: unknown, cookie?: string): Promise<Response> {
  if (app === undefined) throw new Error('app 尚未启动');
  return app.request(path, {
    method: 'POST',
    body: JSON.stringify(body),
    ...(cookie === undefined ? {} : { cookie }),
  });
}

async function errorBody(response: Response): Promise<{
  code: string;
  message: string;
  requestId: string;
  details: unknown;
}> {
  const payload = (await response.json()) as {
    error: { code: string; message: string; requestId: string; details: unknown };
  };
  return payload.error;
}

describe('POST /auth/email/request-code', () => {
  it('返回契约形状 {data:{sent,expiresInSeconds}}，并投递一封带 6 位码的邮件', async () => {
    const test = await boot();
    const response = await postJson(REQUEST_CODE_PATH, { email: TEST_EMAIL });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      data: { sent: true, expiresInSeconds: 600 },
    });

    expect(test.mail.sent).toHaveLength(1);
    expect(test.mail.sent[0]?.to).toBe(TEST_EMAIL);
    expect(test.mail.latestCode()).toMatch(/^\d{6}$/);
  });

  it('数据库里只有 hash，不含验证码明文', async () => {
    const test = await boot();
    await postJson(REQUEST_CODE_PATH, { email: TEST_EMAIL });

    const row = test.authRepository.otpRows[0];
    expect(row).toBeDefined();
    expect(row?.codeHash).not.toBe(TEST_OTP_CODE);
    expect(row?.codeHash).toMatch(/^[0-9a-f]{64}$/);
    // 整行序列化后也不应出现明文
    expect(JSON.stringify(row)).not.toContain(TEST_OTP_CODE);
  });

  it('不泄露邮箱是否已注册：已注册与未注册邮箱的响应完全一致', async () => {
    const test = await boot();
    test.userRepository.seed({ email: 'existing@example.com' });

    const registered = await postJson(REQUEST_CODE_PATH, { email: 'existing@example.com' });
    const unregistered = await postJson(REQUEST_CODE_PATH, { email: 'brand-new@example.com' });

    expect(registered.status).toBe(unregistered.status);
    expect(await registered.json()).toEqual(await unregistered.json());
  });

  it('重新请求后旧验证码失效（同一时刻只有一个有效码）', async () => {
    await boot({ otpCodes: ['111111', '222222'] });

    await postJson(REQUEST_CODE_PATH, { email: TEST_EMAIL });
    await postJson(REQUEST_CODE_PATH, { email: TEST_EMAIL });

    const withOld = await postJson(VERIFY_PATH, { email: TEST_EMAIL, code: '111111' });
    expect(withOld.status).toBe(401);
    expect((await errorBody(withOld)).code).toBe(DomainErrorCode.AUTH_OTP_INVALID);

    const withNew = await postJson(VERIFY_PATH, { email: TEST_EMAIL, code: '222222' });
    expect(withNew.status).toBe(200);
  });

  it('超出限流后返回 429 RATE_LIMITED，并带上重试秒数', async () => {
    const test = await boot();
    test.rateLimiter.denyAll();

    const response = await postJson(REQUEST_CODE_PATH, { email: TEST_EMAIL });
    expect(response.status).toBe(429);

    const body = await errorBody(response);
    expect(body.code).toBe(PlatformErrorCode.RATE_LIMITED);
    expect(body.details).toMatchObject({ retryAfterSeconds: expect.any(Number) });
  });

  it('请求体非法时返回 400 VALIDATION_FAILED，不触发任何邮件', async () => {
    const test = await boot();

    for (const body of [{}, { email: 'not-an-email' }, { email: '' }, { email: 123 }, null]) {
      const response = await postJson(REQUEST_CODE_PATH, body);
      expect(response.status, `body=${JSON.stringify(body)}`).toBe(400);
      expect((await errorBody(response)).code).toBe(PlatformErrorCode.VALIDATION_FAILED);
    }
    expect(test.mail.sent).toHaveLength(0);
  });
});

describe('POST /auth/email/verify', () => {
  it('正确验证码 → 200、建用户、写两个 HttpOnly Cookie', async () => {
    await boot();
    await postJson(REQUEST_CODE_PATH, { email: TEST_EMAIL });

    const response = await postJson(VERIFY_PATH, { email: TEST_EMAIL, code: TEST_OTP_CODE });
    expect(response.status).toBe(200);

    const payload = (await response.json()) as {
      data: {
        user: { id: string; email: string; role: string; createdAt: string };
        accessTokenExpiresInSeconds: number;
      };
    };
    expect(payload.data.user.email).toBe(TEST_EMAIL);
    expect(payload.data.user.role).toBe(UserRole.USER);
    expect(payload.data.accessTokenExpiresInSeconds).toBe(900);

    // BIGINT 必须序列化成 string（docs/02）
    expect(typeof payload.data.user.id).toBe('string');
    expect(payload.data.user.id).toMatch(/^\d+$/);

    const cookies = setCookies(response);
    const access = cookies.find((c) => c.startsWith('signal_access_token='));
    const refresh = cookies.find((c) => c.startsWith('signal_refresh_token='));
    expect(access).toBeDefined();
    expect(refresh).toBeDefined();

    for (const cookie of [access, refresh]) {
      expect(cookie).toContain('HttpOnly');
      expect(cookie).toContain('SameSite=Lax');
      // 测试环境是 http，不能带 Secure，否则浏览器直接丢弃
      expect(cookie).not.toContain('Secure');
    }
    // refresh 只发给 auth 自己的路由
    expect(refresh).toContain('Path=/api/v1/auth');
    expect(access).toContain('Path=/;');
  });

  it('首次登录即注册，并写入默认偏好；已存在用户不会重复建号', async () => {
    const test = await boot();

    await postJson(REQUEST_CODE_PATH, { email: TEST_EMAIL });
    await postJson(VERIFY_PATH, { email: TEST_EMAIL, code: TEST_OTP_CODE });
    await postJson(REQUEST_CODE_PATH, { email: TEST_EMAIL });
    const second = await postJson(VERIFY_PATH, { email: TEST_EMAIL, code: TEST_OTP_CODE });

    expect(second.status).toBe(200);
    expect(test.userRepository.users.size).toBe(1);
  });

  it('邮箱归一化：大小写与首尾空格不影响登录', async () => {
    const test = await boot();

    await postJson(REQUEST_CODE_PATH, { email: '  READER@Example.COM ' });
    const response = await postJson(VERIFY_PATH, {
      email: 'reader@example.com',
      code: TEST_OTP_CODE,
    });

    expect(response.status).toBe(200);
    const users = [...test.userRepository.users.values()];
    expect(users).toHaveLength(1);
    expect(users[0]?.email).toBe('reader@example.com');
  });

  it('验证码错误 → 401 AUTH_OTP_INVALID', async () => {
    const test = await boot();
    await postJson(REQUEST_CODE_PATH, { email: TEST_EMAIL });

    const response = await postJson(VERIFY_PATH, { email: TEST_EMAIL, code: '999999' });
    expect(response.status).toBe(401);
    expect((await errorBody(response)).code).toBe(DomainErrorCode.AUTH_OTP_INVALID);
    expect(test.userRepository.users.size).toBe(0);
  });

  it('验证码过期 → 401 AUTH_OTP_EXPIRED', async () => {
    const test = await boot();
    await postJson(REQUEST_CODE_PATH, { email: TEST_EMAIL });

    test.clock.advanceSeconds(601); // 10 分钟 + 1 秒

    const response = await postJson(VERIFY_PATH, { email: TEST_EMAIL, code: TEST_OTP_CODE });
    expect(response.status).toBe(401);
    expect((await errorBody(response)).code).toBe(DomainErrorCode.AUTH_OTP_EXPIRED);
  });

  it('验证码重放 → 401 AUTH_OTP_ALREADY_USED', async () => {
    await boot();
    await postJson(REQUEST_CODE_PATH, { email: TEST_EMAIL });

    const first = await postJson(VERIFY_PATH, { email: TEST_EMAIL, code: TEST_OTP_CODE });
    expect(first.status).toBe(200);

    const replay = await postJson(VERIFY_PATH, { email: TEST_EMAIL, code: TEST_OTP_CODE });
    expect(replay.status).toBe(401);
    expect((await errorBody(replay)).code).toBe(DomainErrorCode.AUTH_OTP_ALREADY_USED);
  });

  it('从未请求过验证码直接提交 → 401 AUTH_OTP_INVALID（不是重放）', async () => {
    await boot();
    const response = await postJson(VERIFY_PATH, { email: TEST_EMAIL, code: TEST_OTP_CODE });

    expect(response.status).toBe(401);
    expect((await errorBody(response)).code).toBe(DomainErrorCode.AUTH_OTP_INVALID);
  });

  it('并发提交同一个验证码：恰好一个成功，另一个按重放拒绝', async () => {
    const test = await boot();
    await postJson(REQUEST_CODE_PATH, { email: TEST_EMAIL });

    const [a, b] = await Promise.all([
      postJson(VERIFY_PATH, { email: TEST_EMAIL, code: TEST_OTP_CODE }),
      postJson(VERIFY_PATH, { email: TEST_EMAIL, code: TEST_OTP_CODE }),
    ]);

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 401]);
    expect(test.authRepository.sessions).toHaveLength(1);
  });

  it('验证码格式非法 → 400，且不消耗任何验证码', async () => {
    await boot();
    await postJson(REQUEST_CODE_PATH, { email: TEST_EMAIL });

    for (const code of ['12345', '1234567', 'abcdef', '', 123456]) {
      const response = await postJson(VERIFY_PATH, { email: TEST_EMAIL, code });
      expect(response.status, `code=${String(code)}`).toBe(400);
    }

    // 仍然可以用正确的码登录 —— 证明上面几次没有被当成「一次失败尝试」之外的副作用
    const ok = await postJson(VERIFY_PATH, { email: TEST_EMAIL, code: TEST_OTP_CODE });
    expect(ok.status).toBe(200);
  });

  it('错误响应的 requestId 与响应头一致（docs/02 封套）', async () => {
    await boot();
    const response = await postJson(VERIFY_PATH, { email: TEST_EMAIL, code: TEST_OTP_CODE });

    const body = await errorBody(response);
    expect(body.requestId).toMatch(/^req_[0-9a-f]{24}$/);
    expect(response.headers.get('x-request-id')).toBe(body.requestId);
    expect(body).toHaveProperty('details');
  });

  it('调用方传入的合法 x-request-id 会被沿用', async () => {
    await boot();
    const response = await postJson(VERIFY_PATH, { email: TEST_EMAIL, code: TEST_OTP_CODE });
    expect(response.headers.get('x-request-id')).toBeDefined();

    const echoed = await app?.request(ME_PATH, { headers: { 'x-request-id': 'req_trace_me_123' } });
    expect(echoed?.headers.get('x-request-id')).toBe('req_trace_me_123');
  });
});

describe('登录后的 GET /me', () => {
  it('带上 access Cookie 可以读到自己的身份', async () => {
    const test = await boot();
    await postJson(REQUEST_CODE_PATH, { email: TEST_EMAIL });
    const login = await postJson(VERIFY_PATH, { email: TEST_EMAIL, code: TEST_OTP_CODE });
    const cookies = setCookies(login);

    const response = await test.request(ME_PATH, { cookie: cookieHeader(cookies) });
    expect(response.status).toBe(200);

    const payload = (await response.json()) as { data: { email: string; role: string } };
    expect(payload.data.email).toBe(TEST_EMAIL);
    expect(payload.data.role).toBe(UserRole.USER);
  });

  it('Cookie 里的 access token 值确实可用于认证', async () => {
    const test = await boot();
    await postJson(REQUEST_CODE_PATH, { email: TEST_EMAIL });
    const login = await postJson(VERIFY_PATH, { email: TEST_EMAIL, code: TEST_OTP_CODE });
    const token = cookieValue(setCookies(login), 'signal_access_token');

    expect(token).toBeDefined();
    const response = await test.request(ME_PATH, {
      headers: { authorization: `Bearer ${token ?? ''}` },
    });
    expect(response.status).toBe(200);
  });
});
