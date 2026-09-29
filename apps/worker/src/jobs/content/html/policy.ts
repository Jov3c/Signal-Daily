/**
 * HTML 清洗策略 —— `docs/14` 的「HTML」一节的逐条落地。
 *
 * `docs/14` 原文要求：
 *
 * ```text
 * 服务端 sanitize：
 *   删除 script
 *   删除 event handler
 *   iframe 默认删除
 *   style 白名单
 *   URL scheme 白名单
 * 前端不得渲染未清洗 HTML。
 * ```
 *
 * ── 为什么用库而不是自己写 ──────────────────────────────────────────
 * 手写 HTML sanitizer 是典型的「看起来能用的漏洞制造机」：
 * 标签嵌套、属性解析歧义、实体双重编码、mXSS、命名空间混淆……
 * 每一条都出过真实的 CVE。本仓库自己也有先例 —— Agent 04 的
 * `stripTags` 用 `/<[^>]*>/g` 在「含 `<` 无 `>`」的输入上是 O(n²)、
 * 同步阻塞事件循环（§23 审查的 P1）。
 *
 * 所以这里用 `sanitize-html`（allowlist 模型、长期维护、被广泛使用），
 * **本文件只负责声明策略，不负责解析**。
 *
 * ── 清洗点在哪（Agent 04 的交接）────────────────────────────────────
 * Agent 04 的 HANDOFF「给 Agent 05」第 ① 条明确：
 * 「`docs/14`『前端不得渲染未清洗 HTML』的清洗点**在 Pipeline 的 Normalize**」。
 * 因此 `Content.bodyOriginal` 存的是**已清洗的 HTML**，而不是原始抓取事实
 * （原始事实留在 `RawItem.bodyRaw`，可追溯、可重新清洗）。
 */

import type { IOptions } from 'sanitize-html';

/**
 * 允许保留的标签。
 *
 * 取「一篇长文需要的结构」这一档，**不是**通用富文本编辑器那一档 ——
 * 白名单越小，攻击面越小，而阅读产品不需要表单、嵌入、媒体播放器。
 *
 * 刻意**不在**表里的（`docs/14` 逐条对应）：
 * - `script` / `style` —— 可直接执行或改版式；
 * - `iframe` / `object` / `embed` —— 默认删除（docs/14 明写）；
 * - `form` / `input` / `button` —— 正文里没有理由出现表单；
 * - `svg` / `math` —— 命名空间混淆类 XSS 的重灾区，且正文用不到。
 */
export const ALLOWED_TAGS: readonly string[] = [
  'p',
  'br',
  'hr',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'blockquote',
  'pre',
  'code',
  'strong',
  'b',
  'em',
  'i',
  'u',
  's',
  'sub',
  'sup',
  'span',
  'a',
  'img',
  'figure',
  'figcaption',
  'ul',
  'ol',
  'li',
  'dl',
  'dt',
  'dd',
  'table',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'th',
  'td',
  'caption',
];

/**
 * 允许保留的属性。
 *
 * 注意 **`*` 上没有任何属性** —— 这是刻意的：
 * 任何标签上的 `on*`（事件处理器）都进不来，
 * 不需要逐个列举「要禁掉哪些危险属性」。
 * 「默认全禁 + 逐个放开」永远优于「默认放行 + 列黑名单」。
 *
 * ── `style` 为什么只加在这几个标签上 ────────────────────────────────
 * `docs/14` 要求「style 白名单」，而**属性必须先在 `allowedAttributes` 里
 * 放行、`allowedStyles` 才有机会生效** —— 这两处漏一个，`style` 就会被
 * 整条剥掉（第一版就是这样：`allowedStyles` 写了 `text-align`，
 * 但没在任何标签上放行 `style`，于是正文里的居中对齐全部消失）。
 *
 * 只加在**块级排版标签**上，而不是 `'*'`：`style` 放在 `<a>` / `<img>` 上
 * 没有实际排版意义，却会扩大解析面。能少一处就少一处。
 */
export const ALLOWED_ATTRIBUTES: IOptions['allowedAttributes'] = {
  // `rel` / `target` 必须放行，否则 `transformTags` 加上去的链接加固
  // 会在同一次清洗里被剥掉 —— 第一版就是这么翻车的。
  a: ['href', 'title', 'rel', 'target'],
  img: ['src', 'alt', 'title', 'width', 'height'],
  td: ['colspan', 'rowspan', 'style'],
  th: ['colspan', 'rowspan', 'scope', 'style'],
  p: ['style'],
  h1: ['style'],
  h2: ['style'],
  h3: ['style'],
  h4: ['style'],
  h5: ['style'],
  h6: ['style'],
  blockquote: ['style'],
  figcaption: ['style'],
  li: ['style'],
};

/**
 * URL scheme 白名单（`docs/14`）。
 *
 * `sanitize-html` 会用这张表校验 `href` / `src`，
 * 因此 `javascript:` / `data:` / `vbscript:` 一律被剥掉。
 *
 * 刻意**不含 `data:`**：内联 data URI 可以是一条正文里塞几百 KB 的
 * base64 图片，既撑大数据库也撑大前端响应；正文里的图片走外链即可。
 */
export const ALLOWED_SCHEMES: readonly string[] = ['http', 'https', 'mailto'];

/** 允许的相对 URL（站内相对链接）。 */
export const ALLOW_RELATIVE_URLS = true;

/**
 * 这些标签**连同内容一起丢弃**（而不是「丢标签留文字」）。
 *
 * `script` / `style` 的内容是代码，留下会变成正文里的乱码；
 * `nav` / `footer` / `aside` / `form` 的内容是站点导航与页脚，
 * 留下会把「关于我们 / 隐私政策 / 登录」混进文章正文。
 *
 * ⚠ 这是**替代不了正文提取**的兜底手段 —— 见 `extract.ts`。
 */
export const NON_TEXT_TAGS: readonly string[] = [
  'script',
  'style',
  'textarea',
  'option',
  'noscript',
  'template',
  'iframe',
  'object',
  'embed',
  'svg',
  'canvas',
  'nav',
  'footer',
  'aside',
  'form',
  'button',
  'select',
  'input',
];

/**
 * style 属性的白名单（`docs/14` 的「style 白名单」）。
 *
 * ⚠ 这是**刻意收得极窄**的一处设计取舍：`docs/14` 要求「style 白名单」，
 * 而样式属性是 CSS 注入 / 视觉欺骗（把文字设成透明、覆盖整页）的载体。
 * 阅读产品真正需要的只有「居中 / 右对齐」这一类排版意图，
 * 因此只放行 `text-align`，其余（`position` / `z-index` / `display` /
 * `background-image` …）一概不解析。
 *
 * 若产品后续确实需要更丰富的富文本样式，应当在这里**逐条**加，
 * 而不是把 `style` 整个放开。
 */
export const ALLOWED_STYLES: IOptions['allowedStyles'] = {
  '*': {
    'text-align': [/^(left|right|center|justify)$/],
  },
};

/** 把 `docs/14` 的策略组装成 `sanitize-html` 的选项对象。 */
export function buildSanitizeOptions(): IOptions {
  return {
    allowedTags: [...ALLOWED_TAGS],
    allowedAttributes: ALLOWED_ATTRIBUTES,
    allowedSchemes: [...ALLOWED_SCHEMES],
    allowedSchemesAppliedToAttributes: ['href', 'src'],
    allowProtocolRelative: false,
    allowedStyles: ALLOWED_STYLES,
    // 未在白名单里的标签：丢标签、**留下文字**（默认行为）。
    disallowedTagsMode: 'discard',
    // 这几种：连内容一起丢。
    nonTextTags: [...NON_TEXT_TAGS],
    // 不做「把 & 转义成 &amp;」之外的实体改写；正文里的中文与标点原样保留。
    parser: { lowerCaseTags: true, lowerCaseAttributeNames: true },
  };
}

/**
 * 链接统一加固：外链强制 `rel="noopener noreferrer"` + `target="_blank"`。
 *
 * 理由不是洁癖：`target="_blank"` 而不带 `noopener` 时，
 * 被打开的页面可以通过 `window.opener` 反向操作我们的页面
 *（把 Signal 标签页导航到钓鱼站）。这是阅读产品里最常见的一处小问题。
 */
export const LINK_HARDENING = {
  target: '_blank',
  rel: 'noopener noreferrer',
} as const;
