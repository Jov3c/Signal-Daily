/**
 * 读 `sources.config` 的取值助手。
 *
 * ── 为什么读取端也要这么小心 ────────────────────────────────────────
 * 写入侧（Agent 03 的 `buildSourceConfig`）保证了 config 是**全量快照**：
 * 该类型的每个键都显式写下。按理说读取端可以直接取。
 *
 * 但有两类 config 是写不进那个保证的：
 *   1. **Agent 01 的 seed 数据**：`{seed: true, seedNote: '...'}`，
 *      稀疏形状，没有业务键；
 *   2. **手工改库 / 将来 Agent 14 的迁移脚本**。
 *
 * 所以读取端一律走兜底值，**绝不假设键存在**。这不是防御性编程的洁癖：
 * 一条 `config.handle` 为 undefined 的 X 来源，症状是
 * 「这个账号一直采不到东西」，而不是任何一条报错。
 *
 * 兜底值的来源必须与写侧一致（`@signal/source-core` 的常量 / 文档默认值），
 * 否则会出现「写入端认为默认是 A、读取端认为是 B」的静默分叉。
 */

/** 读一个非空字符串；读不到返回 null（**不**返回空字符串）。 */
export function readConfigString(
  config: Record<string, unknown> | null,
  key: string,
): string | null {
  const value = config?.[key];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/** 读一个布尔；读不到用兜底值。 */
export function readConfigBoolean(
  config: Record<string, unknown> | null,
  key: string,
  fallback: boolean,
): boolean {
  const value = config?.[key];
  return typeof value === 'boolean' ? value : fallback;
}

/** 读一个整数；读不到或不是整数用兜底值。 */
export function readConfigInteger(
  config: Record<string, unknown> | null,
  key: string,
  fallback: number,
): number {
  const value = config?.[key];
  return typeof value === 'number' && Number.isInteger(value) ? value : fallback;
}

/** 读一个枚举值；不在允许集合里就用兜底值。 */
export function readConfigEnum<T extends string>(
  config: Record<string, unknown> | null,
  key: string,
  allowed: readonly T[],
  fallback: T,
): T {
  const value = config?.[key];
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}
