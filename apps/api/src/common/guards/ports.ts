/**
 * 守卫所依赖的**端口**（接口 + 注入 token）。
 *
 * 为什么放在 `common/`：
 * `AuthGuard` 要验证 access token、要确认会话仍然有效，但 `common/` 是比 modules
 * 更低层的位置，不应该反向 import `modules/auth`。因此这里只声明窄接口，
 * 由对应模块提供实现绑定（见 `AuthModule` 的 providers）。
 *
 * 直接收益：守卫可以在**没有任何数据库、没有任何 HTTP 框架**的单元测试里
 * 用两个假对象完整验证。
 *
 * ⚠ 为什么按 **sessionId** 而不是 userId 查：
 * 这样一次查询就能同时拿到「会话是否仍有效」与「用户当前的角色 / 状态」。
 * 于是**登出、撤权、禁用都会立刻生效**，而不是等 access token 自然过期
 * （最长 15 分钟空窗）。`docs/14` 要求 Admin 端点强制 auth + role，
 * 用 token 里的角色快照授权会让撤权有同样长的空窗，因此以库为准。
 */

import type { UserRole, UserStatus } from '@signal/contracts';

/** access token 校验端口。 */
export const ACCESS_TOKEN_VERIFIER = 'ACCESS_TOKEN_VERIFIER';

/** access token 载荷中我们关心的部分。 */
export type AccessTokenClaims = {
  /** `sub`：BIGINT → string（docs/02）。 */
  userId: string;
  /** `sid`：签发该 token 的 Session。 */
  sessionId: string;
  /** 签发时的角色快照；**授权判定以数据库为准**，这里只用于一致性核对。 */
  role: UserRole;
};

export interface AccessTokenVerifier {
  /**
   * 校验并解码 access token。
   * 任何失败（签名、算法、过期、iss/aud、结构）都必须抛 `UNAUTHORIZED` 的 AppError。
   */
  verifyAccessToken(token: string): AccessTokenClaims;
}

/** 认证主体查询端口。 */
export const AUTH_SESSION_LOOKUP = 'AUTH_SESSION_LOOKUP';

/** 一个仍然有效的会话所对应的认证主体。 */
export type AuthenticatedSession = {
  /** BIGINT → string。 */
  sessionId: string;
  userId: string;
  role: UserRole;
  status: UserStatus;
};

export interface AuthSessionLookup {
  /**
   * 按会话 id 取认证主体。
   * 会话不存在、或已被撤销（`revoked_at` 非空）时返回 `null`。
   *
   * 不在这里判断 `expires_at`：access token 本身只有 15 分钟，
   * 会话过期由 refresh 路径负责，这里重复判断只会多一次无意义的分支。
   */
  findAuthenticatedSession(sessionId: string): Promise<AuthenticatedSession | null>;
}
