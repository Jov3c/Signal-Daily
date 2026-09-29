/**
 * 字段长度上限 —— 逐条对齐 Prisma schema 的列宽。
 *
 * `contents.title` / `featured_items.custom_title` 是 `VarChar(700)`；
 * `custom_summary` 是 `Text`（放得下，但仍设上限防止一次写入几十 MB）。
 *
 * 截断而不是报错：自定义标题是**展示用**的，超长时截断比让整个请求 400
 * 更符合管理员的预期（他刚写完一段话）。
 */

/** `VarChar(700)`。 */
export const MAX_CUSTOM_TITLE_LENGTH = 700;

/** `Text` —— 取一个远大于任何合理摘要、又不会撑爆响应的数字。 */
export const MAX_CUSTOM_SUMMARY_LENGTH = 20_000;

/** 按**字符**截断（MySQL 的 `VarChar(n)` 数的是字符，不是字节）。 */
export function clampChars(value: string | null, max: number): string | null {
  if (value === null) return null;
  const codePoints = Array.from(value);
  return codePoints.length <= max ? value : codePoints.slice(0, max).join('');
}
