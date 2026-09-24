/**
 * 采集用的哈希工具。
 *
 * `docs/03` 与 Agent 01 的 schema 把 `raw_items.canonical_url_hash` /
 * `content_hash` 定为 `Char(64)`，并约定存 **SHA-256 十六进制小写**。
 * `EventEvidence.url_hash` 同理 —— 这是 `docs/03`「避免 MySQL 超长 URL
 * unique 问题」的落地方案。
 *
 * 因此这里只允许产出一个形状：64 位小写十六进制。写成函数而不是各处
 * `createHash('sha256')` 散落，是为了让「大小写不统一导致去重失效」
 * 这类问题不可能发生（去重全靠等值比较：一个大写一个就会全部漏判）。
 */

import { createHash } from 'node:crypto';

/** 产出 SHA-256 十六进制小写（64 字符）。 */
export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * 正文的**归一化内容哈希**（`docs/06` 幂等三键的第三个）。
 *
 * 归一化只做**空白折叠**，刻意不做大小写折叠或标点归一：
 * 那会让「同一句话换了大小写」被判为同一条内容，而原文差异是编辑判断的依据。
 * 折叠空白解决的是真实存在的噪声 —— 同一篇文章经不同 CDN / 模板渲染后
 * 换行与缩进不同，内容其实一模一样。
 */
export function contentHashOf(title: string | null, body: string | null): string {
  const normalizedTitle = collapseWhitespace(title ?? '');
  const normalizedBody = collapseWhitespace(body ?? '');
  return sha256Hex(`${normalizedTitle}\n${normalizedBody}`);
}

/**
 * 把连续空白折叠成单个半角空格并去首尾。
 *
 * 用 `\s` 就够：JavaScript 的 `\s` 已经覆盖 U+00A0（nbsp）、
 * U+2000–U+200A、U+3000（全角空格）与 U+FEFF（BOM）。
 *
 * 刻意**不在正则里写字面量**：那些字符在源码里看不见，
 * 一旦被编辑器或格式化工具换成半角空格，行为就变了而没有任何东西会报错。
 */
export function collapseWhitespace(input: string): string {
  return input.replace(/\s+/g, ' ').trim();
}
