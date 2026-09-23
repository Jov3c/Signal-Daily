/**
 * `AuthGuard` / `AdminGuard` —— 这是交给下游（03 / 07 / 09 / 12）的公开能力，
 * 因此必须在**真实 HTTP** 上验证，而不只是内部调用。
 *
 * 探针控制器扮演下游模块：它们只做两件事 —— 套守卫、回显 `@CurrentUser()`。
 */

import { afterEach, describe, expect, it } from 'vitest';
import { Controller, Get, UseGuards, type ExecutionContext } from '@nestjs/common';
import {
  AppError,
  DomainErrorCode,
  PlatformErrorCode,
  UserRole,
  envelope,
} from '@signal/contracts';
import {
  AuthGuard,
  AdminGuard,
  CurrentUser,
  extractAccessToken,
  type AccessTokenClaims,
} from '../src/common/guards';
import type { AuthUser, HttpRequestLike } from '../src/common/http/http-types';
import {
  TEST_EMAIL,
  TEST_OTP_CODE,
  cookieHeader,
  cookieValue,
  setCookies,
  type AuthTestApp,
} from './support/test-app';
import { createAuthTestApp } from './support/test-app';
import { FakeAccessTokenVerifier, type InMemoryAuthRepository } from './support/fakes';

@Controller('__probe/user')
@UseGuards(AuthGuard)
class UserProbeController {
  @Get()
  whoami(@CurrentUser() user: AuthUser | undefined): unknown {
    return envelope(user ?? null);
  }
}

@Controller('__probe/admin')
@UseGuards(AdminGuard)
class AdminProbeController {
  @Get()
  adminOnly(@CurrentUser() user: AuthUser | undefined): unknown {
    return envelope(user ?? null);
  }
}

const USER_PROBE = '/api/v1/__probe/user';
const ADMIN_PROBE = '/api/v1/__probe/admin';
const REQUEST_CODE_PATH = '/api/v1/auth/email/request-code';
const VERIFY_PATH = '/api/v1/auth/email/verify';

let app: AuthTestApp | undefined;

async function boot(): Promise<AuthTestApp> {
  app = await createAuthTestApp({ probeControllers: [UserProbeController, AdminProbeController] });
  return app;
}

afterEach(async () => {
  await app?.close();
  app = undefined;
});

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

async function errorCode(response: Response): Promise<string> {
  const payload = (await response.json()) as { error: { code: string } };
  return payload.error.code;
}

describe('AuthGuard（真实 HTTP）', () => {
  it('未认证 → 401 UNAUTHORIZED', async () => {
    const test = await boot();
    const response = await test.request(USER_PROBE);

    expect(response.status).toBe(401);
    expect(await errorCode(response)).toBe(PlatformErrorCode.UNAUTHORIZED);
  });

  it('已认证 → 放行，并把认证主体交给 @CurrentUser()', async () => {
    const test = await boot();
    const cookies = await login(test);

    const response = await test.request(USER_PROBE, { cookie: cookieHeader(cookies) });
    expect(response.status).toBe(200);

    const payload = (await response.json()) as { data: AuthUser };
    expect(payload.data.role).toBe(UserRole.USER);
    // BIGINT 序列化成 string
    expect(typeof payload.data.id).toBe('string');
    expect(payload.data.sessionId).toMatch(/^\d+$/);
  });

  it('只有 Authorization Bearer（没有 Cookie）也能通过', async () => {
    const test = await boot();
    const cookies = await login(test);
    const token = cookieValue(cookies, 'signal_access_token') ?? '';

    const response = await test.request(USER_PROBE, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(200);
  });

  it('用户记录消失（例如被删除）→ 401，即便 token 仍然有效', async () => {
    const test = await boot();
    const cookies = await login(test);

    for (const id of [...test.userRepository.users.keys()]) test.userRepository.users.delete(id);

    const response = await test.request(USER_PROBE, { cookie: cookieHeader(cookies) });
    expect(response.status).toBe(401);
  });
});

describe('AdminGuard（真实 HTTP）', () => {
  it('USER 访问 admin 探针 → 403 FORBIDDEN', async () => {
    const test = await boot();
    const cookies = await login(test);

    const response = await test.request(ADMIN_PROBE, { cookie: cookieHeader(cookies) });
    expect(response.status).toBe(403);
    expect(await errorCode(response)).toBe(PlatformErrorCode.FORBIDDEN);
  });

  it('未认证访问 admin 探针 → 401（而不是 403）', async () => {
    const test = await boot();
    const response = await test.request(ADMIN_PROBE);

    expect(response.status).toBe(401);
    expect(await errorCode(response)).toBe(PlatformErrorCode.UNAUTHORIZED);
  });

  it('ADMIN 访问 admin 探针 → 200', async () => {
    const test = await boot();
    test.userRepository.seed({ email: TEST_EMAIL, role: UserRole.ADMIN });
    const cookies = await login(test);

    const response = await test.request(ADMIN_PROBE, { cookie: cookieHeader(cookies) });
    expect(response.status).toBe(200);
    const payload = (await response.json()) as { data: AuthUser };
    expect(payload.data.role).toBe(UserRole.ADMIN);
  });

  it('角色以数据库为准：登录后升权立刻生效（不必等 token 过期）', async () => {
    const test = await boot();
    const cookies = await login(test);
    expect((await test.request(ADMIN_PROBE, { cookie: cookieHeader(cookies) })).status).toBe(403);

    const user = [...test.userRepository.users.values()][0];
    if (user === undefined) throw new Error('没有用户');
    user.role = UserRole.ADMIN;

    // access token 里仍然写着 USER，但授权必须按库里的最新角色判
    const response = await test.request(ADMIN_PROBE, { cookie: cookieHeader(cookies) });
    expect(response.status).toBe(200);
  });

  it('角色以数据库为准：撤权同样立刻生效', async () => {
    const test = await boot();
    const seeded = test.userRepository.seed({ email: TEST_EMAIL, role: UserRole.ADMIN });
    const cookies = await login(test);
    expect((await test.request(ADMIN_PROBE, { cookie: cookieHeader(cookies) })).status).toBe(200);

    seeded.role = UserRole.USER;

    const response = await test.request(ADMIN_PROBE, { cookie: cookieHeader(cookies) });
    expect(response.status).toBe(403);
  });
});

describe('AuthGuard 单元行为（无 HTTP）', () => {
  function contextFor(req: HttpRequestLike): ExecutionContext {
    return {
      switchToHttp: () => ({ getRequest: () => req }),
    } as unknown as ExecutionContext;
  }

  const claims: AccessTokenClaims = { userId: '7', sessionId: '3', role: UserRole.USER };

  function guardWith(
    verifier: FakeAccessTokenVerifier,
    session: Awaited<ReturnType<InMemoryAuthRepository['findAuthenticatedSession']>>,
  ): AuthGuard {
    return new AuthGuard(verifier, { findAuthenticatedSession: async () => session });
  }

  it('没有任何凭据 → 抛 UNAUTHORIZED', async () => {
    const verifier = new FakeAccessTokenVerifier();
    verifier.claims = claims;
    const guard = guardWith(verifier, null);

    await expect(guard.canActivate(contextFor({ headers: {} }))).rejects.toMatchObject({
      code: PlatformErrorCode.UNAUTHORIZED,
    });
  });

  it('token 中的 sub 与会话的 userId 不一致 → 拒绝', async () => {
    const verifier = new FakeAccessTokenVerifier();
    verifier.claims = claims;
    const guard = guardWith(verifier, {
      sessionId: '3',
      userId: '999',
      role: UserRole.USER,
      status: 'ACTIVE' as never,
    });

    await expect(
      guard.canActivate(contextFor({ headers: { authorization: 'Bearer t' } })),
    ).rejects.toMatchObject({ code: PlatformErrorCode.UNAUTHORIZED });
  });

  it('会话已不存在（登出 / 轮换掉）→ 拒绝', async () => {
    const verifier = new FakeAccessTokenVerifier();
    verifier.claims = claims;
    const guard = guardWith(verifier, null);

    await expect(
      guard.canActivate(contextFor({ headers: { authorization: 'Bearer t' } })),
    ).rejects.toMatchObject({ code: PlatformErrorCode.UNAUTHORIZED });
  });

  it('用户被禁用 → AUTH_ACCOUNT_DISABLED', async () => {
    const verifier = new FakeAccessTokenVerifier();
    verifier.claims = claims;
    const guard = guardWith(verifier, {
      sessionId: '3',
      userId: '7',
      role: UserRole.USER,
      status: 'DISABLED' as never,
    });

    try {
      await guard.canActivate(contextFor({ headers: { authorization: 'Bearer t' } }));
      expect.unreachable('应当抛错');
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe(DomainErrorCode.AUTH_ACCOUNT_DISABLED);
      expect((error as AppError).httpStatus).toBe(401);
    }
  });

  it('成功时把认证主体挂到请求上', async () => {
    const verifier = new FakeAccessTokenVerifier();
    verifier.claims = claims;
    const guard = guardWith(verifier, {
      sessionId: '3',
      userId: '7',
      role: UserRole.ADMIN,
      status: 'ACTIVE' as never,
    });

    const req: HttpRequestLike = { headers: { cookie: 'signal_access_token=abc' } };
    await expect(guard.canActivate(contextFor(req))).resolves.toBe(true);

    expect(req.authUser).toEqual({ id: '7', role: UserRole.ADMIN, sessionId: '3' });
  });
});

describe('extractAccessToken', () => {
  it('Cookie 优先于 Authorization 头', () => {
    expect(
      extractAccessToken({
        headers: {
          cookie: 'signal_access_token=cookie-token',
          authorization: 'Bearer header-token',
        },
      }),
    ).toBe('cookie-token');
  });

  it('支持 URL 编码的 Cookie 值', () => {
    const value = 'a+b/c=d';
    expect(
      extractAccessToken({
        headers: { cookie: `signal_access_token=${encodeURIComponent(value)}` },
      }),
    ).toBe(value);
  });

  it('忽略空 Cookie，退回 Authorization', () => {
    expect(
      extractAccessToken({
        headers: { cookie: 'signal_access_token=; other=1', authorization: 'bearer tok' },
      }),
    ).toBe('tok');
  });

  it('没有任何凭据时返回 undefined', () => {
    expect(extractAccessToken({ headers: {} })).toBeUndefined();
    expect(extractAccessToken({ headers: { cookie: 'other=1' } })).toBeUndefined();
  });
});
