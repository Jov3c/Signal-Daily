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
 * 后果：`POST /bookmarks/18446744073709551615` 返回 **500 而不是 404**，
 * 污染 5xx 告警 —— 而调用方只是点了一个畸形的链接。
 *
 * ── ⚠ 这个洞已经被报了**三次**，这是第四次 ──────────────────────────
 * Agent 03（其 CCR 第 8 项）、Agent 07（其 CCR 重申）、以及本模块。
 * `common/prisma/bigint-id.ts` 属 Agent 02，§9 不允许我越界修改，
 * 所以我只能在自己的边界上再收一次 —— 与 Agent 03 的 `toSourceId`、
 * Agent 07 的 `toReviewId` 同一个做法。**CCR 里再重申一次。**
 *
 * 超界的 id 一律当作「**不存在**」（→ 404）而不是「非法输入」（→ 400）：
 * 对调用方而言两者没有区别，而 404 不产生 5xx 噪声。
 */

import { toBigIntId } from '../../common/prisma/bigint-id';

/** Prisma 能安全绑定的上界（有符号 64 位最大值）。 */
export const MAX_BINDABLE_ID = 9_223_372_036_854_775_807n;

/**
 * 把对外 id 字符串收敛成可安全绑定的 `bigint`。
 *
 * @returns 合法且未超界时返回 `bigint`；否则 `null`
 */
export function toBookmarkContentId(value: string): bigint | null {
  const parsed = toBigIntId(value);
  if (parsed === null || parsed > MAX_BINDABLE_ID) return null;
  return parsed;
}
