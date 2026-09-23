/**
 * Auth 模块的常量（TOTP/OTP 时长、Cookie 名、限流策略）。
 *
 * 这里**没有新增任何环境变量**：`docs/20` 的清单不可扩展，`docs/11` 已把
 * 15min / 30d / 10min 写死为契约值，限流阈值属于实现策略而非部署参数。
 */

import { API_PREFIX } from '@signal/contracts';

/** Access Token 有效期（docs/11：15min）。 */
export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;

/** Refresh Session 有效期（docs/11：30d）。 */
export const REFRESH_SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

/** OTP 有效期（docs/11：10 分钟）。 */
export const OTP_TTL_SECONDS = 10 * 60;

/** OTP 位数（docs/11：6 位）。 */
export const OTP_LENGTH = 6;

/** OAuth state 有效期。 */
export const OAUTH_STATE_TTL_SECONDS = 10 * 60;

/** refresh token 的随机字节数（base64url 后约 43 字符）。 */
export const REFRESH_TOKEN_BYTES = 32;

/**
 * 会话 Cookie 名。
 *
 * 刻意不用 `__Host-` 前缀：本地开发是 http，而 `__Host-` 强制 `Secure`，
 * 会让开发环境根本收不到 Cookie。生产环境单独加 `Secure`。
 */
export const ACCESS_TOKEN_COOKIE = 'signal_access_token';
export const REFRESH_TOKEN_COOKIE = 'signal_refresh_token';
export const OAUTH_STATE_COOKIE = 'signal_oauth_state';

/** access token 全站可用。 */
export const ACCESS_COOKIE_PATH = '/';

/**
 * refresh token 只发给 auth 自己的路由。
 *
 * 收窄 Path 的价值：其他模块的接口（含未来的 GET 类接口）即便被 XSS 触发
 * 也不会带上 refresh token，减少它在网络与日志里出现的机会。
 */
export const REFRESH_COOKIE_PATH = `${API_PREFIX}/auth`;

/** OAuth state 的签名域分隔标签，避免与 access token 共用密钥造成语义混淆。 */
export const OAUTH_STATE_PURPOSE = 'signal:oauth-state:v1';
/** OTP 哈希域分隔标签。 */
export const OTP_PURPOSE = 'signal:otp:v1';
/** refresh token 哈希域分隔标签。 */
export const REFRESH_TOKEN_PURPOSE = 'signal:refresh:v1';

/**
 * 限流策略（`docs/14` 要求 Redis 控制 OTP request / OTP verify / auth refresh）。
 *
 * 取值的取舍：
 *   - 同一邮箱 10 分钟内最多 3 次发码：足够覆盖「没收到、重发」，又挡住邮件轰炸。
 *   - 同一邮箱 10 分钟内最多 5 次验码：6 位码有 100 万种，5 次机会远不足以爆破，
 *     同时用户输错两次还能继续。
 *   - 同一 IP 1 小时最多 10 次发码：挡住换邮箱刷邮件。
 */
export const RATE_LIMITS = {
  otpRequestPerEmail: { limit: 3, windowSeconds: 600 },
  otpRequestPerIp: { limit: 10, windowSeconds: 3600 },
  otpVerifyPerEmail: { limit: 5, windowSeconds: 600 },
  refreshPerUser: { limit: 60, windowSeconds: 3600 },
  /**
   * 认不出身份的 refresh token（随机构造 / 已轮换掉的旧 token）按 token 摘要限流。
   * 这类 token 不存在轮换，所以以摘要为 key 是稳定有效的。
   */
  refreshPerUnknownToken: { limit: 10, windowSeconds: 3600 },
} as const;
