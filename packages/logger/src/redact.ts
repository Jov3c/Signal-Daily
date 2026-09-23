/**
 * Secret 脱敏。
 *
 * 契约（`docs/14` / `docs/15`）：
 *   - 不得记录 token、密码、OTP 明文、完整 secret。
 *   - 禁止记录完整 Authorization header。
 *
 * 设计取舍：脱敏按 **字段名** 判定，因此不会误伤 `code` / `errorCode` /
 * `statusCode` 这类合法的业务字段；OTP 明文只可能出现在 `otp` / `otpCode`
 * 这类字段里，已被覆盖。
 */

/** 脱敏后替换成的占位符。 */
export const REDACTED = '[REDACTED]';

/**
 * 需要整字段脱敏的 key。
 * 覆盖：密码、各类 token / secret、OTP 明文、API key、Cookie、
 * Authorization header、连接串 DSN、session 标识、credential。
 */
const SECRET_KEY_PATTERN =
  /(password|passwd|pwd|secret|token|otp|pepper|api_?key|access_?key|private_?key|client_?secret|authorization|cookie|credential|dsn|bearer|session_?id|signature)/i;

/** 连接串中的密码段：`scheme://user:password@host`。 */
const CONNECTION_STRING_CREDENTIALS = /([a-z][a-z0-9+.-]*:\/\/[^:/?#@\s]+):[^@/\s]+@/gi;

/** 内联 bearer / basic 凭据。 */
const INLINE_AUTHORIZATION = /\b(Bearer|Basic|Token)\s+[A-Za-z0-9\-._~+/=]{8,}/gi;

/** 该字段名是否必须整体脱敏。 */
export function isSecretKey(key: string): boolean {
  return SECRET_KEY_PATTERN.test(key);
}

/** 对字符串内容做模式级脱敏（连接串密码、内联凭据）。 */
export function redactString(value: string): string {
  return value
    .replace(CONNECTION_STRING_CREDENTIALS, `$1:${REDACTED}@`)
    .replace(INLINE_AUTHORIZATION, `$1 ${REDACTED}`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * 深度脱敏任意日志载荷。
 *
 * 行为：
 *   - 命中 secret 字段名的 key → 值整体替换为 `[REDACTED]`。
 *   - 字符串值 → 再做连接串 / 内联凭据的模式脱敏。
 *   - 只递归普通对象与数组；Date / Error / Buffer / 类实例原样保留，
 *     避免破坏 pino 的序列化行为。
 *   - 通过 WeakSet 处理循环引用。
 */
export function redactSecrets<T>(value: T, seen: WeakSet<object> = new WeakSet()): T {
  return redactValue(value, seen) as T;
}

function redactValue(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') return redactString(value);
  if (typeof value !== 'object' || value === null) return value;

  if (seen.has(value)) return '[Circular]';

  if (Array.isArray(value)) {
    seen.add(value);
    return value.map((item) => redactValue(item, seen));
  }

  if (!isPlainObject(value)) return value;

  seen.add(value);
  const output: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    output[key] = isSecretKey(key) ? REDACTED : redactValue(nested, seen);
  }
  return output;
}
