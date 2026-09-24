/**
 * 文本 / 标记处理。
 *
 * ── 这里做与不做的分界线 ────────────────────────────────────────────
 * **做**：把**标题**变成纯文本。标题会直接进列表页、日报版位、搜索结果，
 * 是「一定会被渲染」的字段；而源侧的标题经常带实体（`&amp;`、`&#8217;`）
 * 甚至标签（`<b>`）。不清的话前台会显示 `&amp;`。
 *
 * **不做**：清洗正文 HTML。`docs/14` 要求「前端不得渲染未清洗 HTML」，
 * 但清洗是 Pipeline 的 Normalize 阶段（Agent 05）的职责，
 * 采集端保留原文是 RawItem 的语义（`docs/03`：保存外部原始抓取事实）。
 * 在这里顺手清洗会把不可逆的处理提前做掉，之后再也无法判断原文是什么。
 *
 * ── 为什么不用 DOM 解析器 ───────────────────────────────────────────
 * 采集端只需要「标题的纯文本」这一个能力，而 Node 没有内置 DOM。
 * 为了一个标题引入 `jsdom`（一堆传递依赖）不划算 ——
 * 正文的完整解析在 Pipeline，那里才值得上真正的解析器。
 * 因此这里是有意为之的**轻量**实现，并且**只用于标题**，
 * 不假装它能处理任意 HTML。
 *
 * ⚠ 但「轻量」不等于「可以慢」：`stripTags` 曾经是 O(n²) 的正则，
 * 对超长输入会阻塞事件循环几十分钟（详见该函数的注释）。
 * 采集路径上的每一个处理步骤都必须对**上游可控的长度**保持线性。
 */

/**
 * 常见的 HTML 命名实体。XML 那 5 个（amp/lt/gt/quot/apos）之外的部分。
 *
 * ⚠ 一律用 `\u` 转义写。直接写字符会有两个问题：
 *   1. 空白类实体（`&nbsp;` 是 U+00A0）在源码里与普通空格**看起来完全一样**，
 *      一旦被编辑器或格式化工具「顺手」换成半角空格，折叠空白的行为就变了，
 *      而没有任何东西会报错；
 *   2. 源码本身可能被以非 UTF-8 的方式读写，非 ASCII 字面量会静默损坏。
 */
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  nbsp: '\u00a0',
  ensp: '\u2002',
  emsp: '\u2003',
  thinsp: '\u2009',
  shy: '\u00ad',
  hellip: '\u2026',
  mdash: '\u2014',
  ndash: '\u2013',
  minus: '\u2212',
  lsquo: '\u2018',
  rsquo: '\u2019',
  sbquo: '\u201a',
  ldquo: '\u201c',
  rdquo: '\u201d',
  bdquo: '\u201e',
  laquo: '\u00ab',
  raquo: '\u00bb',
  lsaquo: '\u2039',
  rsaquo: '\u203a',
  dagger: '\u2020',
  bull: '\u2022',
  middot: '\u00b7',
  permil: '\u2030',
  prime: '\u2032',
  Prime: '\u2033',
  times: '\u00d7',
  divide: '\u00f7',
  plusmn: '\u00b1',
  copy: '\u00a9',
  reg: '\u00ae',
  trade: '\u2122',
  deg: '\u00b0',
  micro: '\u00b5',
  para: '\u00b6',
  sect: '\u00a7',
  euro: '\u20ac',
  pound: '\u00a3',
  yen: '\u00a5',
  cent: '\u00a2',
  curren: '\u00a4',
  larr: '\u2190',
  rarr: '\u2192',
  uarr: '\u2191',
  darr: '\u2193',
  harr: '\u2194',
  infin: '\u221e',
  ne: '\u2260',
  le: '\u2264',
  ge: '\u2265',
  frac12: '\u00bd',
  frac14: '\u00bc',
  frac34: '\u00be',
  alpha: '\u03b1',
  beta: '\u03b2',
  gamma: '\u03b3',
  delta: '\u03b4',
  epsilon: '\u03b5',
  theta: '\u03b8',
  lambda: '\u03bb',
  mu: '\u03bc',
  pi: '\u03c0',
  sigma: '\u03c3',
  tau: '\u03c4',
  phi: '\u03c6',
  omega: '\u03c9',
  Delta: '\u0394',
  Sigma: '\u03a3',
  Omega: '\u03a9',
  star: '\u2606',
  check: '\u2713',
  cross: '\u2717',
};

/**
 * 解码 XML / HTML 实体。
 *
 * 覆盖三类：
 *   1. 命名实体（上面的表 + XML 的 5 个）；
 *   2. 十进制数字实体 `&#8217;`；
 *   3. 十六进制数字实体 `&#x2019;`。
 *
 * **不认识的实体原样保留**。这比「猜一个」或「删掉」都好：
 * `&foo;` 原样显示至少说明这里有东西，而删掉会让文本静默缺字。
 * 这也让「表里缺了某个实体」表现为一个看得见的显示瑕疵，
 * 而不是难以察觉的数据丢失。
 */
export function decodeEntities(input: string): string {
  return input.replace(
    /&(#[xX][0-9a-fA-F]+|#\d+|[A-Za-z][A-Za-z0-9]*);/g,
    (match, body: string) => {
      if (body.startsWith('#x') || body.startsWith('#X')) {
        return codePointToString(Number.parseInt(body.slice(2), 16), match);
      }
      if (body.startsWith('#')) {
        return codePointToString(Number.parseInt(body.slice(1), 10), match);
      }
      if (body === 'amp') return '&';
      if (body === 'lt') return '<';
      if (body === 'gt') return '>';
      if (body === 'quot') return '"';
      if (body === 'apos') return "'";
      // HTML 的命名实体对大小写不敏感（`&LT;` 与 `&lt;` 等价）。
      // 原来只查小写表，于是 `&LT;img …&GT;` 会原样留在标题里。
      return NAMED_ENTITIES[body] ?? NAMED_ENTITIES[body.toLowerCase()] ?? match;
    },
  );
}

/**
 * 码点 → 字符串；越界或落在代理区时保留原样。
 *
 * `String.fromCodePoint()` 对 > 0x10FFFF 会抛 `RangeError`，
 * 而实体是**外部输入**：源站标题里放一个 `&#xFFFFFFFF;`
 * 就能让整个采集任务崩掉。代理区（U+D800–U+DFFF）单独成字符也不合法，
 * 保留原样比产出一个坏字符好。
 */
function codePointToString(codePoint: number, fallback: string): string {
  if (!Number.isFinite(codePoint)) return fallback;
  if (codePoint < 0 || codePoint > 0x10ffff) return fallback;
  if (codePoint >= 0xd800 && codePoint <= 0xdfff) return fallback;
  try {
    return String.fromCodePoint(codePoint);
  } catch {
    return fallback;
  }
}

/**
 * 去掉 HTML 标签，返回纯文本。
 *
 * ── ⚠ 这是一次 P1 缺陷的修复：原实现是二次爆炸的 ────────────────────
 * 原实现用 `.replace(/<[^>]*>/g, ' ')`。当输入里有 `<` 却**没有** `>`
 * （第三方 feed 的标题完全可以这样写）时，正则引擎会在每一个 `<`
 * 位置尝试匹配、`[^>]*` 一路吃到串尾、失败、再回溯一格 —— O(n²)。
 * 实测标度（本机）：
 *
 * ```
 * len=4,000   5ms
 * len=8,000  17ms     ← 输入 2×，耗时 ~4×
 * len=16,000 66ms
 * len=32,000 265ms
 * ```
 *
 * 而且它是**同步**的：一次 2 MiB 的输入（`SOURCE_FETCH_MAX_BYTES` 的上限）
 * 会阻塞 Node 事件循环几十分钟，把同进程的 CollectorWorker（并发 5）
 * 与 SourceScheduler 一起拖死。触发者不需要任何权限，
 * 只要能被加进白名单、或者被管理员盯上一个 MANUAL_URL 页面。
 *
 * 现在改成单趟线性扫描：一次 `indexOf`，没有回溯，复杂度 O(n)。
 *
 * ── 与旧实现（`/<[^>]*>/g`）的行为差异（逐条实测过，不是推测）──────
 *
 * ⚠ 我最初在这里写的理由是错的，值得留着以免再犯：
 * 我写「旧实现会把未闭合 `<` 之后的整段内容**吞掉**」—— **实测旧实现也不吞**
 * （`'<b>文字<a'` → 旧 `' 文字<a'`、新 `' 文字 <a'`）。
 * 真正的差异是**新实现在每个 `<` 处先补一个空格**，而不是吞内容。
 * 那个空格经 `toPlainTitle` 的空白折叠后对最终标题无影响。
 *
 * 实测确认的差异只有三处，且全部是「新实现更好」：
 *   1. **注释**：`'前<!-- a > b -->后'` → 旧 `'前  b -->后'`（注释内容泄漏）
 *      / 新 `'前 后'`；
 *   2. **未闭合的注释**：`'前<!-- 没有结束'` → 旧原样保留 / 新截断到 `'前 '`；
 *   3. **`script` / `style` / `noscript` / `template` 整块**：旧只删标签、
 *      把脚本源码留在正文里（标题里出现一大段 JS 的经典成因）/ 新整块删除。
 *
 * 其余（含未闭合 `<`、连续 `<`）**语义等价**，只差一个空格。
 */
const BLOCK_ELEMENTS = new Set(['script', 'style', 'noscript', 'template']);

export function stripTags(html: string): string {
  const out: string[] = [];
  let index = 0;

  while (index < html.length) {
    const lt = html.indexOf('<', index);
    if (lt === -1) {
      out.push(html.slice(index));
      break;
    }
    out.push(html.slice(index, lt), ' ');

    // 注释整块删除。
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      if (end === -1) break; // 未闭合的注释：剩余全部丢弃
      index = end + 3;
      continue;
    }

    const gt = html.indexOf('>', lt + 1);
    if (gt === -1) {
      // 没有闭合的 `>`：剩下的不是标签，原样保留（见上文差异 1）。
      out.push(html.slice(lt));
      break;
    }

    const inner = html.slice(lt + 1, gt);
    const name = /^\s*([A-Za-z][A-Za-z0-9]*)/.exec(inner)?.[1]?.toLowerCase();

    if (name !== undefined && BLOCK_ELEMENTS.has(name)) {
      // 整块删除到配对的结束标签。找不到就删到末尾 ——
      // 宁可多删，也不要让脚本源码进入正文。
      const close = html.indexOf(`</${name}`, gt + 1);
      if (close === -1) break;
      const closeGt = html.indexOf('>', close);
      if (closeGt === -1) break;
      index = closeGt + 1;
      continue;
    }

    index = gt + 1;
  }

  return out.join('');
}

/**
 * 标题专用：去标签 → 解码实体 → **再去一次标签** → 折叠空白。
 *
 * ── 「再去一次标签」解决什么 ────────────────────────────────────────
 * 实体是外部输入，解码会**造出新的标签**：源站把标题写成
 * `&lt;img src=x onerror=alert(1)&gt;` 时，只做一次去标签的话，
 * 解码后得到的就是一个货真价实的 `<img>` 标签串 —— 而标题是
 * 「一定会被渲染」的字段。先解码再删，这类内容就变成空字符串。
 *
 * ── ⚠ 这个保证的**边界**（原注释声称得比实际强，实测有反例）─────────
 * 它不是、也不能当作一个 XSS 净化函数。以下三种输入**会**在返回值里
 * 留下可疑内容（都已在 `collectors-text-url.spec.ts` 里钉住）：
 *
 *   1. **双重编码**：`&amp;lt;img …&amp;gt;` 只解一层，
 *      结果是 `&lt;img …&gt;` —— 任何**再解一次**的下游都会得到真标签；
 *   2. **未闭合的标签**：`<img src=x onerror=alert(1)`（没有 `>`）
 *      原样输出，返回值里会出现裸 `<`（这是 `stripTags` 的刻意取舍，
 *      见那里的注释）；
 *   3. **解码后仍然不是标签**的零散 `<`。
 *
 * 结论：**标题是纯文本，但不是「已净化的 HTML」**。
 * 下游（Pipeline 的 Normalize、前端的渲染）必须按纯文本处理并转义，
 * 不得把它的返回值直接当 HTML 插入。真正的 HTML 清洗由 Agent 05 负责
 * （`docs/14`：前端不得渲染未清洗 HTML）。
 *
 * 折叠空白是必要的：源侧标题里常见 `&#10;` 与连续空格，
 * 不折叠的话前台会出现「标题里有换行」这种明显是 bug 的显示。
 */
export function toPlainTitle(raw: string | null): string | null {
  if (raw === null) return null;
  const decoded = decodeEntities(stripTags(raw));
  const text = stripTags(decoded).replace(/\s+/g, ' ').trim();
  return text === '' ? null : text;
}

/** 只做「解码 + 折叠空白」，不去标签。用于已经是纯文本的字段（如 Atom 的 title）。 */
export function toPlainText(raw: string | null): string | null {
  if (raw === null) return null;
  const text = decodeEntities(raw).replace(/\s+/g, ' ').trim();
  return text === '' ? null : text;
}

/**
 * 从 HTML 页面里抽一个标题。
 *
 * 优先级：`og:title` → `twitter:title` → `<title>` → 第一个 `<h1>`。
 *
 * 为什么 `og:title` 在最前：`<title>` 常带站点后缀
 * （`某篇文章 - 某某科技`），而 `og:title` 一般是干净的正文标题。
 * 这只是**采集端的兜底**，正式标题由 Pipeline 决定。
 *
 * 只看前 200KB：标题一定在 `<head>` 里，而把 2MB 正文整个扫描一遍
 * 只为找一个 `<title>` 是浪费。
 */
export function extractHtmlTitle(html: string): string | null {
  const head = html.slice(0, 200_000);

  const meta = (property: string): string | null => {
    // 属性顺序两种都可能：content 在前或在后。
    for (const pattern of [
      new RegExp(
        `<meta[^>]+(?:property|name)\\s*=\\s*["']${property}["'][^>]*content\\s*=\\s*["']([^"']*)["']`,
        'i',
      ),
      new RegExp(
        `<meta[^>]+content\\s*=\\s*["']([^"']*)["'][^>]*(?:property|name)\\s*=\\s*["']${property}["']`,
        'i',
      ),
    ]) {
      const value = pattern.exec(head)?.[1];
      if (value !== undefined && value.trim() !== '') return value;
    }
    return null;
  };

  const titleTag = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1] ?? null;
  const h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(head)?.[1] ?? null;

  return (
    toPlainTitle(meta('og:title')) ??
    toPlainTitle(meta('twitter:title')) ??
    toPlainTitle(titleTag) ??
    toPlainTitle(h1)
  );
}
