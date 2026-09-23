/**
 * OAuth `state` 的签发与校验。
 *
 * 防御目标（`docs/14` / 测试验收项 24「OAuth state mismatch 拒绝」）：
 *   - **登录 CSRF**：攻击者用自己的 GitHub 账号发起授权，再把 callback URL
 *     诱导受害者访问，受害者就被登录进攻击者的账号。靠「state 必须与发起时
 *     留在本浏览器的 Cookie 一致」挡住。
 *   - **伪造 / 枚举**：state 必须带服务端 HMAC 签名，攻击者无法凭空造。
 *   - **重放**：state 带签发时间，超过 `OAUTH_STATE_TTL_SECONDS` 即失效。
 *
 * 设计取舍：state 不用 Redis 存储，而是「签名 + Cookie 双提交」。
 * 这样 OAuth 路径不依赖 Redis 可用性，且天然是**无状态**的；
 * 代价是同一 state 在 10 分钟窗口内可被复用（配合 Cookie 双提交后不可跨浏览器）。
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { OAUTH_STATE_PURPOSE, OAUTH_STATE_TTL_SECONDS } from './auth.constants';

/** 生成 state：`<nonce>.<issuedAtSeconds>.<hmac>`，全部 base64url / 十进制。 */
export function generateOAuthState(secret: string, now: Date): string {
  const nonce = randomBytes(16).toString('base64url');
  const issuedAt = Math.floor(now.getTime() / 1000);
  const payload = `${nonce}.${issuedAt}`;
  return `${payload}.${sign(secret, payload)}`;
}

/**
 * 校验 state。任一条件不满足即返回 false：
 * 结构不合法、签名不匹配、签发时间在未来、已超过 TTL。
 *
 * 不做「throw」，让调用方决定如何响应（callback 是 302，不是 JSON 错误）。
 */
export function verifyOAuthState(
  secret: string,
  state: string | undefined,
  now: Date,
  ttlSeconds: number = OAUTH_STATE_TTL_SECONDS,
): boolean {
  if (state === undefined) return false;

  const parts = state.split('.');
  if (parts.length !== 3) return false;

  const [nonce, issuedAtRaw, signature] = parts as [string, string, string];
  if (nonce === '' || !/^\d{1,12}$/.test(issuedAtRaw) || signature === '') return false;

  if (!constantTimeEqual(signature, sign(secret, `${nonce}.${issuedAtRaw}`))) return false;

  const issuedAtMs = Number(issuedAtRaw) * 1000;
  const ageMs = now.getTime() - issuedAtMs;
  // 允许 60s 时钟偏移（签发方与校验方可能是不同进程），未来时间同样视为非法。
  if (ageMs < -60_000) return false;
  return ageMs <= ttlSeconds * 1000;
}

function sign(secret: string, payload: string): string {
  return createHmac('sha256', secret)
    .update(`${OAUTH_STATE_PURPOSE}:${payload}`)
    .digest('base64url');
}

/** 恒定时间比较；长度不同直接返回 false（长度本身不是秘密）。 */
export function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
