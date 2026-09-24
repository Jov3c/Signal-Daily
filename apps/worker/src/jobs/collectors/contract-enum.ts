/**
 * Prisma 枚举 ↔ `@signal/contracts` 枚举的桥接（Worker 侧）。
 *
 * ── 为什么必须有这一层 ──────────────────────────────────────────────
 * 两套枚举**取值完全相同**（Agent 01 有守卫测试保证），但在 TypeScript 里
 * 是两个互不兼容的 nominal 类型，直接赋值必然 TS2322。
 *
 * 而 `as SourceType` 这种硬转是**错**的：库里一旦出现契约里没有的值
 * （比如将来降级了 schema、或有人手工改库），硬转会让一个非法的
 * `SourceType` 一路走到适配器选择逻辑里，最终表现成
 * 「没有为 SourceType NEW_THING 注册适配器」这种莫名其妙的错误，
 * 而不是「库里有个非法值」这个真正的原因。
 *
 * 所以在仓储边界做一次**带运行期校验**的收敛，非法值当场抛。
 *
 * ── 与 `apps/api` 的同名函数的关系 ──────────────────────────────────
 * `apps/api/src/common/prisma/prisma-enums.ts` 有同样的实现，但它在 API 的
 * 进程里（见 `prisma.service.ts` 的说明）。这里只保留 worker 真正用到的
 * 那几个枚举 —— 不是复制整个文件，而是只取需要的部分。
 */

/**
 * 把 Prisma 的枚举值收敛为契约枚举值。
 *
 * @param allowed 契约侧的运行期取值数组（如 `SOURCE_TYPES`）
 * @param value   Prisma 返回的值
 * @param label   出错信息里的人类可读名（如 `'SourceType'`）
 */
export function toContractEnum<T extends string>(
  allowed: readonly T[],
  value: string,
  label: string,
): T {
  if ((allowed as readonly string[]).includes(value)) return value as T;
  throw new Error(`Unexpected ${label} value from database: ${value}`);
}
