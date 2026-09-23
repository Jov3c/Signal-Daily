/**
 * AuthGuard —— 认证守卫。**供 Agent 03 / 07 / 09 / 12 复用**（见 HANDOFF Integration Notes）。
 *
 * 用法（在自己模块的 controller 上）：
 * ```ts
 * import { AuthGuard } from '../../common/guards';
 * @UseGuards(AuthGuard) @Controller('bookmarks') class BookmarksController { ... }
 * ```
 * 所在模块需要 `imports: [AuthModule]`（AuthModule 已 export 本守卫与它的依赖）。
 *
 * 每个认证请求的代价：**一次数据库查询**（会话 join 用户）。
 * 换来的是登出 / 撤权 / 禁用**立刻生效**，而不是等 access token 过期。
 */

import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { AppError, DomainErrorCode, PlatformErrorCode, UserStatus } from '@signal/contracts';
import { readCookie } from '../http/cookies';
import { readHeader, type AuthUser, type HttpRequestLike } from '../http/http-types';
import {
  ACCESS_TOKEN_VERIFIER,
  AUTH_SESSION_LOOKUP,
  type AccessTokenVerifier,
  type AuthSessionLookup,
} from './ports';

/** access token 的 Cookie 名。Controller 写入与守卫读取共用此常量。 */
export const ACCESS_TOKEN_COOKIE = 'signal_access_token';

/** 认证失败统一文案 —— 不区分「token 无效」「用户不存在」，避免账号探测。 */
export const UNAUTHORIZED_MESSAGE = 'Authentication required';

/** 从请求中取 access token：优先 HttpOnly Cookie，其次 `Authorization: Bearer`。 */
export function extractAccessToken(req: HttpRequestLike): string | undefined {
  const raw = readHeader(req, 'cookie');
  const cookieToken = readCookie(raw, ACCESS_TOKEN_COOKIE);
  if (cookieToken !== undefined && cookieToken !== '') return cookieToken;

  const header = readHeader(req, 'authorization');
  if (header === undefined) return undefined;

  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match?.[1];
}

/** 未认证错误。 */
export function unauthorizedError(): AppError {
  return new AppError({
    code: PlatformErrorCode.UNAUTHORIZED,
    httpStatus: 401,
    safeMessage: UNAUTHORIZED_MESSAGE,
  });
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(ACCESS_TOKEN_VERIFIER) private readonly tokens: AccessTokenVerifier,
    @Inject(AUTH_SESSION_LOOKUP) private readonly sessions: AuthSessionLookup,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<HttpRequestLike>();

    const token = extractAccessToken(req);
    if (token === undefined) throw unauthorizedError();

    // 校验失败由 verifier 抛 UNAUTHORIZED，这里不吞异常。
    const claims = this.tokens.verifyAccessToken(token);

    const session = await this.sessions.findAuthenticatedSession(claims.sessionId);
    if (session === null) throw unauthorizedError();

    // token 的 sub 必须与 sid 指向的会话属于同一个人。
    // 一个签名有效但 sub/sid 不匹配的 token 说明签发逻辑出过问题，不能放行。
    if (session.userId !== claims.userId) throw unauthorizedError();

    if (session.status !== UserStatus.ACTIVE) {
      throw new AppError({
        code: DomainErrorCode.AUTH_ACCOUNT_DISABLED,
        httpStatus: 401,
        safeMessage: 'Account is disabled',
      });
    }

    const authUser: AuthUser = {
      id: session.userId,
      role: session.role,
      sessionId: session.sessionId,
    };
    req.authUser = authUser;
    return true;
  }
}
