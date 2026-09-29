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

/**
 * Prisma 能**安全绑定**的上界（有符号 64 位最大值）。
 *
 * ⚠ 为什么必须有这个上界（这一段是该文件存在过的最久的缺陷，被上报了**四次**）：
 * `BIGINT_ID_PATTERN` 只保证「20 位以内的十进制数字」，而 20 位可以到
 * `18446744073709551615`（BIGINT UNSIGNED 的合法上限）。但 **Prisma 把 JS
 * `bigint` 按有符号 64 位绑定** —— 任何超过 `2^63-1` 的值（**包括那个合法上限
 * 本身**）都会让驱动抛 `PrismaClientUnknownRequestError`。
 *
 * 后果：`GET /api/v1/admin/review/18446744073709551615` 返回 **500 而不是 404**，
 * 污染 5xx 告警 —— 而调用方只是点了一个畸形的链接。
 *
 * 上报历史：Agent 03（其 CCR 第 8 项）→ Agent 07 → Agent 09（其 CCR 第 0 项，明说
 * 「这是第四次，三行可修」）→ 本次修复。**在这个文件修掉之前，三个下游模块各自
 * 在自己的边界上又实现了一遍上界检查**（`toSourceId` / `toReviewId` /
 * `toBookmarkContentId` / `toResourceId`）—— 四份重复就是「没在源头修」的成本。
 */
export const MAX_BINDABLE_ID = 9_223_372_036_854_775_807n;

/**
 * 合法的 BIGINT 字符串 → `bigint`；**畸形或超出驱动可绑定上界**时 `null`。
 *
 * 超界的 id 一律当作「**不存在**」（调用方转 404）而不是「非法输入」（转 400）：
 * 对调用方而言两者没有区别，而 404 不产生 5xx 噪声。
 */
export function toBigIntId(value: string): bigint | null {
  if (!BIGINT_ID_PATTERN.test(value)) return null;
  const parsed = BigInt(value);
  return parsed > MAX_BINDABLE_ID ? null : parsed;
}

/** 数据库的 bigint 主键 → 对外的 string。 */
export function toIdString(value: bigint): string {
  return String(value);
}
