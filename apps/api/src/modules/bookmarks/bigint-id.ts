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

/**
 * 把对外 id 字符串收敛成可安全绑定的 `bigint`。
 *
 * ⚠ **上界已经在源头修掉了**（`common/prisma/bigint-id.ts` 的 `MAX_BINDABLE_ID`，
 * Agent 09 的 CCR 第 0 项 —— 那条上报了四次）。这里保留这个具名函数只是为了让
 * 调用点读起来有语境（`toBookmarkContentId` 比 `toBigIntId` 更说明意图），
 * **它不再做任何额外的事**。
 *
 * 历史：在这个洞被修掉之前，Agent 03 的 `toSourceId`、Agent 07 的 `toReviewId`、
 * 本函数与 `reading-progress` 的 `toResourceId` **各自实现了一遍上界检查** ——
 * 四份重复就是「没在源头修」的代价。
 */
export function toBookmarkContentId(value: string): bigint | null {
  return toBigIntId(value);
}

export { MAX_BINDABLE_ID } from '../../common/prisma/bigint-id';
