/**
 * 运行期枚举收敛（**从库里读出来的值 → 契约枚举**）。
 *
 * 与 `apps/api/src/common/prisma/prisma-enums.ts` 同一函数、同一理由：
 * 「库里出现了契约里没有的值」应当在边界立刻炸掉，
 * 而不是带着一个非法的 tier 一路走进 credibility 判断。
 *
 * ⚠ 与 `contract-enum.ts` 一样，这是一份跨 app 重复实现，
 * 已按 §7 记入 HANDOFF，建议 Agent 14 提到共享包。
 *
 * 与 `contract-enum.ts` 的分工：
 *   - `contract-enum.ts` 用**显式映射表**做「契约 → Prisma」的方向（写入路径）；
 *   - 本文件用**白名单数组**做「Prisma → 契约」的方向（读取路径）——
 *     读取时我们手上没有编译期的 Prisma 枚举类型可用（值是 `string`），
 *     只能按运行期白名单校验。
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
