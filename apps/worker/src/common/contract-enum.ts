/**
 * Prisma 枚举 → `@signal/contracts` 枚举的**运行期收敛**（Worker 侧唯一实现）。
 *
 * ── 为什么需要这一层 ────────────────────────────────────────────────
 * 两套枚举取值相同，但在 TypeScript 里是两个互不兼容的 nominal 类型，
 * 直接赋值必然 TS2322。而 `as SourceType` 这种硬转是**错**的：
 * 库里一旦出现契约里没有的值（降级了 schema、或有人手工改库），
 * 硬转会让一个非法值一路走到适配器选择逻辑，最终表现成
 * 「没有为 SourceType NEW_THING 注册适配器」这种莫名其妙的错误，
 * 而不是「库里有个非法值」这个真正的原因。
 *
 * 所以在这里做一次**带运行期校验**的收敛：非法值当场抛。
 *
 * ── 为什么只有一份 ──────────────────────────────────────────────────
 * 本函数原先在 worker 里有三份逐字相同的副本
 *（`jobs/ai/enum-guard.ts`、`jobs/collectors/contract-enum.ts`、
 *  `jobs/content/contract-enum.ts`），三份都只做同一件事。
 * 现收敛到本文件；各 job 家族里那份「契约 ↔ Prisma」的**专属映射表**
 *（这部分是真的不同）仍留在各自模块内。
 *
 * ⚠ `apps/api/src/common/prisma/prisma-enums.ts` 里还有一份**跨 app 的**
 * 同名实现 —— 那是 API 进程里的一份，本轮不动（跨 app 共享需要走 `packages/`，
 * 已记入 CCR，属 Agent 14 的决策）。改这里的语义时请同步核对那一份。
 */

/**
 * 把数据库里的字符串收敛为契约枚举值。
 *
 * @param allowed 契约侧的运行期取值数组（如 `SOURCE_TIERS`）
 * @param value   数据库返回的值
 * @param label   出错信息里的可读名（如 `'SourceTier'`）
 */
export function toContractEnum<T extends string>(
  allowed: readonly T[],
  value: string,
  label: string,
): T {
  if ((allowed as readonly string[]).includes(value)) return value as T;
  throw new Error(`Unexpected ${label} value from database: ${value}`);
}
