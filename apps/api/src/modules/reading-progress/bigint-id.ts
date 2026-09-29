/**
 * 模块边界上的 BIGINT id 收敛。
 *
 * ⚠ 与 `modules/bookmarks/bigint-id.ts` 是**同一件事的第二份**。
 * 为什么不合一份：它只有 8 行，而跨模块 import 会把两个模块的生命周期绑在一起
 * （Agent 02/07 对 `clock.ts` 的同一取舍）。两份的理由与那三处「缺上界的
 * `toBigIntId`」是同一个 —— **`common/prisma/bigint-id.ts` 缺上界这件事
 * 已经被报了四次**（Agent 03 CCR 第 8 项、Agent 07、Agent 09 的 bookmarks
 * 与本文件）。§9 不许我改 Agent 02 的文件，所以只能在自己的边界上各收一次。
 *
 * 后果与修法见 `modules/bookmarks/bigint-id.ts` 的注释（那里写得最详细）。
 */

import { toBigIntId } from '../../common/prisma/bigint-id';

/** Prisma 能安全绑定的上界（有符号 64 位最大值）。 */
export const MAX_BINDABLE_ID = 9_223_372_036_854_775_807n;

/** 把对外 id 字符串收敛成可安全绑定的 `bigint`；超界或畸形返回 `null`。 */
export function toResourceId(value: string): bigint | null {
  const parsed = toBigIntId(value);
  if (parsed === null || parsed > MAX_BINDABLE_ID) return null;
  return parsed;
}
