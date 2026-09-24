/**
 * BIGINT 主键的字符串 ↔ bigint 转换（Worker 侧）。
 *
 * ── 为什么必须是这一个函数，而不是各处直接 `BigInt()` ────────────────
 * `docs/02`：DB 主键是 `BIGINT UNSIGNED`，API/队列里一律是 string。
 *
 * **① `BigInt('abc')` 会抛 `SyntaxError`。**
 * 队列载荷来自 Redis（可能被手工改过）、`sourceId` 来自 Agent 03 的
 * `fetch-now`。一个畸形值如果直接 `BigInt()`，会让采集任务以一个
 * 语法错误崩掉 —— 而不是「这个来源不存在，跳过」。
 *
 * **② 有符号 64 位的上界。**
 * `BigInt('18446744073709551615')` 本身是合法的无符号上限，但
 * **Prisma 把 JS `bigint` 按有符号 64 位绑定**，超过 `2^63-1` 会抛
 * `PrismaClientUnknownRequestError`。Agent 03 的独立审查实测确认了这一点
 * （`work/_agent03/repro-bigint-bound.mjs`），并为此提交了 CCR 第 8 项
 * 请求给 `common/prisma/bigint-id.ts` 补上界 —— 那份文件属 Agent 02，
 * 且位于 `apps/api`（worker 无法 import，见 `prisma.service.ts` 的说明）。
 *
 * 因此这里收口：超界一律返回 `null` → 调用方当作「不存在」，
 * **不产生 5xx 噪声**。等 Agent 02/14 在公共层修好之后，
 * 本文件应当整体删除并改为复用。
 */

/** 十进制无符号整数，最长 20 位。 */
const BIGINT_ID_PATTERN = /^\d{1,20}$/;

/**
 * 能被**驱动安全绑定**的上界（有符号 64 位最大值）。
 *
 * 不是 `BIGINT UNSIGNED` 的上限 —— 见文件头第 ② 条。
 */
export const MAX_BINDABLE_ID = 9_223_372_036_854_775_807n;

/** 合法的 BIGINT 字符串 → `bigint`；畸形或超界返回 `null`。 */
export function toBindableId(value: string): bigint | null {
  if (!BIGINT_ID_PATTERN.test(value)) return null;
  const id = BigInt(value);
  return id > MAX_BINDABLE_ID ? null : id;
}
