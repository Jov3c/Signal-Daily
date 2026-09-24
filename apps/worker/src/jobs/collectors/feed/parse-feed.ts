/**
 * RSS 2.0 / Atom 1.0 / RSS 1.0(RDF) 的统一解析。
 *
 * ── 为什么这段代码的每一处都长得这么小心 ────────────────────────────
 * 下面每一条都是**拿真实 feed 跑出来的**，不是照着规范推的
 * （探针与原始响应：`work/_agent04/probe-upstreams.json`）：
 *
 * | 真实形状                              | 不处理会怎样                                              |
 * | ------------------------------------- | --------------------------------------------------------- |
 * | `<guid isPermaLink="false">…</guid>`  | 该元素带属性时解析成**对象**而不是字符串，直接用会得到 `[object Object]` 当 id |
 * | `<summary type="html">…</summary>`    | 同上（Atom 的 `summary` / `title` 常带 `type`）           |
 * | `<link href="…" rel="alternate"/>`    | Atom 的链接在**属性**里，不在文本里                       |
 * | XML 声明 `<?xml …?>`                  | 不关掉声明解析，它会作为一个 `?xml` 键混进文档对象，`Object.keys(doc)[0]` 拿到的是它 |
 * | Atom 的作者只在 feed 级、条目级没有    | 逐条读 `entry.author` 会全是 null                         |
 * | `<title><![CDATA[…]]></title>`        | 不处理 CDATA 会丢掉标题（已实测 FXP 默认会保留，属确认项） |
 *
 * ── 安全：解析器行为是**实测**的，不是从文档推的 ────────────────────
 * `work/_agent04/probe-xml-safety.mjs` 用真实攻击载荷跑过，结论：
 *
 * | 载荷                       | 实测结果                                        |
 * | -------------------------- | ----------------------------------------------- |
 * | XXE 读本机文件 / SSRF      | **直接抛错** `External entities are not supported` |
 * | 外部 DTD                   | 被忽略，不发网络请求                            |
 * | 十亿笑声（嵌套实体）       | **不放大**（嵌套实体不被展开）                  |
 * | 5000 层深嵌套              | **抛错** `Maximum nested tags exceeded`         |
 * | `__proto__` 作为元素名     | **被解析器拒绝**（原型污染不成立）              |
 *
 * ⚠ 但**内部 DTD 子集是被解析的**，简单内部实体会被展开
 * （`<!ENTITY x "EXPANDED">` + `&x;` → 字面量 `EXPANDED`）。
 * 「不加载 DTD」这句话是错的 —— 只有「不解析**外部**实体」成立。
 * 因为放大倍率不可嵌套，这不构成 DoS，但它说明了为什么
 * `rejectDoctype()` 必须真的能拦住：见下一个函数的注释。
 */

import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { toPlainText, toPlainTitle } from '../text/markup';

/** 一条 feed 条目，字段对齐 `CollectedItem` 里源侧事实的部分。 */
export type FeedEntry = {
  title: string | null;
  /** 原始 `link`（可能是相对地址，由适配器用最终地址解析成绝对）。 */
  link: string | null;
  /** `guid` / `id` / `rdf:about`。 */
  id: string | null;
  publishedAt: Date | null;
  /** 摘要（RSS 的 `description` / Atom 的 `summary`）。 */
  summary: string | null;
  /** 正文（`content:encoded` / Atom 的 `content`）；取不到时适配器回退到 summary。 */
  body: string | null;
  author: string | null;
};

export type ParsedFeed = {
  format: 'rss' | 'atom' | 'rdf';
  title: string | null;
  language: string | null;
  entries: FeedEntry[];
  /**
   * 非致命的解析问题（目前只有「实体未转义」一种）。
   *
   * 单独返回而不是直接吞掉：这类问题**数据是完整的**，所以不该让来源失败；
   * 但它确实说明上游的 feed 有问题，值得出现在日志里。
   * 由适配器负责记录（本文件是纯函数，不持有 logger）。
   */
  warnings: string[];
};

/**
 * 解析器实例。
 *
 * 各选项的理由：
 *   - `ignoreAttributes: false` + 前缀 `@_`：Atom 的链接、`type`、`isPermaLink`
 *     全在属性里，不读属性等于丢掉半个 feed；
 *   - `parseTagValue: false`：**必须关掉**。否则 `12345` 会被转成数字，
 *     GUID / id 一旦是全数字就变成 number，之后所有等值比较（去重！）
 *     与字符串处理都会出现类型不一致；
 *   - `parseAttributeValue: false`：同理，`isPermaLink="false"` 不该变成布尔；
 *   - `ignoreDeclaration: true`：见上表 —— 否则 `?xml` 会混进文档对象；
 *   - `isArray`：**单条目的 feed 也必须拿到数组**。真实 feed 里
 *     「只有一个 item」很常见（一个刚发布的官方公告），
 *     不强制数组的话 `entries.length` 是 `undefined`，采集会静默产出 0 条。
 */
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  ignoreDeclaration: true,
  // 注意 `jpath` 在 fast-xml-parser 5 里是 `JPathOrMatcher`（可能是内部
  // 的匹配器对象），必须 `String()` 一下才能比较 —— 直接 includes 会 TS2345。
  isArray: (_name, jpath) =>
    ['rss.channel.item', 'feed.entry', 'rdf:RDF.item'].includes(String(jpath)),
});

/**
 * 带 DOCTYPE 的 feed 一律拒绝（feed 从来不需要 DTD）。
 *
 * ── 这段逻辑被改过两次，两次的教训都值得留着 ──────────────────────
 *
 * **第一版**：`xml.slice(0, 4_096)` —— 只看开头 4KB。
 * 理由是「全文扫描会被正文里讨论 `<!DOCTYPE` 的示例文本误伤」。
 * 前半句对**纯文本内容**成立（那里的字面量必须写成 `&lt;!DOCTYPE`），
 * 但它能被绕过：用一个 5KB 的注释把 DOCTYPE 推到窗口之后即可
 * （XML 允许注释出现在根元素前）。实测确认绕过成立、`&x;` 被展开成字面量。
 *
 * **第二版（错的）**：改成扫描全文 —— 结果**误杀了一类常见且合法的 feed**。
 * 原因是漏了两处：**CDATA 段与注释里的内容是字面量，XML 规范要求不转义**。
 * 而「用 CDATA 包一整篇 HTML 文档」正是 RSS `content:encoded` 的常见真实形态
 * （WordPress 默认 feed 就是这样）。一份 19.7 KB 的合法 feed、
 * `<!DOCTYPE html>` 出现在 CDATA 里，会被整条拒绝 →
 * 该来源永久 `SOURCE_FETCH_FAILED`、0 条入库。
 *
 * **现在这一版**：先剥掉 CDATA 段与注释，再在剩余部分里找 DOCTYPE。
 * 这样既堵住了 4KB 窗口的绕过，也不会把「正文里的文档示例」当成真 DOCTYPE。
 *
 * ⚠ 这条改动必须配套一条「CDATA / 注释里的字面量不误伤」的回归用例，
 * 并且**反证它有牙齿** —— 第二版之所以能溜过去，就是因为没有那条用例
 * （反证实测：把守卫改成忽略 CDATA 内的字面量，202 项单测 + 46 项集成**全绿**）。
 */
export function rejectDoctype(xml: string): void {
  if (/<!DOCTYPE/i.test(stripLiteralRegions(xml))) {
    throw new Error('Feed contains a DOCTYPE declaration, which Signal does not accept');
  }
}

/**
 * 剥掉「内容按规范就是字面量」的区域：CDATA 段与注释。
 *
 * 这两处里的 `<!DOCTYPE` 是**正文的一部分**（文档示例、HTML 教程、
 * 被 CDATA 包裹的整篇 HTML），不是 XML 记号。不剥掉就会误杀合法 feed。
 *
 * 用正则而不是完整词法分析：CDATA / 注释都不允许嵌套，
 * 所以 `/<![CDATA[[\s\S]*?]]>/` 与 `/<!--[\s\S]*?-->/` 是精确的。
 * 未闭合的情形由替换到串尾处理（保守：宁可多剥，也不要误判成 DOCTYPE）。
 */
function stripLiteralRegions(xml: string): string {
  return xml.replace(/<!\[CDATA\[[\s\S]*?(?:]]>|$)/g, ' ').replace(/<!--[\s\S]*?(?:-->|$)/g, ' ');
}

/**
 * 结构校验。
 *
 * ── 为什么必须校验（实测得出的结论，不是照规范推的）────────────────
 * 拿四种真实形态的坏 feed 跑过（探针见 HANDOFF 的 Known Limitations）：
 *
 * | 情形         | 校验器       | 实际解析出的条目     |
 * | ------------ | ------------ | -------------------- |
 * | 标签不匹配   | `InvalidTag` | **0**（全部丢掉）    |
 * | 未闭合标签   | `InvalidTag` | **非数组**（全部丢） |
 * | 未转义 `&`   | `InvalidChar`| 完整（1/1）          |
 * | 文件被截断   | `InvalidXml` | 完整（2/2）          |
 *
 * 也就是说：**`InvalidTag` 会让数据静默消失**（返回 0 条，看起来就像
 * 「这个源今天没更新」），而 `InvalidChar` 与截断都不影响数据完整性。
 *
 * 因此策略是**只容忍 `InvalidChar`**：
 *   - 它是最常见的一种上游瑕疵（手写 feed 里未转义的 `&`），
 *     数据完好却拒收，等于把一个正常工作的源永久打死；
 *   - 其余校验失败一律如实报错 —— 那时数据已经丢了，
 *     返回一个「成功但 0 条」才是最坏的结果。
 *
 * 截断不进这里：它由 `safeFetchText` 的 `truncated` 标志单独处理
 * （见 `rss.adapter.ts`），那里能给出更准确的结论（「超过体积上限」）。
 */
function validateStructure(xml: string): string[] {
  const result = XMLValidator.validate(xml);
  if (result === true) return [];

  const error = result.err;
  if (error.code === 'InvalidChar') {
    return [`feed has an unescaped character (${error.msg}); entries were parsed successfully`];
  }
  throw new Error(
    `Feed is not well-formed XML: ${error.msg} (${error.code} at line ${error.line}, col ${error.col})`,
  );
}

/** 解析入口。解析不出任何条目时抛错，**不返回空数组**。 */
export function parseFeed(xml: string): ParsedFeed {
  // HTML 页面单独给一条更准确的诊断：把 RSS 地址填成网页地址、
  // 或站点挂掉时返回错误页，都是很常见的运维情形，
  // 「这是一个 HTML 页面」比「它含 DOCTYPE」有用得多。
  if (/^\s*<!doctype\s+html/i.test(xml)) {
    throw new Error('Response is not a feed: it looks like an HTML page');
  }
  rejectDoctype(xml);
  const warnings = validateStructure(xml);

  let doc: Record<string, unknown>;
  try {
    doc = parser.parse(xml) as Record<string, unknown>;
  } catch (error) {
    // 措辞刻意不写「not well-formed XML」：解析器抛出的还包括
    // `Maximum nested tags exceeded` 这类与「格式」无关的限制。
    throw new Error(`Feed could not be parsed: ${messageOf(error)}`, { cause: error });
  }

  const rss = asRecord(doc['rss']);
  if (rss !== null) {
    return { ...fromRss(rss, 'rss'), warnings };
  }

  const rdf = asRecord(doc['rdf:RDF']);
  if (rdf !== null) {
    return { ...fromRdf(rdf), warnings };
  }

  const atom = asRecord(doc['feed']);
  if (atom !== null) {
    return { ...fromAtom(atom), warnings };
  }

  throw new Error('Feed is neither RSS, Atom nor RSS 1.0 (RDF)');
}

/* ------------------------------------------------------------------ */
/* 三种格式                                                             */
/* ------------------------------------------------------------------ */

function fromRss(rss: Record<string, unknown>, format: 'rss'): Omit<ParsedFeed, 'warnings'> {
  const channel = asRecord(rss['channel']);
  if (channel === null) throw new Error('RSS document has no <channel>');

  const language = textOf(channel['language']);
  const feedAuthor = textOf(channel['managingEditor']) ?? textOf(channel['dc:creator']);

  return {
    format,
    title: toPlainText(textOf(channel['title'])),
    language: normalizeLanguage(language),
    entries: recordArrayOf(channel['item']).map((item) => ({
      title: toPlainTitle(textOf(item['title'])),
      link: textOf(item['link']),
      id: textOf(item['guid']) ?? textOf(item['id']) ?? textOf(item['dc:identifier']),
      publishedAt: parseDate(
        textOf(item['pubDate']) ??
          textOf(item['dc:date']) ??
          textOf(item['published']) ??
          textOf(item['updated']),
      ),
      summary: textOf(item['description']),
      body: textOf(item['content:encoded']) ?? textOf(item['description']),
      author: textOf(item['dc:creator']) ?? textOf(item['author']) ?? feedAuthor,
    })),
  };
}

/** RSS 1.0 (RDF)。条目挂在根下，而不是 `channel` 里。 */
function fromRdf(rdf: Record<string, unknown>): Omit<ParsedFeed, 'warnings'> {
  const channel = asRecord(rdf['channel']);
  return {
    format: 'rdf',
    title: toPlainText(textOf(channel?.['title'])),
    language: null,
    entries: recordArrayOf(rdf['item']).map((item) => ({
      title: toPlainTitle(textOf(item['title'])),
      link: textOf(item['link']),
      // RDF 的条目 id 在 `rdf:about` 属性上（不是子元素）。
      id: attributeOf(item, 'rdf:about') ?? textOf(item['dc:identifier']),
      publishedAt: parseDate(textOf(item['dc:date'])),
      summary: textOf(item['description']),
      body: textOf(item['content:encoded']) ?? textOf(item['description']),
      author: textOf(item['dc:creator']),
    })),
  };
}

function fromAtom(feed: Record<string, unknown>): Omit<ParsedFeed, 'warnings'> {
  // 作者经常只在 feed 级出现一次，条目级没有 —— 实测 simonwillison.net 就是这样。
  const feedAuthor = textOf(asRecord(feed['author'])?.['name']) ?? textOf(feed['author']);

  return {
    format: 'atom',
    title: toPlainText(textOf(feed['title'])),
    language: normalizeLanguage(attributeOf(feed, 'xml:lang') ?? textOf(feed['language'])),
    entries: recordArrayOf(feed['entry']).map((entry) => ({
      title: toPlainTitle(textOf(entry['title'])),
      link: atomLink(entry['link']),
      id: textOf(entry['id']),
      publishedAt: parseDate(textOf(entry['published']) ?? textOf(entry['updated'])),
      summary: textOf(entry['summary']),
      body: textOf(entry['content']) ?? textOf(entry['summary']),
      author: textOf(asRecord(entry['author'])?.['name']) ?? textOf(entry['author']) ?? feedAuthor,
    })),
  };
}

/**
 * Atom 的链接：从 `href` 属性取，优先 `rel="alternate"`。
 *
 * `rel` 缺省时语义就是 `alternate`（RFC 4287），所以要把它一起算进去。
 * 一个 `<link>` 时解析结果是对象、多个时是数组，两种都要能处理。
 */
function atomLink(raw: unknown): string | null {
  const candidates = arrayOf(raw).filter((node) => typeof node === 'object' && node !== null);
  let fallback: string | null = null;

  for (const node of candidates) {
    const href = attributeOf(node, 'href');
    if (href === null) continue;
    const rel = attributeOf(node, 'rel');
    if (rel === null || rel === 'alternate') return href;
    if (fallback === null) fallback = href;
  }
  return fallback;
}

/* ------------------------------------------------------------------ */
/* 节点取值                                                             */
/* ------------------------------------------------------------------ */

/** 节点 → 记录；不是对象时返回 null（数组取第一个元素）。 */
function asRecord(node: unknown): Record<string, unknown> | null {
  if (Array.isArray(node)) return node.length === 0 ? null : asRecord(node[0]);
  if (typeof node === 'object' && node !== null) return node as Record<string, unknown>;
  return null;
}

/**
 * 节点的文本。
 *
 * ⚠ **这是本文件最重要的一个函数。** 带任何属性的元素
 * （`<guid isPermaLink="false">`、`<summary type="html">`、`<title type="text">`）
 * 在 fast-xml-parser 里都是 `{ '@_xxx': ..., '#text': '真正的值' }` 这种对象，
 * 而不是字符串。实测：不处理的话 `summary` 会变成字面量 `[object Object]`
 * 被当成正文存进库 —— 一个**看起来成功、内容全错**的失败。
 */
function textOf(node: unknown): string | null {
  if (typeof node === 'string') return node;
  if (typeof node === 'number' || typeof node === 'boolean') return String(node);
  const record = asRecord(node);
  if (record === null) return null;
  const text = record['#text'];
  if (typeof text === 'string') return text;
  if (typeof text === 'number' || typeof text === 'boolean') return String(text);
  return null;
}

/** 节点的某个属性值。 */
function attributeOf(node: unknown, name: string): string | null {
  const record = asRecord(node);
  if (record === null) return null;
  const value = record[`@_${name}`];
  return typeof value === 'string' ? value : null;
}

/** 统一成数组：fast-xml-parser 在单元素时不返回数组。 */
function arrayOf(node: unknown): unknown[] {
  if (node === undefined || node === null) return [];
  return Array.isArray(node) ? node : [node];
}

/**
 * 元素数组 —— 只保留对象元素。
 *
 * 单独一个函数是因为 `rss.channel.item` 在**只有一个条目且没有子元素**时
 * 可能被解析成一个字符串（不太常见但确实会出现）。那种元素没有
 * 任何可取字段，直接过滤掉比让 `item['title']` 在字符串上取值安全。
 */
function recordArrayOf(node: unknown): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const element of arrayOf(node)) {
    const record = asRecord(element);
    if (record !== null) out.push(record);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 时间与语言                                                           */
/* ------------------------------------------------------------------ */

/**
 * 解析发布时间。
 *
 * **不做格式白名单**，直接交给 `new Date()`：
 *   - RSS 2.0 的 `pubDate` 是 RFC 822（`Thu, 24 Sep 2026 01:24:00 +0000`），
 *     RFC 822 允许省略秒、允许单字母时区（`GMT`、`EST`），这些
 *     手写解析器很容易写漏，而 `Date` 本来就认；
 *   - Atom 用 RFC 3339 / ISO 8601。
 * 两者实测都能被 `new Date()` 正确解析（见 `parse-feed.spec.ts` 的真实样本用例）。
 *
 * 解析不出来返回 `null` 而不是 `new Date(NaN)` —— 后者会让
 * `publishedAt` 变成一个 Invalid Date 写进库，之后所有日期比较
 * 都会静默返回 false（去重与排序一起失效）。
 */
export function parseDate(raw: string | null): Date | null {
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** 语言标签：只保留 `en` / `en-US` 这类形状，过长的丢掉（列是 `Char(5)`）。 */
function normalizeLanguage(raw: string | null): string | null {
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  return /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,4})?$/.test(trimmed) && trimmed.length <= 5
    ? trimmed
    : null;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
