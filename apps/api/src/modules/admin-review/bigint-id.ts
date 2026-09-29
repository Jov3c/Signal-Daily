/**
 * 模块边界上的 BIGINT id 收敛。
 *
 * ⚠ **这是对 `common/prisma/bigint-id.ts` 的补充，不是重复实现。**
 *
 * `toBigIntId()` 只校验「20 位以内的十进制数字」，**没有上界**。
 * 而 Prisma 把 JS `bigint` 按**有符号** 64 位绑定：任何超过 `2^63-1` 的值
 * （**包括合法的无符号上限 `18446744073709551615` 本身**）都会让驱动抛
 * `PrismaClientUnknownRequestError`。
 *
 * 后果：`GET /admin/review/18446744073709551615` 会返回 **500 而不是 404**，
 * 污染 5xx 告警。
 *
 * 这个问题 **Agent 03 已经发现并提了 CCR 第 8 项**（它在本模块边界上
 * 用 `toSourceId` 绕过了同一件事），但**至今未裁决** —— 那个文件属 Agent 02，
 * §9 不允许我越界修改，所以我在自己的边界上再收一次。
 *
 * 超界的 id 一律当作「**不存在**」（→ 404）而不是「非法输入」（→ 400）：
 * 对调用方而言这两者没有区别，而 404 不会产生 5xx 噪声。
 *
 * 真库集成测试 `admin-review-db.integration.spec.ts` 里有一条直接断言
 * 「超界 id 被忽略而不是抛驱动层异常」。
 */

/** Prisma 能安全绑定的上界（有符号 64 位最大值）。 */
export const MAX_BINDABLE_ID = 9_223_372_036_854_775_807n;

/**
 * 把对外 id 字符串收敛成可安全绑定的 `bigint`。
 *
 * @returns 合法且未超界时返回 `bigint`；否则 `null`
 */
export function toReviewId(value: string): bigint | null {
  if (!/^\d{1,20}$/.test(value)) return null;
  const parsed = BigInt(value);
  return parsed > MAX_BINDABLE_ID ? null : parsed;
}
