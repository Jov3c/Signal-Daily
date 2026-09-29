/**
 * BIGINT id 的解析 —— 契约里的 `BigIntId` 是十进制字符串。
 *
 * ── 为什么需要上界检查（这是 Agent 03 用实测换来的教训）────────────────
 * `raw_items.id` / `contents.id` 都是 `BIGINT UNSIGNED`
 *（上界 18446744073709551615）。但 **Prisma 把 JS `bigint` 按有符号 64 位绑定**，
 * 任何超过 `2^63-1` 的值（**包括合法的无符号上限本身**）都会让驱动抛
 * `PrismaClientUnknownRequestError`。
 *
 * 后果是：一个格式合法但超界的 id 会让查询**抛 500 级异常**，
 * 而不是干净地返回「不存在」。对 worker 而言这意味着一条脏载荷
 * 会把 job 变成一次无意义的失败重试。
 *
 * 因此超过有符号上界一律当作「**不存在**」（返回 `null`），
 * 由调用方走 `*_NOT_FOUND` 分支。
 */

/** Prisma 能安全绑定的 `bigint` 上界（有符号 64 位最大值）。 */
export const MAX_BINDABLE_BIGINT = 9_223_372_036_854_775_807n;

/**
 * 把契约字符串解析成可安全绑定的 `bigint`。
 *
 * @returns 合法且未超界时返回 `bigint`；否则 `null`
 */
export function toBindableId(value: string): bigint | null {
  if (!/^\d+$/.test(value)) return null;
  let parsed: bigint;
  try {
    parsed = BigInt(value);
  } catch {
    return null;
  }
  return parsed > MAX_BINDABLE_BIGINT ? null : parsed;
}
