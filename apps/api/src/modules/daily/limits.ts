/**
 * 日报编辑的字段与规模上限 —— 逐条对齐 Prisma schema 的列宽与 `docs/10` 的结构约束。
 *
 * 与 Agent 02/03/07 同一取舍：**截断而不是报错**（对展示字段），
 * **报错而不是静默忽略**（对结构性错误）。
 */

/** `daily_sections.title` 是 `VarChar(255)`。 */
export const MAX_SECTION_TITLE_LENGTH = 255;

/** `daily_items.custom_headline` 是 `VarChar(700)`（与 `contents.title` 同宽）。 */
export const MAX_CUSTOM_HEADLINE_LENGTH = 700;

/** `daily_editions.headline` 是 `VarChar(700)`。 */
export const MAX_EDITION_HEADLINE_LENGTH = 700;

/**
 * `custom_excerpt` 是 `Text`（放得下），但仍设上限防止一次写入几十 MB。
 * 取一个远大于任何合理摘要、又不会撑爆响应的数字。
 */
export const MAX_CUSTOM_EXCERPT_LENGTH = 20_000;

/**
 * 版块数上限。
 *
 * `DailySectionType` 恰好 7 个取值（`docs/10` 的「默认版块」），
 * 而**同一期不允许出现两个同类型版块** —— 否则前台要么二选一、要么并列渲染，
 * 两种都不是 `docs/10` 描述的结构。7 因此是上限，也是「每种恰好一个」的上界。
 */
export const MAX_SECTIONS = 7;

/**
 * 单个版块的条目数上限。
 *
 * `docs/10` 只给了 `X_VOICES` 的 5–10 条，没有给其他版块的上限。
 * 40 是**防止一次写入无界**的护栏，不是产品规则：一天的候选量级是几十条，
 * 超过 40 条同版块几乎必然意味着误操作。
 */
export const MAX_ITEMS_PER_SECTION = 40;

/**
 * 按**字符**截断（MySQL 的 `VarChar(n)` 数的是字符，不是字节）。
 *
 * 用 `Array.from` 而不是 `slice`：`slice` 按 UTF-16 码元切，
 * 会把一个 emoji 的代理对劈成两半，存进库就是一个非法字符串。
 */
export function clampChars(value: string | null, max: number): string | null {
  if (value === null) return null;
  const codePoints = Array.from(value);
  return codePoints.length <= max ? value : codePoints.slice(0, max).join('');
}
