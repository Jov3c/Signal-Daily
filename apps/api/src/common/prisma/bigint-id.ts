/**
 * BIGINT 主键的字符串 ↔ bigint 转换。
 *
 * `docs/02`：DB 主键是 BIGINT UNSIGNED，API 一律以 string 序列化。
 * 因此 API 层处处要在两者间来回：对外是 string，对库是 bigint。
 *
 * ⚠ 不要直接 `BigInt(value)`：`BigInt('abc')` 会抛 `SyntaxError`，
 * 让一个畸形 URL 参数变成 500。这里统一返回 null，由调用方走 404 / 401。
 *
 * **下游 Agent 请复用本函数。**
 */

/** 十进制无符号整数，最长 20 位（BIGINT UNSIGNED 上限 18446744073709551615）。 */
const BIGINT_ID_PATTERN = /^\d{1,20}$/;

/** 合法的 BIGINT 字符串 → `bigint`；否则 `null`。 */
export function toBigIntId(value: string): bigint | null {
  return BIGINT_ID_PATTERN.test(value) ? BigInt(value) : null;
}

/** 数据库的 bigint 主键 → 对外的 string。 */
export function toIdString(value: bigint): string {
  return String(value);
}
