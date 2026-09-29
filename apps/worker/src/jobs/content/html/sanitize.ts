/**
 * HTML 清洗的执行层 —— 策略在 `policy.ts`，本文件只负责「调用 + 兜底」。
 *
 * 输出约定：**清洗后的 HTML**，可安全交给前端渲染（`docs/14`）。
 * 原始抓取事实留在 `RawItem.bodyRaw`，所以策略将来变严时
 * 可以重新清洗历史数据，不需要重新抓取。
 */

import sanitizeHtml from 'sanitize-html';
import { LINK_HARDENING, buildSanitizeOptions } from './policy';

/**
 * 单次清洗的输入上限（字符）。
 *
 * 采集端对 Manual URL 已限制到 200k（`MANUAL_URL_BODY_LIMIT`），
 * 这里是**第二道闸**：清洗是同步的 CPU 工作，若某天有来源给出
 * 几十 MB 的正文，它会在 worker 线程里阻塞事件循环 ——
 * 而同一个进程里还跑着 `collector`（并发 5）与调度器。
 *
 * 取 400k：明显高于正常文章（中文长文也就几十 KB），
 * 又不足以让一次清洗变成可感知的停顿。
 */
export const MAX_SANITIZE_INPUT_CHARS = 400_000;

/** 被截断时附加的说明（让读者知道正文不完整，而不是以为原文就这么长）。 */
export const SANITIZE_TRUNCATION_MARKER = '\n<p>（正文过长，已截断）</p>';

/**
 * 清洗一段 HTML，返回可渲染的安全 HTML。
 *
 * - `null` / 空串 → `null`（**不是** `''`：空正文在库里应当是 NULL，
 *   这样「没有正文」与「正文是空字符串」在数据上可区分）
 * - 清洗后只剩空白 → `null`（去掉标签后没有内容的 HTML 没有意义）
 * - 解析异常 → 抛错，由调用方决定是记 `FAILED` 还是重试；
 *   **不静默返回原文**（那等于清洗失败时把未清洗的内容放行）
 */
export function sanitizeArticleHtml(html: string | null): string | null {
  if (html === null) return null;

  const input = html.length > MAX_SANITIZE_INPUT_CHARS ? html.slice(0, MAX_SANITIZE_INPUT_CHARS) : html;
  const truncated = input.length !== html.length;

  const options = buildSanitizeOptions();
  const cleaned = sanitizeHtml(input, {
    ...options,
    // 外链加固（见 policy.ts 的 LINK_HARDENING 说明）
    transformTags: {
      a: (tagName, attribs) => ({
        tagName,
        attribs: { ...attribs, ...LINK_HARDENING },
      }),
    },
  });

  if (!hasSubstantiveContent(cleaned)) return null;
  return truncated ? cleaned + SANITIZE_TRUNCATION_MARKER : cleaned;
}

/**
 * 判断一段清洗后的 HTML 是否还有实质内容。
 *
 * 判据是「去掉全部标签后还剩不剩文字」**或**「有没有图片」，
 * 而不是看字符串长度 —— `<p></p><p>  </p>` 有长度但没有内容。
 *
 * ⚠ 图片要单独算一类：`docs/00` 允许 X 的图片帖这类**没有正文文字**的内容，
 * 只按文字判断会把它们整条丢掉。
 */
export function hasSubstantiveContent(html: string | null): boolean {
  if (html === null) return false;
  if (/<img\s/i.test(html)) return true;
  return sanitizeHtml(html, { allowedTags: [], allowedAttributes: {} }).trim() !== '';
}
