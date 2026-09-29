/**
 * 正文区域提取 —— 把「一整张网页」收敛成「这篇文章」。
 *
 * ── 为什么需要它 ───────────────────────────────────────────────────
 * 采集端对不同来源给出的 `bodyRaw` **形态完全不同**：
 *
 * | 来源 | `bodyRaw` 是什么 |
 * | ---- | ---------------- |
 * | RSS / X / HN / GitHub / HF | **已经是文章级**（feed 的 `content:encoded`、推文正文…） |
 * | MANUAL_URL | **整页 HTML**（`result.body.slice(0, 200k)`，含 `<head>` / 导航 / 页脚 / 广告） |
 *
 * 如果对 MANUAL_URL 不做提取就把整页写进 `contents.body_original`，
 * 读者看到的文章会以「关于我们 / 隐私政策 / 登录」结尾。
 *
 * ── 这是启发式，不是 readability ────────────────────────────────────
 * 真正的正文提取（Mozilla Readability 那一类）需要打分模型 + 大量启发式，
 * 是几百行且需要持续调优的东西。V1 刻意只做**保守的容器选择**：
 * 优先语义标签，取不到就退回 `<body>`，再取不到就当片段处理。
 *
 * **取舍已记入 HANDOFF**：对结构良好的站点（有 `<article>` / `<main>`）
 * 效果正确；对没有语义标签的老式页面，提取结果约等于「整个 body」。
 * 这是**已知的、有界的**不足 —— 比引入一个几百行的打分模型更划算，
 * 而且失败方向是「多留一些内容」而不是「丢内容」。
 *
 * ── 为什么用 htmlparser2 ────────────────────────────────────────────
 * 它本来就是 `sanitize-html` 的内部依赖（不扩大依赖面），
 * 自带 `DomUtils.findOne` / `getInnerHTML`，够用。
 * **不手写标签扫描**：本仓库刚在 Agent 04 的 `stripTags` 上栽过
 * 「正则解析 HTML」的坑（O(n²) 阻塞事件循环）。
 */

import { DomUtils, parseDocument } from 'htmlparser2';

/**
 * 节点类型。
 *
 * ⚠ 用 `Parameters<>` **推导**而不是 `import { AnyNode } from 'htmlparser2'`：
 * v10 不再直接导出 `AnyNode` / `Element`（它们属于 `domhandler`），
 * 而 `domhandler` 在 pnpm 的严格 node_modules 布局下**不可直接解析**
 *（它是 htmlparser2 的依赖，不是我们的依赖）。
 * 直接 import 未声明的包会污染依赖图。
 *
 * 这也顺带钉住了「我们用的节点类型与 `DomUtils` 接受的**是同一个**」——
 * 如果哪天库换了类型，这里会跟着变，而不是悄悄错位。
 */
type DomNode = Parameters<typeof DomUtils.getInnerHTML>[0];

/** 文档根。 */
type DomRoot = ReturnType<typeof parseDocument>;

/** 提取结果：命中的容器，以及该容器的内部 HTML。 */
export type ExtractionResult = {
  html: string;
  /**
   * 命中的容器类型。`fragment` 表示「这不是一张完整网页」
   * （RSS 的 `content:encoded` 就是片段，没有 `<html>` / `<body>`）。
   */
  container: 'article' | 'main' | 'body' | 'fragment';
};

/** 候选容器的选择顺序与判据。 */
type Candidate = {
  container: ExtractionResult['container'];
  matches: (node: DomNode) => boolean;
};

/**
 * 序列化选项。
 *
 * ⚠ `encodeEntities` 必须是 `'utf8'`，**不能用默认值、也不能用 `false`**：
 *
 * - **默认**：把每个非 ASCII 字符转义成数字实体 —— `发` 变成 `&#x53d1;`。
 *   对中文正文来说这是一次 **8 倍体积膨胀**，而 `body_original` 是 `LongText`，
 *   在库里白占空间、在传输上白费带宽。
 * - **`false`**：连 `<` `>` `&` 都不转义，会产出**语义错误**的 HTML
 *   （原文里的 `&amp;` 会被解成裸 `&`，再被下次解析当成实体开头）。
 * - **`'utf8'`**（本选择）：中文原样保留，只有 HTML 特殊字符被转义。
 *   这是唯一同时满足「中文不膨胀」与「HTML 语义正确」的选项。
 */
const SERIALIZE_OPTIONS = { encodeEntities: 'utf8' } as const;

/** 元素节点的文本长度（用于「谁更像正文」的比较）。 */
function textLength(node: DomNode): number {
  return DomUtils.textContent(node).trim().length;
}

/** 该节点是不是名为 `name` 的标签。 */
function isTag(node: DomNode, name: string): boolean {
  return node.type === 'tag' && node.name.toLowerCase() === name;
}

/** 该节点的 `role` 属性（小写）。 */
function roleOf(node: DomNode): string | undefined {
  if (node.type !== 'tag') return undefined;
  const role: unknown = node.attribs['role'];
  return typeof role === 'string' ? role.toLowerCase() : undefined;
}

const CANDIDATES: readonly Candidate[] = [
  // 语义最明确的正文容器
  { container: 'article', matches: (node) => isTag(node, 'article') },
  {
    container: 'main',
    matches: (node) => isTag(node, 'main') || roleOf(node) === 'main',
  },
  { container: 'body', matches: (node) => isTag(node, 'body') },
];

/**
 * 提取正文区域。
 *
 * 顺序：`<article>` → `<main>` / `[role=main]` → `<body>` → 原样（片段）。
 *
 * **同类容器取「文本最长」的那个**，而不是第一个：博客首页、文档站
 * 常见一页里多个 `<article>`（每篇一张卡片），取第一个会拿到最短的摘要卡片。
 * 单篇文章页只有一个 `<article>`，两种取法结果相同。
 *
 * 空容器会被跳过（`<article></article>` 占位时继续往下找）。
 */
export function extractArticleBody(html: string): ExtractionResult {
  const document: DomRoot = parseDocument(html);

  for (const candidate of CANDIDATES) {
    const matches = DomUtils.findAll(candidate.matches, document.children as DomNode[]);
    if (matches.length === 0) continue;

    const best = matches.reduce((longest, node) =>
      textLength(node) > textLength(longest) ? node : longest,
    );

    // 空容器当作没找到 —— 有些站点会放一个空的 <article> 做 JS 挂载点。
    if (textLength(best) === 0 && DomUtils.findAll((n) => isTag(n, 'img'), [best]).length === 0) {
      continue;
    }

    return { html: DomUtils.getInnerHTML(best, SERIALIZE_OPTIONS), container: candidate.container };
  }

  // 不是完整网页（RSS 的 content:encoded 就是这种）→ 原样返回。
  return { html, container: 'fragment' };
}
