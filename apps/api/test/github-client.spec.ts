/**
 * **真实** `FetchGithubClient` 的单元测试。
 *
 * 为什么单独写一个文件：HTTP 端到端用例里 GitHub 客户端是替身，
 * 它永远不会暴露真实客户端的缺陷（URL 拼错、只看状态码不看 body、
 * 把 token 写进错误信息……）。这里 stub 掉 `globalThis.fetch`，
 * 直接验证生产代码本身。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppError, DomainErrorCode } from '@signal/contracts';
import { FetchGithubClient } from '../src/modules/auth/github.client';
import { createTestAuthConfig } from './support/fakes';

type RecordedCall = { url: string; init: RequestInit };

function stubFetch(responses: { status?: number; body: unknown }[]): RecordedCall[] {
  const calls: RecordedCall[] = [];
  let index = 0;

  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    const next = responses[Math.min(index++, responses.length - 1)] ?? { body: {} };
    return new Response(JSON.stringify(next.body), {
      status: next.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  });

  return calls;
}

function client(config: Parameters<typeof createTestAuthConfig>[0] = {}): FetchGithubClient {
  return new FetchGithubClient(
    createTestAuthConfig({
      github: {
        clientId: 'cid',
        clientSecret: 'csecret',
        callbackUrl: 'https://signal.example.com/api/v1/auth/github/callback',
      },
      ...config,
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('buildAuthorizeUrl', () => {
  it('指向 GitHub 授权端点，只申请身份与邮箱，并带上 state 与回调地址', () => {
    const url = new URL(client().buildAuthorizeUrl('state-value'));

    expect(url.origin + url.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(url.searchParams.get('client_id')).toBe('cid');
    expect(url.searchParams.get('redirect_uri')).toBe(
      'https://signal.example.com/api/v1/auth/github/callback',
    );
    expect(url.searchParams.get('scope')).toBe('read:user user:email');
    expect(url.searchParams.get('state')).toBe('state-value');
  });

  it('未配置 clientId/clientSecret 时抛 503 AUTH_GITHUB_NOT_CONFIGURED', () => {
    const unconfigured = new FetchGithubClient(createTestAuthConfig({ github: null }));

    try {
      unconfigured.buildAuthorizeUrl('s');
      expect.unreachable('应当抛错');
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe(DomainErrorCode.AUTH_GITHUB_NOT_CONFIGURED);
      expect((error as AppError).httpStatus).toBe(503);
    }
  });
});

describe('exchangeCodeForToken', () => {
  it('用表单 POST 换取 access token', async () => {
    const calls = stubFetch([{ body: { access_token: 'gho_token' } }]);
    const token = await client().exchangeCodeForToken('the-code');

    expect(token).toBe('gho_token');
    expect(calls[0]?.url).toBe('https://github.com/login/oauth/access_token');
    expect(calls[0]?.init.method).toBe('POST');

    const body = String(calls[0]?.init.body);
    expect(body).toContain('client_id=cid');
    expect(body).toContain('client_secret=csecret');
    expect(body).toContain('code=the-code');
  });

  it('⚠ GitHub 用 HTTP 200 + body.error 表示失败时必须抛错，而不是当成成功', async () => {
    stubFetch([{ status: 200, body: { error: 'bad_verification_code' } }]);

    await expect(client().exchangeCodeForToken('stale')).rejects.toMatchObject({
      code: DomainErrorCode.AUTH_OAUTH_EXCHANGE_FAILED,
    });
  });

  it('token 为空字符串同样视为失败', async () => {
    stubFetch([{ status: 200, body: { access_token: '' } }]);
    await expect(client().exchangeCodeForToken('c')).rejects.toMatchObject({
      code: DomainErrorCode.AUTH_OAUTH_EXCHANGE_FAILED,
    });
  });

  it('非 2xx → 502，且 details 只含上游状态码、不含响应体', async () => {
    stubFetch([{ status: 500, body: { secret: 'should-not-leak' } }]);

    try {
      await client().exchangeCodeForToken('c');
      expect.unreachable('应当抛错');
    } catch (error) {
      const appError = error as AppError;
      expect(appError.httpStatus).toBe(502);
      expect(appError.details).toEqual({ upstreamStatus: 500 });
      expect(JSON.stringify(appError.details)).not.toContain('should-not-leak');
      expect(appError.safeMessage).not.toContain('should-not-leak');
    }
  });

  it('网络异常 → 502，不把原始错误暴露给调用方', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('ECONNRESET with token gho_leaked');
    });

    try {
      await client().exchangeCodeForToken('c');
      expect.unreachable('应当抛错');
    } catch (error) {
      const appError = error as AppError;
      expect(appError.code).toBe(DomainErrorCode.AUTH_OAUTH_EXCHANGE_FAILED);
      expect(JSON.stringify(appError.toApiErrorBody('req_x'))).not.toContain('gho_leaked');
    }
  });
});

describe('fetchProfile', () => {
  it('带上 Bearer 与 User-Agent，返回归一化资料与已验证主邮箱', async () => {
    const calls = stubFetch([
      { body: { id: 42, login: 'octocat', name: 'Mona', avatar_url: 'https://a/b.png' } },
      {
        body: [
          { email: 'secondary@example.com', primary: false, verified: true },
          { email: 'primary@example.com', primary: true, verified: true },
        ],
      },
    ]);

    const profile = await client().fetchProfile('gho_token');

    expect(profile).toEqual({
      providerAccountId: '42',
      login: 'octocat',
      name: 'Mona',
      avatarUrl: 'https://a/b.png',
      email: 'primary@example.com',
    });
    expect(calls[0]?.url).toBe('https://api.github.com/user');
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer gho_token');
    expect(headers['user-agent']).toBeTruthy();
  });

  it('忽略未验证的邮箱', async () => {
    stubFetch([
      { body: { id: 7, login: 'x', name: null, avatar_url: null } },
      { body: [{ email: 'unverified@example.com', primary: true, verified: false }] },
    ]);

    expect((await client().fetchProfile('t')).email).toBeNull();
  });

  it('邮箱端点失败不影响登录，只是拿不到邮箱', async () => {
    stubFetch([
      { body: { id: 7, login: 'x', name: null, avatar_url: null } },
      { status: 500, body: {} },
    ]);

    const profile = await client().fetchProfile('t');
    expect(profile.providerAccountId).toBe('7');
    expect(profile.email).toBeNull();
  });

  it('缺少 id 的响应 → 502', async () => {
    stubFetch([{ body: { login: 'x' } }]);
    await expect(client().fetchProfile('t')).rejects.toMatchObject({
      code: DomainErrorCode.AUTH_OAUTH_EXCHANGE_FAILED,
    });
  });

  /**
   * ★ P1 回归守卫（独立审查发现）。
   *
   * `GET /user` 的 `email` 是用户的**公开邮箱**，GitHub 不保证已验证 ——
   * 用户可以把它设成任意地址。而调用方会用这个邮箱去 `findOrCreateByEmail`，
   * 也就是按邮箱并入已有账号：一旦采信未验证邮箱，
   * 攻击者把公开邮箱改成受害者的地址就能直接登进受害者账号。
   *
   * ⚠ 修复前，本文件里那条「忽略未验证的邮箱」的 stub 里**根本没有 email 字段**，
   * 所以回落分支零覆盖 —— 测试是绿的，漏洞还在。
   */
  it('★ 公开 email 未被验证时不得采用，也不得回落到它', async () => {
    stubFetch([
      {
        body: {
          id: 42,
          login: 'attacker',
          name: 'Attacker',
          avatar_url: null,
          // 攻击者把公开邮箱填成受害者地址
          email: 'victim@example.com',
        },
      },
      { body: [{ email: 'victim@example.com', primary: true, verified: false }] },
    ]);

    expect((await client().fetchProfile('t')).email).toBeNull();
  });

  it('邮箱端点不可用时回落到公开 email 同样不被允许', async () => {
    stubFetch([
      { body: { id: 42, login: 'x', name: null, avatar_url: null, email: 'victim@example.com' } },
      { status: 500, body: {} },
    ]);

    expect((await client().fetchProfile('t')).email).toBeNull();
  });

  it('已验证邮箱超过 users.email 列宽时丢弃而不是截断（截断会指向另一个人）', async () => {
    const tooLong = `${'a'.repeat(300)}@example.com`;
    stubFetch([
      { body: { id: 42, login: 'x', name: null, avatar_url: null } },
      { body: [{ email: tooLong, primary: true, verified: true }] },
    ]);

    expect((await client().fetchProfile('t')).email).toBeNull();
  });

  it('已验证邮箱正常时仍会被采用（确认上面的收紧没有把功能关掉）', async () => {
    stubFetch([
      { body: { id: 42, login: 'x', name: null, avatar_url: null } },
      { body: [{ email: 'real@example.com', primary: true, verified: true }] },
    ]);

    expect((await client().fetchProfile('t')).email).toBe('real@example.com');
  });
});
