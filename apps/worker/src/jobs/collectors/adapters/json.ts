/**
 * 外部 JSON 的取值助手。
 *
 * 外部 JSON 是**不可信输入**：上游随时可以改字段、把数字改成字符串、
 * 把对象改成 null。用 `as SomeType` 硬转的话，这些变化不会在转换处报错，
 * 而是在几十行之后以一个莫名其妙的 `TypeError` 炸出来，
 * 或者更糟 —— 静默写出一条内容全错的数据。
 *
 * 所以每个取值都过一遍类型检查，取不到就返回 `null` / 默认值。
 * 这不"啰嗦"，它是采集器唯一能保持长期可用的方式：
 * 上游改一个字段，最好的结果是这条内容降级（标题为 null），
 * 而不是整个来源从此采集失败。
 */

export function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** 字符串字段：非字符串一律当作取不到（**不**把数字转成字符串，见下）。 */
export function asString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * 上游把 id 写成数字时的字符串化。
 *
 * 单独一个函数是因为这个转换必须是**显式**的：`asString` 刻意不自动转数字，
 * 否则「这个字段本该是字符串」这类上游契约变化会被无声吞掉。
 * 而 id 字段确实经常是数字（HN 的 `id`、GitHub 的 release `id`），
 * 这里明确说明「我们知道它是数字，按十进制转」。
 */
export function asIdString(value: unknown): string | null {
  if (typeof value === 'string' && value !== '') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

export function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function asBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

/** 取嵌套字段：`pick(obj, 'data', 'id')`。任一层不是对象就返回 null。 */
export function pick(value: unknown, ...path: string[]): unknown {
  let current: unknown = value;
  for (const key of path) {
    const record = asObject(current);
    if (record === null) return null;
    current = record[key];
  }
  return current;
}

/** `pick(...)` 的字符串版。 */
export function pickString(value: unknown, ...path: string[]): string | null {
  return asString(pick(value, ...path));
}

/**
 * 解析时间字段，兼容两种真实写法：
 *   - ISO 8601（GitHub / HF / X：`2026-09-23T18:21:37Z`）；
 *   - Unix 秒（HN 的 `time`：`1790210491`）。
 *
 * `new Date(1790210491)` 会被当成**毫秒**解析成 1970 年，
 * 那是个不会报错但结果全错的情形 —— 所以必须先按数字判一次。
 */
export function asDate(value: unknown): Date | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    // 秒级时间戳的合理范围（2001 年之后、2100 年之前）。毫秒级时间戳
    // 在这个量级上是 1970 年附近，因此不会被误判。
    const ms = value < 100_000_000_000 ? value * 1_000 : value;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return null;
}

/** 只保留 JSON 可安全序列化的标量，用于构造 `RawItem.payload`。 */
export function compactPayload(entries: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entries)) {
    if (value === undefined || value === null) continue;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      out[key] = value;
      continue;
    }
    if (Array.isArray(value)) {
      const scalars = value.filter(
        (item): item is string | number | boolean =>
          typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean',
      );
      if (scalars.length > 0) out[key] = scalars;
    }
  }
  return out;
}
