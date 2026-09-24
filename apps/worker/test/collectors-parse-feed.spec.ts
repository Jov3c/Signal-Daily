/**
 * Feed 解析测试。
 *
 * 数据全部来自 `feed-fixtures.ts`，而那里的每个 fixture 都注明
 * 它复刻的是哪个**真实**响应、专门钉住哪一点（§23.3）。
 */

import { describe, expect, it } from 'vitest';
import { parseDate, parseFeed, rejectDoctype } from '../src/jobs/collectors/feed/parse-feed';
import {
  ATOM_SIMONWILLISON,
  BILLION_LAUGHS,
  DOCTYPE_FEED,
  MALFORMED_XML,
  NOT_XML,
  RSS_1_0_RDF,
  RSS_2_0_CONTENT_ENCODED,
  RSS_2_0_HNRSS,
  RSS_ENTITY_IN_TITLE,
  RSS_SINGLE_ITEM,
  RSS_WITHOUT_DATES,
  XML_BUT_NOT_A_FEED,
} from './support/feed-fixtures';

describe('parseFeed — RSS 2.0', () => {
  it('解析 hnrss 形态：CDATA 标题、带属性的 guid、dc:creator、RFC822 日期', () => {
    const feed = parseFeed(RSS_2_0_HNRSS);

    expect(feed.format).toBe('rss');
    expect(feed.title).toBe('Hacker News: Front Page');
    expect(feed.language).toBe('en-us');
    expect(feed.entries).toHaveLength(2);

    const first = feed.entries[0]!;
    // CDATA 必须取到内容而不是空串。
    expect(first.title).toBe('Australia says OpenAI agent hacked into government website');
    expect(first.link).toBe('https://example.com/a');
    // ⚠ 这一条是关键：`<guid isPermaLink="false">` 会被解析成对象，
    // 不处理的话这里会是 `[object Object]`。
    expect(first.id).toBe('https://news.ycombinator.com/item?id=49825024');
    expect(first.author).toBe('doppp');
    expect(first.publishedAt?.toISOString()).toBe('2026-09-24T01:24:00.000Z');
  });

  it('中文标题与正文原样保留（Signal 的正文就是中文）', () => {
    const feed = parseFeed(RSS_2_0_HNRSS);
    const second = feed.entries[1]!;
    expect(second.title).toBe('模型评测：推理成本与基础模型的能力边界');
    expect(second.body).toContain('中文正文');
  });

  it('相对链接原样返回（由适配器按最终地址解析成绝对）', () => {
    const feed = parseFeed(RSS_2_0_HNRSS);
    expect(feed.entries[1]!.link).toBe('/relative/post-2');
  });

  it('正文优先取 content:encoded 而不是 description', () => {
    const feed = parseFeed(RSS_2_0_CONTENT_ENCODED);
    expect(feed.entries[0]!.body).toContain('这是完整正文');
    expect(feed.entries[0]!.body).not.toContain('一句话摘要');
    expect(feed.entries[0]!.author).toBe('GitHub Staff');
  });

  it('只有一个 item 时也返回数组（fast-xml-parser 单元素不返回数组）', () => {
    const feed = parseFeed(RSS_SINGLE_ITEM);
    expect(Array.isArray(feed.entries)).toBe(true);
    expect(feed.entries).toHaveLength(1);
    expect(feed.entries[0]!.title).toBe('Anthropic 发布新模型');
  });

  it('没有 pubDate 的条目照常解析出来（日期为 null，不是被丢掉）', () => {
    const feed = parseFeed(RSS_WITHOUT_DATES);
    expect(feed.entries).toHaveLength(1);
    expect(feed.entries[0]!.publishedAt).toBeNull();
    expect(feed.entries[0]!.title).toBe('没有 pubDate 的条目');
  });

  it('标题里的实体被解码（含数值实体与 XML 五个预定义实体）', () => {
    const feed = parseFeed(RSS_ENTITY_IN_TITLE);
    const title = feed.entries[0]!.title;
    expect(title).toContain('A & B');
    expect(title).toContain('—');
  });
});

describe('parseFeed — Atom', () => {
  it('解析 simonwillison 形态：XML 声明不混进文档对象、链接在属性里、feed 级作者', () => {
    const feed = parseFeed(ATOM_SIMONWILLISON);

    expect(feed.format).toBe('atom');
    expect(feed.title).toBe("Simon Willison's Weblog");
    expect(feed.language).toBe('en-us');
    expect(feed.entries).toHaveLength(2);

    const first = feed.entries[0]!;
    // ⚠ `<summary type="html">` 带属性 → 会被解析成对象。
    // 不处理 textOf 的话这里会是 `[object Object]` 被当成正文存进库。
    expect(first.summary).toBe('A new playground for testing text-to-speech 的中文说明。');
    expect(first.summary).not.toContain('[object Object]');
    // 链接在 `href` 属性里，且要优先 rel="alternate"。
    expect(first.link).toBe('https://simonwillison.net/2026/Sep/23/gemini-tts-playground/');
    expect(first.id).toBe('https://simonwillison.net/2026/Sep/23/gemini-tts-playground/');
    expect(first.publishedAt?.toISOString()).toBe('2026-09-23T17:12:27.000Z');
    // ⚠ 条目级没有 author，必须回退到 feed 级。
    expect(first.author).toBe('Simon Willison');
  });

  it('条目级作者覆盖 feed 级作者', () => {
    const feed = parseFeed(ATOM_SIMONWILLISON);
    expect(feed.entries[1]!.author).toBe('Guest Author');
  });

  it('正文优先取 content，取不到才退回 summary', () => {
    const feed = parseFeed(ATOM_SIMONWILLISON);
    expect(feed.entries[1]!.body).toContain('正文走 content');
  });
});

describe('parseFeed — RSS 1.0 (RDF)', () => {
  it('条目挂在根下，id 在 rdf:about 属性上', () => {
    const feed = parseFeed(RSS_1_0_RDF);

    expect(feed.format).toBe('rdf');
    expect(feed.title).toBe('RSS 1.0 示例源');
    expect(feed.entries).toHaveLength(1);

    const item = feed.entries[0]!;
    expect(item.title).toBe('RDF 格式的条目');
    expect(item.id).toBe('https://example.com/rdf-post-1');
    expect(item.author).toBe('rdf-author');
    expect(item.publishedAt?.toISOString()).toBe('2026-09-24T01:00:00.000Z');
  });
});

describe('parseFeed — 拒绝与失败', () => {
  it('HTML 错误页给出准确的诊断（「这是一个 HTML 页面」而不是含糊的解析失败）', () => {
    // 把 RSS 地址填成网页地址、或站点挂掉时返回错误页，都是常见运维情形。
    expect(() => parseFeed(NOT_XML)).toThrow(/looks like an HTML page/i);
  });

  it('结构损坏（标签不匹配）必须报错，**不能**返回 0 条', () => {
    // 实测：`InvalidTag` 时解析器返回 0 条 —— 静默丢数据的典型形态。
    // 「这个源今天没更新」与「解析器丢了全部条目」在数据上长得一模一样。
    expect(() => parseFeed(MALFORMED_XML)).toThrow(/not well-formed XML/i);
  });

  it('未转义的 & 被容忍（数据完好，只是记一条 warning）', () => {
    // 实测：`InvalidChar` 时条目是完整的。拒收它等于把一个正常工作的源
    // 永久打死，而上游是第三方 feed，管理员没有修复手段。
    const feed = `<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>
<item><title>A & B</title><link>https://example.com/amp</link></item>
</channel></rss>`;
    const parsed = parseFeed(feed);
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.warnings.length).toBeGreaterThan(0);
    expect(parsed.warnings[0]).toMatch(/unescaped/i);
  });

  it('正常 feed 没有 warning', () => {
    expect(parseFeed(RSS_2_0_HNRSS).warnings).toEqual([]);
  });

  it('**DOCTYPE 藏在 4KB 之后也拦得住**（原实现只看前 4KB，可被注释推移绕过）', () => {
    // 实测旧实现的绕过：用一个 5KB 的注释把 DOCTYPE 推到窗口之后，
    // 守卫放行、`&x;` 被解析成字面量。现在扫描全文。
    // XML 里正文中的字面量 `<!DOCTYPE` 必须写成 `&lt;!DOCTYPE`，
    // 所以全文扫描不会误伤正常内容（下面另有一条用例钉住这一点）。
    const padding = `<!--${'x'.repeat(5_000)}-->`;
    const feed =
      `<?xml version="1.0"?>${padding}\n` +
      '<!DOCTYPE rss [<!ENTITY x "EXPANDED">]>\n' +
      '<rss version="2.0"><channel><title>&x;</title>' +
      '<item><title>&x;</title><link>https://example.com/x</link></item>' +
      '</channel></rss>';
    expect(() => parseFeed(feed)).toThrow(/DOCTYPE/i);
  });

  it('**CDATA 里的字面量 `<!DOCTYPE` 不误伤**（WordPress 式 feed 的常见形态）', () => {
    // ⚠ 这是第二轮复审抓出的、由我自己的修复**引入**的 P1。
    // 我把守卫从「只看前 4KB」改成「扫描全文」，理由写的是
    // 「XML 里正文中的字面量必须写成 `&lt;!DOCTYPE`」—— 那句话对**纯文本**
    // 成立，对 **CDATA 段**与**注释**不成立：那两处的内容按规范就是字面量。
    // 而「用 CDATA 包一整篇 HTML」正是 RSS `content:encoded` 的常见真实形态
    // （WordPress 默认 feed）。实测：一份 19.7 KB 的合法 feed 被整条拒绝、
    // 该来源永久 0 条入库，而旧实现（前 4KB）是放行的。
    const feed = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel><title>某博客</title>
    <item>
      <title>HTML 入门</title>
      <link>https://blog.example.com/html</link>
      <content:encoded><![CDATA[
        <!DOCTYPE html>
        <html><body><h1>教程</h1></body></html>
      ]]></content:encoded>
    </item>
  </channel>
</rss>`;

    const parsed = parseFeed(feed);
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0]!.title).toBe('HTML 入门');
  });

  it('**注释里的字面量 `<!DOCTYPE` 不误伤**', () => {
    const feed = `<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>
<!-- 生成器备注：<!DOCTYPE html> 是标准开头 -->
<item><title>a</title><link>https://example.com/1</link></item>
</channel></rss>`;
    expect(parseFeed(feed).entries).toHaveLength(1);
  });

  it('是合法 XML 但不是 feed 时明确抛错（而不是返回 0 条）', () => {
    expect(() => parseFeed(XML_BUT_NOT_A_FEED)).toThrow(/neither RSS, Atom nor RSS 1\.0/i);
  });

  it('带 DOCTYPE 的 feed 在解析前就被拒绝', () => {
    expect(() => rejectDoctype(DOCTYPE_FEED)).toThrow(/DOCTYPE/i);
    expect(() => parseFeed(DOCTYPE_FEED)).toThrow(/DOCTYPE/i);
  });

  it('正文里**转义后**的 `<!DOCTYPE` 文本不会误伤（XML 里字面量必须转义）', () => {
    const feed = `<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>
<item><title>关于 &lt;!DOCTYPE html&gt; 的教程</title><link>https://example.com/x</link></item>
</channel></rss>`;
    expect(() => parseFeed(feed)).not.toThrow();
  });

  it('十亿笑声载荷不会膨胀（实测：FXP 不加载 DTD）', () => {
    const startedAt = Date.now();
    // 无论抛错还是解析成功，都**不能**产生海量内容 —— 那会 OOM。
    let title: string | null;
    try {
      title = parseFeed(BILLION_LAUGHS).entries[0]?.title ?? null;
    } catch {
      // 被 DOCTYPE 守卫拦下也是可接受的结果 —— 重点是**不能**膨胀。
      title = null;
    }
    expect(Date.now() - startedAt).toBeLessThan(3_000);
    // 如果解析成功了，实体没有被展开 —— 长度必须远小于 10^9。
    expect((title ?? '').length).toBeLessThan(1_000);
  });
});

describe('parseDate', () => {
  it('RFC 822（RSS pubDate）', () => {
    expect(parseDate('Thu, 24 Sep 2026 01:24:00 +0000')?.toISOString()).toBe(
      '2026-09-24T01:24:00.000Z',
    );
  });

  it('RFC 822 允许单字母时区与省略秒', () => {
    expect(parseDate('Thu, 24 Sep 2026 01:24 GMT')?.toISOString()).toBe('2026-09-24T01:24:00.000Z');
  });

  it('ISO 8601（Atom published）', () => {
    expect(parseDate('2026-09-23T17:12:27+00:00')?.toISOString()).toBe('2026-09-23T17:12:27.000Z');
  });

  it('解析不出来返回 null，**不是** Invalid Date', () => {
    // 这一条很重要：Invalid Date 写进库之后，所有日期比较都会静默返回 false，
    // 去重与排序一起失效。
    expect(parseDate('')).toBeNull();
    expect(parseDate('   ')).toBeNull();
    expect(parseDate('not a date')).toBeNull();
    expect(parseDate(null)).toBeNull();
  });
});
