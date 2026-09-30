/**
 * 模块边界上的 BIGINT id 收敛。
 *
 * ⚠ 上界已经在**源头**修掉了（`common/prisma/bigint-id.ts` 的
 * `MAX_BINDABLE_ID`，2026-09-29 修复）。此前它是四份重复实现的成因
 * （Agent 03 / 07 / 09 各在自己的边界上又收了一次）。
 *
 * 这里保留具名函数只为让调用点有语境（`toPublicReadId` 比 `toBigIntId`
 * 更说明意图），**不做任何额外的事**。
 */

import { toBigIntId } from '../../common/prisma/bigint-id';

export { MAX_BINDABLE_ID } from '../../common/prisma/bigint-id';

/** 把对外 id 字符串收敛成可安全绑定的 `bigint`；畸形或超界返回 `null`。 */
export function toPublicReadId(value: string): bigint | null {
  return toBigIntId(value);
}
