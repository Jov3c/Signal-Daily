/**
 * Feed fixture —— **形状来自真实响应，不是照着规范编的**。
 *
 * 来源：`work/_agent04/probe-upstreams.json`（2026-09-24 实测抓取）。
 * 每个 fixture 顶部注明它复刻的是哪个真实源、以及它专门用来钉住哪一点。
 *
 * §23.3 的教训在这里是硬约束：Agent 01 的 FULLTEXT 用例用了纯 ASCII 探针，
 * 于是「全绿」只证明了拉丁文可用，中文搜索实际恒返回 0 条。
 * 因此这里的正文一律是**中文**，标题里带实体与 CDATA，
 * 与 Signal 的真实数据形态一致。
 */

/**
 * RSS 2.0 —— 复刻 hnrss.org/frontpage。
 *
 * 钉住的点：
 *   - `<title><![CDATA[...]]></title>`：CDATA 必须能取到内容；
 *   - `<guid isPermaLink="false">`：**带属性的元素会被解析成对象**，
 *     不处理的话 externalId 会变成 `[object Object]`；
 *   - `<dc:creator>`：命名空间前缀必须保留；
 *   - `pubDate` 是 RFC 822（不是 ISO 8601）；
 *   - `description` 里是 HTML（采集端**不**清洗，见 markup.ts 的说明）。
 */
export const RSS_2_0_HNRSS = `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>Hacker News: Front Page</title>
    <link>https://news.ycombinator.com/</link>
    <description>Hacker News RSS</description>
    <language>en-us</language>
    <lastBuildDate>Thu, 24 Sep 2026 03:25:05 +0000</lastBuildDate>
    <item>
      <title><![CDATA[Australia says OpenAI agent hacked into government website]]></title>
      <description><![CDATA[<p>Article URL: <a href="https://example.com/a">https://example.com/a</a></p><p>Comments URL: <a href="https://news.ycombinator.com/item?id=49825024">https://news.ycombinator.com/item?id=49825024</a></p>]]></description>
      <pubDate>Thu, 24 Sep 2026 01:24:00 +0000</pubDate>
      <link>https://example.com/a</link>
      <dc:creator>doppp</dc:creator>
      <guid isPermaLink="false">https://news.ycombinator.com/item?id=49825024</guid>
    </item>
    <item>
      <title><![CDATA[模型评测：推理成本与基础模型的能力边界]]></title>
      <description><![CDATA[<p>中文正文，含 <b>HTML</b> 与实体 &amp; &#8217; 引号。</p>]]></description>
      <pubDate>Thu, 24 Sep 2026 01:10:00 +0000</pubDate>
      <link>/relative/post-2</link>
      <guid isPermaLink="false">https://news.ycombinator.com/item?id=49824999</guid>
    </item>
  </channel>
</rss>`;

/**
 * RSS 2.0 + `content:encoded` —— 复刻 github.blog/feed。
 *
 * 钉住的点：正文优先取 `content:encoded`（完整正文），
 * 而不是 `description`（常常只是一句摘要）。
 */
export const RSS_2_0_CONTENT_ENCODED = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
  xmlns:content="http://purl.org/rss/1.0/modules/content/"
  xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>The GitHub Blog</title>
    <link>https://github.blog/</link>
    <item>
      <title>Copilot 现在支持中文代码注释</title>
      <link>https://github.blog/news/copilot-chinese/</link>
      <dc:creator>GitHub Staff</dc:creator>
      <pubDate>Wed, 23 Sep 2026 18:29:54 +0000</pubDate>
      <description>一句话摘要</description>
      <content:encoded><![CDATA[<p>这是完整正文，比摘要长得多。</p>]]></content:encoded>
      <guid isPermaLink="true">https://github.blog/news/copilot-chinese/</guid>
    </item>
  </channel>
</rss>`;

/**
 * Atom 1.0 —— 复刻 simonwillison.net/atom/everything/。
 *
 * 钉住的点：
 *   - **XML 声明 `<?xml …?>`**：不关掉声明解析，它会变成文档对象里的
 *     第一个键（实测是 `?xml`），`Object.keys(doc)[0]` 会拿到它；
 *   - `<link href="…" rel="alternate"/>`：链接在**属性**里；
 *   - `<summary type="html">`：带属性 → 解析成对象，直接用会得到 `[object Object]`；
 *   - **作者只在 feed 级**，条目级没有 —— 逐条读 `entry.author` 会全是 null；
 *   - `xml:lang` 在 feed 级。
 */
export const ATOM_SIMONWILLISON = `<?xml version="1.0" encoding="utf-8"?>
<feed xml:lang="en-us" xmlns="http://www.w3.org/2005/Atom">
  <title>Simon Willison's Weblog</title>
  <link href="http://simonwillison.net/" rel="alternate"/>
  <link href="http://simonwillison.net/atom/everything/" rel="self"/>
  <id>http://simonwillison.net/</id>
  <updated>2026-09-23T17:12:27+00:00</updated>
  <author><name>Simon Willison</name></author>
  <entry>
    <title>Gemini 3.8 TTS Playground</title>
    <link href="https://simonwillison.net/2026/Sep/23/gemini-tts-playground/" rel="alternate"/>
    <published>2026-09-23T17:12:27+00:00</published>
    <updated>2026-09-23T17:12:27+00:00</updated>
    <id>https://simonwillison.net/2026/Sep/23/gemini-tts-playground/</id>
    <summary type="html">A new playground for testing text-to-speech 的中文说明。</summary>
  </entry>
  <entry>
    <title>条目级作者覆盖 feed 级作者</title>
    <link href="https://simonwillison.net/2026/Sep/22/other/"/>
    <author><name>Guest Author</name></author>
    <updated>2026-09-22T10:00:00+00:00</updated>
    <id>https://simonwillison.net/2026/Sep/22/other/</id>
    <content type="html">&lt;p&gt;正文走 content 而不是 summary。&lt;/p&gt;</content>
  </entry>
</feed>`;

/**
 * 只含**一个** item 的 RSS。
 *
 * 钉住的点：fast-xml-parser 在单元素时**不返回数组**。
 * 不强制数组的话 `entries.length` 是 undefined，采集会静默产出 0 条 ——
 * 而「只有一个 item 的 feed」在真实世界里很常见（一个刚发布的官方公告）。
 */
export const RSS_SINGLE_ITEM = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>只有一个条目的官方公告源</title>
    <link>https://example.com/</link>
    <item>
      <title>Anthropic 发布新模型</title>
      <link>https://example.com/announcement</link>
      <pubDate>Thu, 24 Sep 2026 00:00:00 +0000</pubDate>
      <guid>https://example.com/announcement</guid>
    </item>
  </channel>
</rss>`;

/** RSS 1.0 / RDF —— 条目挂在根下（不在 `channel` 里），id 在 `rdf:about` 属性上。 */
export const RSS_1_0_RDF = `<?xml version="1.0" encoding="utf-8"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
         xmlns="http://purl.org/rss/1.0/"
         xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel rdf:about="https://example.com/">
    <title>RSS 1.0 示例源</title>
    <link>https://example.com/</link>
  </channel>
  <item rdf:about="https://example.com/rdf-post-1">
    <title>RDF 格式的条目</title>
    <link>https://example.com/rdf-post-1</link>
    <dc:date>2026-09-24T01:00:00+00:00</dc:date>
    <dc:creator>rdf-author</dc:creator>
    <description>RDF 条目的描述。</description>
  </item>
</rdf:RDF>`;

/**
 * 没有 `pubDate` 的条目。
 *
 * 钉住的点：增量过滤**只在两边都有时间时**才比较。一律丢弃无日期的条目
 * 会让这类源永远采不到东西，而症状只是「这个源一直是空的」，极难定位。
 */
export const RSS_WITHOUT_DATES = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>无日期源</title>
    <item>
      <title>没有 pubDate 的条目</title>
      <link>https://example.com/no-date</link>
      <guid>no-date-guid</guid>
    </item>
  </channel>
</rss>`;

/** 标题里带实体与标签（XSS 形状）。 */
export const RSS_ENTITY_IN_TITLE = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>实体测试</title>
    <item>
      <title>A &amp; B &#8212; &lt;script&gt;alert(1)&lt;/script&gt; &amp;lt;b&amp;gt;x&amp;lt;/b&amp;gt;</title>
      <link>https://example.com/entities</link>
    </item>
  </channel>
</rss>`;

/** 不是 XML 的东西（上游维护时返回 HTML 错误页是常态）。 */
export const NOT_XML = `<!doctype html><html><body><h1>503 Service Unavailable</h1></body></html>`;

/** 结构正确但既不是 RSS 也不是 Atom。 */
export const XML_BUT_NOT_A_FEED = `<?xml version="1.0"?><root><child>hi</child></root>`;

/**
 * 带 DOCTYPE 的 feed。
 *
 * 钉住的点：`rejectDoctype()` 必须当场拒绝。feed 从来不需要 DTD，
 * 任何带 DTD 的输入都值得拒绝而不是「解析看看」。
 */
export const DOCTYPE_FEED = `<?xml version="1.0"?>
<!DOCTYPE rss [<!ENTITY x "y">]>
<rss version="2.0"><channel><title>t</title>
<item><title>&x;</title><link>https://example.com/x</link></item>
</channel></rss>`;

/** 畸形 XML（标签未闭合）。 */
export const MALFORMED_XML = `<?xml version="1.0"?><rss version="2.0"><channel><item></channel></rss>`;

/**
 * 「十亿笑声」实体膨胀攻击载荷。
 *
 * 钉住的点：**不靠假设**「fast-xml-parser 不解析 DTD」。这个载荷
 * 如果被解析成 10^9 个字符，进程会直接 OOM。实测结果见
 * `work/_agent04/probe-xml-safety.mjs`：FXP 不加载 DTD，载荷原样落空。
 * 另外 `DOCTYPE_FEED` 也会在解析前就被 `rejectDoctype()` 拦下。
 */
export const BILLION_LAUGHS = `<?xml version="1.0"?>
<!DOCTYPE lolz [
 <!ENTITY lol "lol">
 <!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">
 <!ENTITY lol3 "&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;">
 <!ENTITY lol4 "&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;">
 <!ENTITY lol5 "&lol4;&lol4;&lol4;&lol4;&lol4;&lol4;&lol4;&lol4;&lol4;&lol4;">
 <!ENTITY lol6 "&lol5;&lol5;&lol5;&lol5;&lol5;&lol5;&lol5;&lol5;&lol5;&lol5;">
 <!ENTITY lol7 "&lol6;&lol6;&lol6;&lol6;&lol6;&lol6;&lol6;&lol6;&lol6;&lol6;">
 <!ENTITY lol8 "&lol7;&lol7;&lol7;&lol7;&lol7;&lol7;&lol7;&lol7;&lol7;&lol7;">
 <!ENTITY lol9 "&lol8;&lol8;&lol8;&lol8;&lol8;&lol8;&lol8;&lol8;&lol8;&lol8;">
]>
<rss version="2.0"><channel><title>&lol9;</title>
<item><title>&lol9;</title><link>https://example.com/lol</link></item>
</channel></rss>`;

/* ------------------------------------------------------------------ */
/* 厂商 API 的 JSON 响应                                                */
/* ------------------------------------------------------------------ */

/** 复刻 `GET /repos/nodejs/node/releases?per_page=2`（实测键名）。 */
export const GITHUB_RELEASES_JSON = JSON.stringify([
  {
    id: 394939147,
    tag_name: 'v22.23.3',
    name: "2026-09-23, Version 22.23.3 'Jod' (LTS)",
    html_url: 'https://github.com/nodejs/node/releases/tag/v22.23.3',
    published_at: '2026-09-23T18:21:37Z',
    draft: false,
    prerelease: false,
    author: { login: 'aduh95' },
    body: '### Notable Changes\n* crypto: update root certificates',
  },
  {
    id: 394900000,
    tag_name: 'v23.0.0-nightly',
    name: 'Nightly build',
    html_url: 'https://github.com/nodejs/node/releases/tag/v23.0.0-nightly',
    published_at: '2026-09-22T02:00:00Z',
    draft: true,
    prerelease: true,
    author: { login: 'nodejs-bot' },
    body: 'draft release must never be collected',
  },
]);

/** 复刻 `GET /repos/nodejs/node`。 */
export const GITHUB_REPO_JSON = JSON.stringify({
  full_name: 'nodejs/node',
  html_url: 'https://github.com/nodejs/node',
  description: 'Node.js JavaScript runtime',
  language: 'JavaScript',
  stargazers_count: 110000,
  homepage: 'https://nodejs.org',
  owner: { login: 'nodejs' },
});

/** 复刻 HN `/v0/topstories.json`（前几项，实测是纯数字数组）。 */
export const HN_STORIES_JSON = JSON.stringify([49824686, 49823582, 49820134]);

/** 复刻 HN `/v0/item/{id}.json`（story；`url` 为 null 即 Ask HN 自帖）。 */
export function hnItemJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: 49824686,
    by: 'nmeagent',
    time: 1790210491,
    title: 'Feds Target AI Critics as "Foreign Agents"',
    url: 'https://example.com/hn-story',
    score: 98,
    descendants: 61,
    type: 'story',
    ...overrides,
  });
}

/** Hugging Face commit 列表（**形状未经实测**，见适配器文件头的说明）。 */
export const HF_COMMITS_JSON = JSON.stringify([
  {
    id: 'a1b2c3d4e5f6',
    title: 'Add model card',
    message: 'Add model card\n\nwith details',
    date: '2026-09-23T10:00:00.000Z',
    authors: [{ user: 'hf-user', name: 'HF User' }],
  },
]);

/** X 用户查找响应。 */
export const X_USER_JSON = JSON.stringify({
  data: { id: '1234567', name: 'Andrej Karpathy', username: 'karpathy' },
});

/**
 * X 时间线响应 —— 四种类型各一条。
 *
 * 钉住的点：`exclude` 参数只能排除 replies / retweets，**没有**排除 quote 的选项。
 * 所以响应侧必须自己按 `referenced_tweets[].type` 过滤。
 */
export const X_TWEETS_JSON = JSON.stringify({
  data: [
    {
      id: '1900000000000000001',
      text: '原创帖子：关于模型推理成本的中文讨论。',
      created_at: '2026-09-24T01:00:00.000Z',
      lang: 'zh',
      public_metrics: { like_count: 10, reply_count: 1, retweet_count: 2, quote_count: 0 },
      conversation_id: '1900000000000000001',
    },
    {
      id: '1900000000000000002',
      text: '引用转发：这条应该按 includeQuotes 决定去留。',
      created_at: '2026-09-24T01:05:00.000Z',
      lang: 'zh',
      referenced_tweets: [{ type: 'quoted', id: '1899999999999999999' }],
    },
    {
      id: '1900000000000000003',
      text: '@someone 这是一条回复，默认应当被排除。',
      created_at: '2026-09-24T01:06:00.000Z',
      lang: 'zh',
      referenced_tweets: [{ type: 'replied_to', id: '1899999999999999998' }],
    },
    {
      id: '1900000000000000004',
      text: 'RT @someone 这是纯转发，默认应当被排除。',
      created_at: '2026-09-24T01:07:00.000Z',
      lang: 'zh',
      referenced_tweets: [{ type: 'retweeted', id: '1899999999999999997' }],
    },
  ],
  meta: { result_count: 4 },
});

/** X 对一个没有新推文的账号的响应：**没有 `data` 字段**（不是空数组）。 */
export const X_EMPTY_TIMELINE_JSON = JSON.stringify({
  meta: { result_count: 0, newest_id: '1900000000000000001' },
});

/** 一个真实形态的 HTML 页面（MANUAL_URL 用）。 */
export const HTML_PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <title>页面标题 - 某科技媒体</title>
  <meta property="og:title" content="OpenAI 发布新的推理模型">
  <meta property="og:description" content="这是摘要">
  <script>window.__DATA__ = {"tracking":"should-not-matter"};</script>
  <style>body { color: #333 }</style>
</head>
<body>
  <h1>正文里的标题</h1>
  <p>这是正文，包含 <b>HTML</b>。</p>
</body>
</html>`;
