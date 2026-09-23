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
 *
 * ⚠ 历史教训（两处曾导致真实泄漏，均已修复并有测试守护）：
 *   1. 早期版本对「非普通对象」（类实例）直接原样返回。Node 的
 *      `IncomingMessage` 必然是类实例，于是 `logger.info({ req })` 这种
 *      最标准的请求日志写法会把完整 Authorization header 打进日志。
 *   2. 早期版本用只增不删的 WeakSet 做去重，把「已访问过」当成
 *      「正在访问中」，导致非循环的共享引用被误标为 '[Circular]'，
 *      静默丢失日志数据。
 */

/** 脱敏后替换成的占位符。 */
export const REDACTED = '[REDACTED]';

/** 真循环引用的标记。 */
export const CIRCULAR = '[Circular]';

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

/**
 * 深度脱敏任意日志载荷。
 *
 * 行为：
 *   - 命中 secret 字段名的 key → 值整体替换为 `[REDACTED]`。
 *   - 字符串值 → 再做连接串 / 内联凭据的模式脱敏。
 *   - 普通对象与**类实例**都递归自有可枚举属性（保证 `req` 这类
 *     请求对象不会绕过脱敏）。
 *   - `Date` / `Buffer` 以及任何带 `toJSON` 的对象（如 `Prisma.Decimal`）
 *     按其 JSON 语义处理，不破坏日志可读性。
 *   - `Error` 收敛为 name / message / stack / code 并递归其自定义属性。
 *   - 真循环引用标记为 `[Circular]`；**非循环的共享引用正常展开**。
 */
export function redactSecrets<T>(value: T, seen: WeakSet<object> = new WeakSet()): T {
  return redactValue(value, seen) as T;
}

function isPlainObject(value: object): boolean {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function redactValue(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') return redactString(value);
  if (typeof value !== 'object' || value === null) return value;

  // `seen` 表示「当前递归路径」，而不是「访问过的全部对象」。
  // 处理完必须 delete，否则非循环的共享引用会被误判为循环。
  if (seen.has(value)) return CIRCULAR;

  if (Array.isArray(value)) {
    seen.add(value);
    const output = value.map((item) => redactValue(item, seen));
    seen.delete(value);
    return output;
  }

  if (value instanceof Date) return value;
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(value)) return value;

  if (value instanceof Error) return redactError(value, seen);

  // 带 toJSON 的对象（Prisma.Decimal、URL 等）按 JSON 语义展开，
  // 否则会退化成内部字段（如 Decimal 的 d/e/s），破坏日志可读性。
  if (!isPlainObject(value) && typeof (value as { toJSON?: unknown }).toJSON === 'function') {
    const json = (value as { toJSON: () => unknown }).toJSON();
    if (json !== value) return redactValue(json, seen);
    return value;
  }

  // 普通对象与类实例一视同仁：递归自有可枚举属性。
  // JSON.stringify 对类实例的行为也是这样，因此不损失保真度。
  seen.add(value);
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    output[key] = isSecretKey(key)
      ? REDACTED
      : redactValue((value as Record<string, unknown>)[key], seen);
  }
  seen.delete(value);
  return output;
}

/**
 * `Error` 收敛。
 * `message` / `stack` 是不可枚举的自有属性，直接走上面的通用分支会丢失，
 * 因此单独处理，同时递归自定义的可枚举属性（那些才是最容易夹带 secret 的）。
 */
function redactError(error: Error, seen: WeakSet<object>): Record<string, unknown> {
  seen.add(error);

  const output: Record<string, unknown> = {
    name: error.name,
    message: redactString(error.message),
  };
  if (typeof error.stack === 'string') output.stack = redactString(error.stack);

  for (const key of Object.keys(error)) {
    output[key] = isSecretKey(key)
      ? REDACTED
      : redactValue((error as unknown as Record<string, unknown>)[key], seen);
  }

  seen.delete(error);
  return output;
}
