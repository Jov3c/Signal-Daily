/**
 * 把任意对象收敛成 Prisma 能接受的 JSON 值。
 *
 * ── 为什么需要它 ────────────────────────────────────────────────────
 * Prisma 的 `Json` 列（`raw_items.payload` / `job_runs.metadata`）
 * 要求 `InputJsonValue`，而 TypeScript 只会告诉我们「`Record<string, unknown>`
 * 不满足它」—— 这个报错**方向是对的**，因为 Prisma 运行期还要求：
 *
 *   - **不允许 `undefined`**（嵌套的也不行）。一个 `{a: undefined}` 会让
 *     `create()` 在运行期抛错，而那个错发生在写库那一刻，
 *     离产生这个对象的地方很远，极难定位；
 *   - 不允许 `BigInt`、`Date`、函数、类实例 —— 它们都不是 JSON 类型
 *     （`Date` 会被静默转成字符串，而 `BigInt` 直接抛）。
 *
 * 与其到处 `as Prisma.InputJsonValue` 把这些问题压下去，不如在这里
 * **真正**做一次 JSON 往返：往返之后的形状一定可序列化，而
 * 不能序列化的值（BigInt / 函数）会**当场**抛错，位置清晰。
 *
 * ⚠ 代价要写清楚：**`Date` 会变成 ISO 字符串，`undefined` 键会被丢掉**。
 * 这正是我们想要的（JSON 列本来就只能存这些），但调用方必须知道 ——
 * 所以原始时间仍然存在 `DateTime` 列上（`published_at` / `fetched_at`），
 * payload 里只放展示用的元数据。
 */

/**
 * JSON 往返。抛错即表示调用方放进了不可序列化的值 ——
 * 这是**期望行为**，让缺陷在最靠近源头的地方暴露。
 */
export function toJsonValue(value: Record<string, unknown>): Record<string, unknown> {
  // `JSON.stringify` 对一个**对象**参数只会返回 string 或抛错（BigInt、
  // 循环引用），永远不会返回 undefined —— 所以不需要「返回 undefined」
  // 的分支（它曾经存在，但不可达、也没有任何测试覆盖）。
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}
