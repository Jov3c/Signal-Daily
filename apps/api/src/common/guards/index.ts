/**
 * `apps/api/src/common/guards` 的稳定导出面。
 *
 * **下游 Agent 一律从这里 import**（相对路径 `../../common/guards`），
 * 不要直接引内部文件名，方便后续重构而不破坏调用方。
 *
 * 用法：
 * ```ts
 * import { AuthGuard, AdminGuard, CurrentUser } from '../../common/guards';
 *
 * @UseGuards(AuthGuard)  @Controller('bookmarks')   // 登录用户
 * @UseGuards(AdminGuard) @Controller('admin/xxx')   // 管理员
 * ```
 * 使用方所在模块需要 `imports: [AuthModule]`。
 */

export {
  ACCESS_TOKEN_COOKIE,
  AuthGuard,
  UNAUTHORIZED_MESSAGE,
  extractAccessToken,
  unauthorizedError,
} from './auth.guard';
export { AdminGuard, FORBIDDEN_MESSAGE } from './admin.guard';
export { CurrentUser, requireAuthUser } from './current-user.decorator';
export {
  ACCESS_TOKEN_VERIFIER,
  AUTH_SESSION_LOOKUP,
  type AccessTokenClaims,
  type AccessTokenVerifier,
  type AuthenticatedSession,
  type AuthSessionLookup,
} from './ports';
export type { AuthUser, HttpRequestLike, HttpResponseLike } from '../http/http-types';
