/**
 * Auth 模块的 Cookie 策略。
 *
 * `docs/11`：HttpOnly / Secure / SameSite=Lax。
 *   - `HttpOnly`               —— 前端 JS 读不到，XSS 也偷不走（docs/14 的 XSS 风险）。
 *   - `SameSite=Lax`           —— 挡掉跨站 POST 携带；本站导航仍带 Cookie，登录态才可用。
 *   - `Secure`                 —— **仅生产**。本地是 http，加 Secure 会让浏览器直接丢弃
 *                                 Cookie，开发者会以为「登录坏了」。
 *
 * 两种 Cookie 的 Path 不同（见 `auth.constants.ts`），
 * 因此**清除时必须用与写入完全相同的 Path**，否则会留下同名残留 Cookie。
 */

import {
  serializeClearedCookie,
  serializeCookie,
  type CookieOptions,
} from '../../common/http/cookies';
import {
  ACCESS_COOKIE_PATH,
  ACCESS_TOKEN_COOKIE,
  OAUTH_STATE_COOKIE,
  REFRESH_COOKIE_PATH,
  REFRESH_TOKEN_COOKIE,
} from './auth.constants';
import type { AuthConfig } from './auth.config';
import type { IssuedSession } from './session.service';

function baseOptions(config: AuthConfig): Pick<CookieOptions, 'httpOnly' | 'secure' | 'sameSite'> {
  return { httpOnly: true, secure: config.secureCookies, sameSite: 'Lax' };
}

/** 写入 access + refresh 两个 Cookie 的 `Set-Cookie` 值。 */
export function buildSessionCookies(session: IssuedSession, config: AuthConfig): string[] {
  return [
    serializeCookie(ACCESS_TOKEN_COOKIE, session.accessToken, {
      ...baseOptions(config),
      path: ACCESS_COOKIE_PATH,
      maxAgeSeconds: session.accessTokenExpiresInSeconds,
    }),
    serializeCookie(REFRESH_TOKEN_COOKIE, session.refreshToken, {
      ...baseOptions(config),
      path: REFRESH_COOKIE_PATH,
      maxAgeSeconds: session.refreshTokenExpiresInSeconds,
    }),
  ];
}

/** 清除两个会话 Cookie 的 `Set-Cookie` 值。 */
export function buildClearedSessionCookies(config: AuthConfig): string[] {
  const options = baseOptions(config);
  return [
    serializeClearedCookie(ACCESS_TOKEN_COOKIE, { ...options, path: ACCESS_COOKIE_PATH }),
    serializeClearedCookie(REFRESH_TOKEN_COOKIE, { ...options, path: REFRESH_COOKIE_PATH }),
  ];
}

/** 写入 OAuth state Cookie（短期、与授权请求一一对应）。 */
export function buildOAuthStateCookie(
  state: string,
  config: AuthConfig,
  ttlSeconds: number,
): string {
  return serializeCookie(OAUTH_STATE_COOKIE, state, {
    ...baseOptions(config),
    path: REFRESH_COOKIE_PATH,
    maxAgeSeconds: ttlSeconds,
  });
}

/** 清除 OAuth state Cookie。 */
export function buildClearedOAuthStateCookie(config: AuthConfig): string {
  return serializeClearedCookie(OAUTH_STATE_COOKIE, {
    ...baseOptions(config),
    path: REFRESH_COOKIE_PATH,
  });
}
