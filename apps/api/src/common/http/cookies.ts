/**
 * Cookie 读写 —— 自带实现，不依赖 express 的 `res.cookie()` / cookie-parser。
 *
 * 理由：仓库没有 `@types/express`，而 Cookie 的解析与序列化是认证安全的关键路径，
 * 自己实现才能把边界（重复 Cookie、编码、属性）写成可直接断言的单元测试。
 *
 * 契约（docs/11 / docs/14）：
 *   - 会话 Cookie 一律 `HttpOnly` + `SameSite=Lax`（生产再加 `Secure`）。
 *   - 值必须 URL 编码，属性必须显式给出 `Path`，否则可能出现「同名 Cookie 残留」。
 */

/** 序列化用的属性。 */
export type CookieOptions = {
  /** 默认 `'/'`。refresh cookie 会收窄到 `/api/v1/auth`。 */
  path?: string;
  /** 相对当前时间的存活秒数。省略则为会话 Cookie。 */
  maxAgeSeconds?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Lax' | 'Strict' | 'None';
  domain?: string;
};

const SAME_SITE_VALUE: Record<'Lax' | 'Strict' | 'None', string> = {
  Lax: 'Lax',
  Strict: 'Strict',
  None: 'None',
};

/**
 * 序列化一个 Set-Cookie 值。
 *
 * 值经 `encodeURIComponent`，因此 `;` / `,` / 空格 / 非 ASCII 都不会破坏语法。
 */
export function serializeCookie(name: string, value: string, options: CookieOptions = {}): string {
  const parts = [`${name}=${encodeURIComponent(value)}`];

  parts.push(`Path=${options.path ?? '/'}`);
  if (options.maxAgeSeconds !== undefined) {
    parts.push(`Max-Age=${Math.max(0, Math.floor(options.maxAgeSeconds))}`);
  }
  if (options.domain !== undefined) parts.push(`Domain=${options.domain}`);
  if (options.httpOnly !== false) parts.push('HttpOnly');
  if (options.secure === true) parts.push('Secure');
  if (options.sameSite !== undefined) parts.push(`SameSite=${SAME_SITE_VALUE[options.sameSite]}`);

  return parts.join('; ');
}

/**
 * 生成「清除 Cookie」的 Set-Cookie 值。
 *
 * ⚠ 必须与写入时用**同一套 Path/Domain**，否则浏览器会留下原 Cookie ——
 * 这是「登出后仍然登录」的常见成因。因此 `Path` 由调用方显式传入。
 */
export function serializeClearedCookie(name: string, options: CookieOptions = {}): string {
  return serializeCookie(name, '', { ...options, maxAgeSeconds: 0 });
}

/**
 * 解析 `Cookie` 请求头。
 *
 * - 同名 Cookie 出现多次时**第一个生效**（RFC 6265 允许服务端自选；
 *   需要严格判定时用 `countCookie()`，认证路径就是这么做的）。
 * - 解码失败时退回原始值，不抛异常（Cookie 是外部输入，不该让请求 500）。
 */
export function parseCookieHeader(header: string | undefined): Record<string, string> {
  const jar: Record<string, string> = {};
  if (header === undefined) return jar;

  for (const segment of header.split(';')) {
    const eq = segment.indexOf('=');
    if (eq <= 0) continue;
    const name = segment.slice(0, eq).trim();
    if (name === '' || name in jar) continue;
    const rawValue = segment.slice(eq + 1).trim();
    jar[name] = decodeCookieValue(rawValue);
  }
  return jar;
}

function decodeCookieValue(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** 读取单个 Cookie。 */
export function readCookie(header: string | undefined, name: string): string | undefined {
  return parseCookieHeader(header)[name];
}

/**
 * 统计同名 Cookie 出现次数。
 * 用于「必须唯一」的场景（如 OAuth state 双提交），防 Cookie 覆盖攻击。
 */
export function countCookie(header: string | undefined, name: string): number {
  if (header === undefined) return 0;
  let count = 0;
  for (const segment of header.split(';')) {
    const eq = segment.indexOf('=');
    if (eq <= 0) continue;
    if (segment.slice(0, eq).trim() === name) count += 1;
  }
  return count;
}

/** 从请求头里读 Cookie。 */
export function readCookieFromHeaders(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const raw = headers.cookie;
  return readCookie(Array.isArray(raw) ? raw[0] : raw, name);
}
