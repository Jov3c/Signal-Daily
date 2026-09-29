/**
 * HTML → 纯文本投影。
 *
 * ── 为什么需要它 ───────────────────────────────────────────────────
 * `Content.bodyOriginal` 存的是**清洗后的 HTML**（前端要渲染段落与链接）。
 * 但下游有两处需要**纯文本**：
 *
 * 1. **AI prompt**（Agent 06 的 `AiContentInput.body`）——
 *    把 `<p>` 标签送进模型是纯噪声，白花 token（而预算是 5 美元/天）；
 * 2. **标题 / 摘要 / 搜索索引 / 日志**——都不该看见标签。
 *
 * ── ⚠ 为什么不能用 `sanitizeHtml(x, { allowedTags: [] })` ────────────
 * 第一版就是这么写的，**它是错的**。`sanitize-html` 的职责是产出
 * 「安全的 **HTML**」，因此它会老老实实把 `&` `<` `>` 重新转义：
 *
 * ```text
 * sanitizeHtml('AT&amp;T', {allowedTags: []})  →  'AT&amp;T'   ← 还是实体
 * sanitizeHtml('&#20013;&#25991;', …)          →  '中文'       ← 数字实体反而解了
 * ```
 *
 * 于是标题里会出现字面的 `&amp;`，AI 收到的正文里也全是 `&amp;`。
 * **纯文本要的是解码后的字符**，不是 HTML 的安全表示 —— 这两件事的目标不同。
 *
 * ── 为什么不用 Agent 04 的 `toPlainText` ────────────────────────────
 * 那个在 `jobs/collectors/text/markup.ts`，是**采集端**处理「刚抓下来、
 * 还没清洗的」外部 HTML 用的。两条理由不复用：
 * 1. 跨模块 import 会把两个模块的生命周期绑在一起（Agent 03 在 `clock.ts`
 *    上留过同样的判断）；
 * 2. 更实际的是**输入不同**：那个要面对任意外部 HTML（未闭合标签、畸形嵌套），
 *    而这里的输入**已经过 `sanitize-html` 归一化**，标签闭合、属性白名单内。
 *    用同一套「防御畸形输入」的启发式反而是错配。
 *
 * ── 输入是可信的 ────────────────────────────────────────────────────
 * 传入的 HTML 必须是**已经清洗过**的（本模块的 `sanitizeArticleHtml`）。
 * 这里只解析并取文本，不做任何安全判断 —— `textContent` 取到的是数据，
 * 不是标记，所以不存在注入面。
 */

import { DomUtils, parseDocument } from 'htmlparser2';
import { MAX_SANITIZE_INPUT_CHARS } from './sanitize';

/** 纯文本投影的输出上限（字符）—— 与 `MAX_INPUT_CHARS.TRANSLATE` 同量级。 */
export const MAX_PLAIN_TEXT_CHARS = 200_000;

/** 块级元素结束处补换行，否则相邻段落会粘成一行。 */
const BLOCK_END = /<\/(p|div|section|li|h[1-6]|blockquote|tr|figcaption|article|main)>/gi;
const LINE_BREAK = /<br\s*\/?>/gi;

/**
 * 把（**已清洗的**）HTML 转成纯文本。
 *
 * - 块级元素之间补空行：`<p>a</p><p>b</p>` → `"a\n\nb"`；
 * - 实体解码成真实字符（`&amp;` → `&`，`&#20013;` → `中`）；
 * - 连续空白折叠、首尾去空白；
 * - `null` / 空 → `null`。
 */
export function htmlToPlainText(html: string | null): string | null {
  if (html === null) return null;

  const input = html.length > MAX_SANITIZE_INPUT_CHARS ? html.slice(0, MAX_SANITIZE_INPUT_CHARS) : html;
  const withBreaks = input.replace(LINE_BREAK, '\n').replace(BLOCK_END, '\n\n');

  // 解析后取 textContent：**这一步才是实体解码**（`&amp;` → `&`）。
  const text = DomUtils.textContent(parseDocument(withBreaks));

  const normalized = text
    // 折叠行内空白（保留换行）
    .replace(/[^\S\n]+/g, ' ')
    // 三个以上换行折成两个（段落间距）
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (normalized === '') return null;
  return normalized.length > MAX_PLAIN_TEXT_CHARS
    ? normalized.slice(0, MAX_PLAIN_TEXT_CHARS)
    : normalized;
}
