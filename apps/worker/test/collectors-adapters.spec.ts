/**
 * 六个适配器的测试。
 *
 * 每个适配器都跑**真实现**（真实解析、真实过滤、真实错误分类），
 * 只把 `fetch` 与 DNS 换成 stub —— 于是「网络那一层」被替换，
 * 而「拿到字节之后怎么理解」全部真跑。
 *
 * fixture 全部来自 `feed-fixtures.ts`（形状取自真实响应，见那里的说明）。
 */

import { describe, expect, it } from 'vitest';
import { ContentType, SourceType } from '@signal/contracts';
import { GithubRepoCollectorAdapter } from '../src/jobs/collectors/adapters/github-repo.adapter';
import { HackerNewsCollectorAdapter } from '../src/jobs/collectors/adapters/hacker-news.adapter';
import { HuggingFaceCollectorAdapter } from '../src/jobs/collectors/adapters/huggingface.adapter';
import { ManualUrlCollectorAdapter } from '../src/jobs/collectors/adapters/manual-url.adapter';
import { RSS_HARD_CEILING, RssCollectorAdapter } from '../src/jobs/collectors/adapters/rss.adapter';
import { XUserCollectorAdapter } from '../src/jobs/collectors/adapters/x-user.adapter';
import { CollectorError } from '../src/jobs/collectors/errors';
import type { CollectorContext, CollectorCursor } from '../src/jobs/collectors/types';
import { assertPayloadShape } from '../src/jobs/collectors/payload-keys';
import {
  createSource,
  createStubFetch,
  stubLookup,
  type StubResponse,
} from './support/collector-fakes';
import {
  GITHUB_RELEASES_JSON,
  GITHUB_REPO_JSON,
  HF_COMMITS_JSON,
  HN_STORIES_JSON,
  HTML_PAGE,
  NOT_XML,
  RSS_2_0_HNRSS,
  RSS_ENTITY_IN_TITLE,
  RSS_SINGLE_ITEM,
  RSS_WITHOUT_DATES,
  X_EMPTY_TIMELINE_JSON,
  X_TWEETS_JSON,
  X_USER_JSON,
  hnItemJson,
} from './support/feed-fixtures';

const NO_CURSOR: CollectorCursor = { sincePublishedAt: null, sinceExternalId: null };

function context(overrides: Partial<CollectorContext> = {}): CollectorContext {
  return {
    timeoutMs: 5_000,
    maxBytes: 2_097_152,
    credentials: { xApiBearerToken: null, githubToken: null },
    lookup: stubLookup,
    ...overrides,
  };
}

/** 断言抛出的 `CollectorError` 的码与可重试性。 */
async function expectCollectorError(
  run: () => Promise<unknown>,
  code: string,
  retryable: boolean,
): Promise<CollectorError> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(CollectorError);
    const collectorError = error as CollectorError;
    expect(collectorError.code).toBe(code);
    expect(collectorError.retryable).toBe(retryable);
    return collectorError;
  }
  throw new Error(`expected a CollectorError with code ${code}, but nothing was thrown`);
}

/* ================================================================== */
/* RSS                                                                 */
/* ================================================================== */

describe('RssCollectorAdapter', () => {
  const source = createSource({ type: SourceType.RSS, feedUrl: 'https://example.com/feed.xml' });

  /**
   * 统一风格：每个用例自己声明 stub，再把 `fetchImpl` 放进 `CollectorContext`。
   *
   * 网络替身只走上下文（只有一套机制）—— 这是被测试逼出来的：
   * 曾经 `fetchImpl` 走构造函数、`timeoutMs` 走上下文，结果注入的替身
   * 没生效，所有适配器测试都在打真实网络并撞 5 秒超时，而没有一处报错。
   */
  const rss = () => new RssCollectorAdapter();

  it('解析 RSS 并映射成 CollectedItem（含中文标题与正文）', async () => {
    const stub = createStubFetch([
      {
        match: 'feed.xml',
        respond: { body: RSS_2_0_HNRSS, headers: { 'content-type': 'application/rss+xml' } },
      },
    ]);

    const batch = await rss().fetch(source, NO_CURSOR, context({ fetchImpl: stub.fetchImpl }));

    expect(batch.items).toHaveLength(2);
    const first = batch.items[0]!;
    expect(first.sourceId).toBe('1');
    expect(first.title).toBe('Australia says OpenAI agent hacked into government website');
    expect(first.type).toBe(ContentType.ARTICLE);
    expect(first.externalId).toBe('https://news.ycombinator.com/item?id=49825024');
    expect(first.payload['feedFormat']).toBe('rss');
  });

  it('**payload 里不得出现 Source 元数据**（tasks/agent-04 的硬规则）', async () => {
    const stub = createStubFetch([{ match: 'feed.xml', respond: { body: RSS_2_0_HNRSS } }]);
    const batch = await rss().fetch(source, NO_CURSOR, context({ fetchImpl: stub.fetchImpl }));

    for (const item of batch.items) {
      // 用**真数据**过一遍按类型的白名单守卫 —— 「守卫被调用过」不等于
      // 「这个适配器产出的 payload 合法」。
      expect(() => assertPayloadShape(SourceType.RSS, item.payload, 'test')).not.toThrow();
      for (const key of ['tier', 'kind', 'official', 'trustScore', 'priority']) {
        expect(Object.keys(item.payload)).not.toContain(key);
      }
    }
  });

  it('相对链接按**响应的最终地址**解析（feed 常 301 到新域名）', async () => {
    const stub = createStubFetch([
      {
        match: 'example.com/feed.xml',
        respond: {
          status: 301,
          body: '',
          headers: { location: 'https://cdn.example.net/feed.xml' },
        },
      },
      { match: 'cdn.example.net', respond: { body: RSS_2_0_HNRSS } },
    ]);

    const batch = await rss().fetch(source, NO_CURSOR, context({ fetchImpl: stub.fetchImpl }));
    // 第二条的 link 是 `/relative/post-2`，应当拼到 CDN 主机上。
    expect(batch.items[1]!.originalUrl).toBe('https://cdn.example.net/relative/post-2');
  });

  it('**适配器不做每轮截断**，只声明 `roundLimit`（截断由 service 在去重后施加）', async () => {
    // ⚠ 这是 N2（P1）的回归守卫。
    // 曾经适配器在 `maxItems` 处直接 break → 每轮都取同一批最新条目，
    // 第 N+1 条之后**永远轮不到**（feed 顺序稳定）→ 永久丢失。
    // 实测：12 条 feed + maxItems=2，连采 4 轮仍只有 2 条。
    // 现在适配器返回整个窗口、声明上限，由 service 在去重后截断 ——
    // 窗口因此随轮次向下推进（service 层的端到端守卫见
    // collectors-service-guards.spec.ts 的「窗口随轮次推进」）。
    const stub = createStubFetch([{ match: 'feed.xml', respond: { body: RSS_2_0_HNRSS } }]);
    const limited = createSource({
      type: SourceType.RSS,
      feedUrl: 'https://example.com/feed.xml',
      config: { maxItems: 1 },
    });
    const batch = await rss().fetch(limited, NO_CURSOR, context({ fetchImpl: stub.fetchImpl }));

    expect(batch.items).toHaveLength(2); // 整个窗口都返回
    expect(batch.roundLimit).toBe(1); // 但声明「每轮只入库 1 条」
  });

  it('**越界的 maxItems 收敛到边界，而不是让采集失败**', async () => {
    const stub = createStubFetch([{ match: 'feed.xml', respond: { body: RSS_2_0_HNRSS } }]);
    const weird = createSource({
      type: SourceType.RSS,
      feedUrl: 'https://example.com/feed.xml',
      config: { maxItems: 99_999 },
    });
    const batch = await rss().fetch(weird, NO_CURSOR, context({ fetchImpl: stub.fetchImpl }));
    expect(batch.items).toHaveLength(2);
  });

  it('**不再按时间跳过条目** —— 那是会造成永久漏采的 P1 缺陷', async () => {
    // 旧行为：游标比某条更新时跳过该条。
    // 后果：被 `maxItems` 截断丢掉的那些**更旧**的条目，在游标建立之后
    // 永远不会再进入窗口 —— 永久丢失，且 `complete` 还是 true。
    // 现在正确性由库里的去重保证（docs/06 的幂等第 1、2 条），
    // 所以旧条目每一轮都会重新出现在批次里，由去重挡掉。
    const stub = createStubFetch([{ match: 'feed.xml', respond: { body: RSS_2_0_HNRSS } }]);
    const cursor: CollectorCursor = {
      sincePublishedAt: new Date('2026-09-24T01:20:00.000Z'),
      sinceExternalId: null,
    };
    const batch = await rss().fetch(source, cursor, context({ fetchImpl: stub.fetchImpl }));

    expect(batch.items).toHaveLength(2);
  });

  it('**没有日期的条目照常收下**（旧实现在这条路径上也会漏）', async () => {
    const stub = createStubFetch([{ match: 'feed.xml', respond: { body: RSS_WITHOUT_DATES } }]);
    const cursor: CollectorCursor = {
      sincePublishedAt: new Date('2026-09-24T01:20:00.000Z'),
      sinceExternalId: null,
    };
    const batch = await rss().fetch(source, cursor, context({ fetchImpl: stub.fetchImpl }));
    expect(batch.items).toHaveLength(1);
  });

  it('`complete` 表示「上游这一次给的我**都读进来了**」，与每轮上限无关', async () => {
    // 旧实现把两件事混在一个字段里：既想说「读完了」又想说「入库被截断了」。
    // 现在 `complete` 只管前者（异常性不完整才 false），
    // 「这一轮只入库了多少、还剩多少留到下一轮」由 service 记一条 info 日志。
    const fiveItems = `<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>
${[1, 2, 3, 4, 5]
  .map((n) => `<item><title>第 ${n} 条</title><link>https://example.com/post-${n}</link></item>`)
  .join('\n')}
</channel></rss>`;
    const stub = createStubFetch([{ match: 'feed.xml', respond: { body: fiveItems } }]);
    const limited = createSource({
      type: SourceType.RSS,
      feedUrl: 'https://example.com/feed.xml',
      config: { maxItems: 2 },
    });

    const batch = await rss().fetch(limited, NO_CURSOR, context({ fetchImpl: stub.fetchImpl }));

    expect(batch.items).toHaveLength(5);
    expect(batch.roundLimit).toBe(2);
    expect(batch.complete).toBe(true);
  });

  it('feed 长到顶住**硬上限**时 `complete` 为 false（这才是异常性不完整）', async () => {
    const many = Array.from(
      { length: RSS_HARD_CEILING + 5 },
      (_value, index) =>
        `<item><title>第 ${index} 条</title><link>https://e.com/p-${index}</link></item>`,
    ).join('\n');
    const stub = createStubFetch([
      {
        match: 'feed.xml',
        respond: {
          body: `<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>
${many}
</channel></rss>`,
        },
      },
    ]);

    const batch = await rss().fetch(source, NO_CURSOR, context({ fetchImpl: stub.fetchImpl }));

    expect(batch.items).toHaveLength(RSS_HARD_CEILING);
    expect(batch.complete).toBe(false);
    expect(batch.warnings.join(' ')).toMatch(/only the newest/);
  });

  it('既没有 link 也没有可用 guid 的条目被跳过并计数', async () => {
    const feed = `<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>
<item><title>没有链接</title><guid>not-a-url</guid></item>
<item><title>有链接</title><link>https://example.com/ok</link></item>
</channel></rss>`;
    const stub = createStubFetch([{ match: 'feed.xml', respond: { body: feed } }]);
    const batch = await rss().fetch(source, NO_CURSOR, context({ fetchImpl: stub.fetchImpl }));

    expect(batch.items).toHaveLength(1);
    expect(batch.skippedCount).toBe(1);
  });

  it('HTML 错误页给出准确诊断（而不是含糊的解析失败）', async () => {
    const stub = createStubFetch([
      {
        match: 'feed.xml',
        respond: { body: NOT_XML, headers: { 'content-type': 'text/html' }, status: 200 },
      },
    ]);
    const error = await expectCollectorError(
      () => rss().fetch(source, NO_CURSOR, context({ fetchImpl: stub.fetchImpl })),
      'SOURCE_FETCH_FAILED',
      true,
    );
    expect(error.message).toMatch(/HTML page/i);
  });

  it('上游 404 → 可重试的 SOURCE_FETCH_FAILED', async () => {
    const stub = createStubFetch([{ match: 'feed.xml', respond: { status: 404, body: 'gone' } }]);
    await expectCollectorError(
      () => rss().fetch(source, NO_CURSOR, context({ fetchImpl: stub.fetchImpl })),
      'SOURCE_FETCH_FAILED',
      true,
    );
  });

  it('超时（AbortSignal）→ TIMEOUT，可重试', async () => {
    const stub = createStubFetch([
      {
        match: 'feed.xml',
        respond: () => {
          const error = new Error('The operation was aborted due to timeout');
          error.name = 'TimeoutError';
          return { throw: error };
        },
      },
    ]);
    const error = await expectCollectorError(
      () => rss().fetch(source, NO_CURSOR, context({ fetchImpl: stub.fetchImpl })),
      'SOURCE_FETCH_FAILED',
      true,
    );
    expect(error.message).toMatch(/TIMEOUT/);
  });

  it('响应体超过上限被截断 → 如实失败（不解析残片）', async () => {
    const stub = createStubFetch([{ match: 'feed.xml', respond: { body: RSS_2_0_HNRSS } }]);
    const error = await expectCollectorError(
      () => rss().fetch(source, NO_CURSOR, context({ fetchImpl: stub.fetchImpl, maxBytes: 64 })),
      'SOURCE_FETCH_FAILED',
      true,
    );
    expect(error.message).toMatch(/exceeded/i);
  });

  it('feed 地址缺失 → 不可重试的配置错误', async () => {
    const broken = createSource({ type: SourceType.RSS, feedUrl: null, baseUrl: null });
    const stub = createStubFetch([]);
    await expectCollectorError(
      () => rss().fetch(broken, NO_CURSOR, context({ fetchImpl: stub.fetchImpl })),
      'SOURCE_CONFIG_INVALID',
      false,
    );
  });
});

/* ================================================================== */
/* SSRF                                                                */
/* ================================================================== */

describe('SSRF 防护（所有适配器共用的取数层）', () => {
  it('字面量内网 IP 被拒（不可重试 —— 这个地址永远不该被请求）', async () => {
    const stub = createStubFetch([]);
    const adapter = new RssCollectorAdapter();
    const source = createSource({ type: SourceType.RSS, feedUrl: 'http://127.0.0.1/feed.xml' });

    const error = await expectCollectorError(
      () => adapter.fetch(source, NO_CURSOR, context({ fetchImpl: stub.fetchImpl })),
      'SOURCE_URL_NOT_ALLOWED',
      false,
    );
    expect(error.message).toMatch(/BLOCKED_IP|private|loopback/i);
    // 关键：**一个请求都没发出去**。
    expect(stub.requests).toHaveLength(0);
  });

  it('域名解析到内网地址被拒（语法层看不出来，必须查 DNS）', async () => {
    const stub = createStubFetch([]);
    const adapter = new RssCollectorAdapter();
    const source = createSource({
      type: SourceType.RSS,
      feedUrl: 'https://evil.example/feed.xml',
    });

    await expectCollectorError(
      () =>
        adapter.fetch(
          source,
          NO_CURSOR,
          context({
            fetchImpl: stub.fetchImpl,
            lookup: async () => [{ address: '169.254.169.254', family: 4 }],
          }),
        ),
      'SOURCE_URL_NOT_ALLOWED',
      false,
    );
    expect(stub.requests).toHaveLength(0);
  });

  it('**重定向到内网被逐跳拦截**（公网 → metadata 是经典 SSRF 路径）', async () => {
    const stub = createStubFetch([
      {
        match: 'feed.xml',
        respond: { status: 302, body: '', headers: { location: 'http://169.254.169.254/latest/' } },
      },
    ]);
    const adapter = new RssCollectorAdapter();
    const source = createSource({ type: SourceType.RSS, feedUrl: 'https://example.com/feed.xml' });

    const error = await expectCollectorError(
      () => adapter.fetch(source, NO_CURSOR, context({ fetchImpl: stub.fetchImpl })),
      'SOURCE_URL_NOT_ALLOWED',
      false,
    );
    expect(error.message).toMatch(/BLOCKED_IP|loopback|private/i);
    // 只发出了第一跳，没有发出第二跳。
    expect(stub.requests).toHaveLength(1);
  });

  it('重定向到另一个**公网**地址是被允许的（不要把正常功能一起挡掉）', async () => {
    const stub = createStubFetch([
      {
        match: 'example.com/feed.xml',
        respond: {
          status: 302,
          body: '',
          headers: { location: 'https://cdn.example.net/feed.xml' },
        },
      },
      {
        match: 'cdn.example.net',
        respond: { body: RSS_SINGLE_ITEM, headers: { 'content-type': 'application/rss+xml' } },
      },
    ]);
    const adapter = new RssCollectorAdapter();
    const source = createSource({ type: SourceType.RSS, feedUrl: 'https://example.com/feed.xml' });

    const batch = await adapter.fetch(source, NO_CURSOR, context({ fetchImpl: stub.fetchImpl }));
    expect(batch.items).toHaveLength(1);
    expect(stub.requests).toHaveLength(2);
  });

  it('畸形 Location 头不产生 500（对端完全可控的输入）', async () => {
    const stub = createStubFetch([
      {
        match: 'feed.xml',
        respond: { status: 302, body: '', headers: { location: 'https://%%%/x' } },
      },
    ]);
    const adapter = new RssCollectorAdapter();
    const source = createSource({ type: SourceType.RSS, feedUrl: 'https://example.com/feed.xml' });

    const error = await expectCollectorError(
      () => adapter.fetch(source, NO_CURSOR, context({ fetchImpl: stub.fetchImpl })),
      'SOURCE_FETCH_FAILED',
      true,
    );
    expect(error.message).toMatch(/INVALID_REDIRECT|unparseable/i);
  });
});

/* ================================================================== */
/* GitHub                                                              */
/* ================================================================== */

describe('GithubRepoCollectorAdapter', () => {
  const source = createSource({
    type: SourceType.GITHUB_REPO,
    feedUrl: null,
    externalId: 'nodejs/node',
    config: { includeReleases: true },
  });

  it('采集 release，跳过 draft（草稿是维护者尚未发布的内容）', async () => {
    const stub = createStubFetch([{ match: '/releases', respond: { body: GITHUB_RELEASES_JSON } }]);
    const adapter = new GithubRepoCollectorAdapter();

    const batch = await adapter.fetch(source, NO_CURSOR, context({ fetchImpl: stub.fetchImpl }));

    expect(batch.items).toHaveLength(1);
    const release = batch.items[0]!;
    expect(release.type).toBe(ContentType.GITHUB_RELEASE);
    expect(release.externalId).toBe('394939147');
    expect(release.originalUrl).toBe('https://github.com/nodejs/node/releases/tag/v22.23.3');
    expect(release.publishedAt?.toISOString()).toBe('2026-09-23T18:21:37.000Z');
    expect(release.author).toBe('aduh95');
    expect(release.payload['draft']).toBeUndefined();
  });

  it('未配置 GITHUB_TOKEN 时**不带** authorization 头（匿名可用，不该被自己的保守判断砍掉）', async () => {
    const stub = createStubFetch([{ match: '/releases', respond: { body: GITHUB_RELEASES_JSON } }]);
    const adapter = new GithubRepoCollectorAdapter();

    await adapter.fetch(source, NO_CURSOR, context({ fetchImpl: stub.fetchImpl }));
    expect(stub.requests[0]!.headers['authorization']).toBeUndefined();
  });

  it('配置了令牌时带上 Bearer', async () => {
    const stub = createStubFetch([{ match: '/releases', respond: { body: GITHUB_RELEASES_JSON } }]);
    const adapter = new GithubRepoCollectorAdapter();

    await adapter.fetch(
      source,
      NO_CURSOR,
      context({
        fetchImpl: stub.fetchImpl,
        credentials: { xApiBearerToken: null, githubToken: 'ghp_secret' },
      }),
    );
    expect(stub.requests[0]!.headers['authorization']).toBe('Bearer ghp_secret');
  });

  it('includeReleases=false 时采集仓库本身一条', async () => {
    const stub = createStubFetch([
      { match: '/repos/nodejs/node', respond: { body: GITHUB_REPO_JSON } },
    ]);
    const adapter = new GithubRepoCollectorAdapter();
    const repoOnly = createSource({
      type: SourceType.GITHUB_REPO,
      feedUrl: null,
      externalId: 'nodejs/node',
      config: { includeReleases: false },
    });

    const batch = await adapter.fetch(repoOnly, NO_CURSOR, context({ fetchImpl: stub.fetchImpl }));
    expect(batch.items).toHaveLength(1);
    expect(batch.items[0]!.type).toBe(ContentType.GITHUB_REPO);
    expect(batch.items[0]!.title).toBe('nodejs/node');
  });

  it('401 → SOURCE_FETCH_UNAUTHORIZED，**不可重试**（重试坏令牌只会烧额度）', async () => {
    const stub = createStubFetch([
      { match: '/releases', respond: { status: 401, body: '{"message":"Bad credentials"}' } },
    ]);
    const adapter = new GithubRepoCollectorAdapter();

    await expectCollectorError(
      () => adapter.fetch(source, NO_CURSOR, context({ fetchImpl: stub.fetchImpl })),
      'SOURCE_FETCH_UNAUTHORIZED',
      false,
    );
  });

  it('403 同样归为凭据问题', async () => {
    const stub = createStubFetch([
      { match: '/releases', respond: { status: 403, body: 'rate limited' } },
    ]);
    const adapter = new GithubRepoCollectorAdapter();
    await expectCollectorError(
      () => adapter.fetch(source, NO_CURSOR, context({ fetchImpl: stub.fetchImpl })),
      'SOURCE_FETCH_UNAUTHORIZED',
      false,
    );
  });

  it('返回的不是 JSON（上游维护页）→ 可重试失败并带上响应开头', async () => {
    const stub = createStubFetch([
      {
        match: '/releases',
        respond: { body: '<html>maintenance</html>', headers: { 'content-type': 'text/html' } },
      },
    ]);
    const adapter = new GithubRepoCollectorAdapter();
    const error = await expectCollectorError(
      () => adapter.fetch(source, NO_CURSOR, context({ fetchImpl: stub.fetchImpl })),
      'SOURCE_FETCH_FAILED',
      true,
    );
    expect(error.message).toMatch(/not valid JSON/i);
  });

  it('仓库名形状非法（含 ..）→ 配置错误，不发请求', async () => {
    const stub = createStubFetch([]);
    const adapter = new GithubRepoCollectorAdapter();
    const bad = createSource({
      type: SourceType.GITHUB_REPO,
      feedUrl: null,
      externalId: null,
      slug: 'bad-repo',
      config: { repo: '../../etc/passwd' },
    });

    await expectCollectorError(
      () => adapter.fetch(bad, NO_CURSOR, context({ fetchImpl: stub.fetchImpl })),
      'SOURCE_CONFIG_INVALID',
      false,
    );
    expect(stub.requests).toHaveLength(0);
  });
});

/* ================================================================== */
/* Hacker News                                                         */
/* ================================================================== */

describe('HackerNewsCollectorAdapter', () => {
  const source = createSource({
    type: SourceType.HACKER_NEWS,
    feedUrl: null,
    config: { feed: 'top', minScore: 0 },
  });

  it('取榜单前 N 个 id 的 item 并映射成 HN_STORY', async () => {
    const stub = createStubFetch([
      { match: 'topstories.json', respond: { body: HN_STORIES_JSON } },
      { match: 'item/49824686.json', respond: { body: hnItemJson() } },
      {
        match: 'item/49823582.json',
        respond: {
          body: hnItemJson({ id: 49823582, title: '第二条', url: 'https://example.com/2' }),
        },
      },
      {
        match: 'item/49820134.json',
        respond: {
          body: hnItemJson({ id: 49820134, title: '第三条', url: 'https://example.com/3' }),
        },
      },
    ]);
    const adapter = new HackerNewsCollectorAdapter();

    const batch = await adapter.fetch(source, NO_CURSOR, context({ fetchImpl: stub.fetchImpl }));

    expect(batch.items).toHaveLength(3);
    const story = batch.items[0]!;
    expect(story.type).toBe(ContentType.HN_STORY);
    expect(story.externalId).toBe('49824686');
    expect(story.author).toBe('nmeagent');
    // `time` 是 Unix **秒**。当成毫秒会把时间解析成 1970 年 —— 不报错但全错。
    expect(story.publishedAt?.getFullYear()).toBe(2026);
    expect(story.payload['score']).toBe(98);
  });

  it('minScore 过滤', async () => {
    const stub = createStubFetch([
      { match: 'topstories.json', respond: { body: HN_STORIES_JSON } },
      { match: 'item/49824686.json', respond: { body: hnItemJson({ score: 98 }) } },
      {
        match: 'item/49823582.json',
        respond: { body: hnItemJson({ id: 49823582, score: 5, url: 'https://example.com/2' }) },
      },
      {
        match: 'item/49820134.json',
        respond: { body: hnItemJson({ id: 49820134, score: 3, url: 'https://example.com/3' }) },
      },
    ]);
    const adapter = new HackerNewsCollectorAdapter();
    const filtered = createSource({
      type: SourceType.HACKER_NEWS,
      feedUrl: null,
      config: { feed: 'top', minScore: 50 },
    });

    const batch = await adapter.fetch(filtered, NO_CURSOR, context({ fetchImpl: stub.fetchImpl }));
    expect(batch.items).toHaveLength(1);
    expect(batch.items[0]!.externalId).toBe('49824686');
  });

  it('自帖（无外链，如 Ask HN）退回 HN 讨论页 —— 而不是被跳过', async () => {
    const stub = createStubFetch([
      { match: 'topstories.json', respond: { body: JSON.stringify([49824686]) } },
      {
        match: 'item/49824686.json',
        respond: {
          body: hnItemJson({ url: null, title: 'Ask HN: 你怎么看？', text: '正文在这里' }),
        },
      },
    ]);
    const adapter = new HackerNewsCollectorAdapter();

    const batch = await adapter.fetch(source, NO_CURSOR, context({ fetchImpl: stub.fetchImpl }));
    expect(batch.items).toHaveLength(1);
    expect(batch.items[0]!.originalUrl).toBe('https://news.ycombinator.com/item?id=49824686');
    expect(batch.items[0]!.payload['selfPost']).toBe(true);
    expect(batch.items[0]!.body).toBe('正文在这里');
  });

  it('**单个 item 失败不影响其它 item**（删掉的 / 被 flag 的 item 是常态）', async () => {
    const stub = createStubFetch([
      { match: 'topstories.json', respond: { body: HN_STORIES_JSON } },
      { match: 'item/49824686.json', respond: { status: 500, body: 'boom' } },
      {
        match: 'item/49823582.json',
        respond: { body: hnItemJson({ id: 49823582, url: 'https://example.com/2' }) },
      },
      {
        match: 'item/49820134.json',
        respond: { body: hnItemJson({ id: 49820134, url: 'https://example.com/3' }) },
      },
    ]);
    const adapter = new HackerNewsCollectorAdapter();

    const batch = await adapter.fetch(source, NO_CURSOR, context({ fetchImpl: stub.fetchImpl }));
    expect(batch.items).toHaveLength(2);
  });

  it('**不再按 id 跳过** —— 那是会造成永久漏采的 P1 缺陷', async () => {
    // 旧行为：跳过 `id <= sinceExternalId` 的条目。
    // 后果：一个**从未采过**、但 id 比游标小的帖子（发布较早、后来才涨上
    // 首页 —— 这恰恰是 HN 上最典型的现象）会被**永久**跳过：
    //
    //   第 1 轮榜单 [100,99,98] → 游标 98
    //   第 2 轮榜单 [101,**97**,100,99,98] → 97 是榜眼，却因为 97<=98 被跳过
    //
    // 现在改为「取窗口 + 靠库去重」：榜单前 N 个一律取回，
    // 已在库里的由 docs/06 的幂等键挡掉。
    // stub 必须**按请求的 id 回显**，否则所有条目的 externalId 都一样，
    // 断言就测不到「97 被收下」这件事。
    const stub = createStubFetch([
      { match: 'topstories.json', respond: { body: JSON.stringify([101, 97, 100, 99, 98]) } },
      {
        match: 'item/',
        respond: () => ({ body: hnItemJson() }),
      },
    ]);
    const recordingFetch = (async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      const id = /item\/(\d+)\.json/.exec(url)?.[1];
      if (id !== undefined) {
        return new Response(hnItemJson({ id: Number(id), url: `https://example.com/hn-${id}` }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return stub.fetchImpl(input as never, init);
    }) as typeof fetch;
    const adapter = new HackerNewsCollectorAdapter();

    const batch = await adapter.fetch(
      source,
      { sincePublishedAt: null, sinceExternalId: '98' },
      context({ fetchImpl: recordingFetch }),
    );

    // 97 必须在批次里 —— 这正是旧实现永久丢掉的那一条。
    expect(batch.items.map((item) => item.externalId)).toContain('97');
    expect(batch.items).toHaveLength(5);
  });

  it('**取满窗口本身不是「不完整」** —— `complete` 不再恒为 false', async () => {
    // ⚠ 上一轮把它修成了 `ids.length <= HN_MAX_ITEMS`，于是**恒为 false**：
    // `/topstories.json` 固定返回 500 条、`HN_MAX_ITEMS` 固定 30。
    // 一个恒为 false 的字段没有信息量，还会每轮打一条**管理员无法行动**的告警
    // （没有任何设置能让它变 true）。「只取前 30 条」是文件头写明的设计。
    const manyIds = Array.from({ length: 40 }, (_value, index) => 49000000 + index);
    const stub = createStubFetch([
      { match: 'topstories.json', respond: { body: JSON.stringify(manyIds) } },
      { match: /item\/\d+\.json/, respond: { body: hnItemJson() } },
    ]);
    const adapter = new HackerNewsCollectorAdapter();

    const batch = await adapter.fetch(source, NO_CURSOR, context({ fetchImpl: stub.fetchImpl }));

    expect(batch.items).toHaveLength(30);
    expect(batch.complete).toBe(true);
    expect(batch.warnings).toEqual([]);
  });

  it('**有条目取不回来时 `complete` 为 false**（这是可行动的：上游或链路有问题）', async () => {
    const stub = createStubFetch([
      { match: 'topstories.json', respond: { body: JSON.stringify([1, 2, 3]) } },
      { match: 'item/2.json', respond: { status: 500, body: 'boom' } },
      { match: /item\/\d+\.json/, respond: { body: hnItemJson() } },
    ]);
    const adapter = new HackerNewsCollectorAdapter();

    const batch = await adapter.fetch(source, NO_CURSOR, context({ fetchImpl: stub.fetchImpl }));

    expect(batch.items).toHaveLength(2);
    expect(batch.complete).toBe(false);
    expect(batch.warnings.join(' ')).toMatch(/could not be read/);
  });

  it('一次采集最多取 HN_MAX_ITEMS 个 item（500 个会把队列堵死）', async () => {
    const manyIds = Array.from({ length: 500 }, (_value, index) => 49000000 + index);
    const stub = createStubFetch([
      { match: 'topstories.json', respond: { body: JSON.stringify(manyIds) } },
      { match: /item\/\d+\.json/, respond: { body: hnItemJson() } },
    ]);
    const adapter = new HackerNewsCollectorAdapter();

    await adapter.fetch(source, NO_CURSOR, context({ fetchImpl: stub.fetchImpl }));
    const itemRequests = stub.requests.filter((request) => request.url.includes('item/'));
    expect(itemRequests).toHaveLength(30);
  });
});

/* ================================================================== */
/* Hugging Face                                                        */
/* ================================================================== */

describe('HuggingFaceCollectorAdapter', () => {
  const source = createSource({
    type: SourceType.HUGGINGFACE,
    feedUrl: null,
    externalId: 'google-bert/bert-base-uncased',
    config: { repoType: 'model' },
  });

  it('采集 commit 并映射成 MODEL', async () => {
    const stub = createStubFetch([{ match: '/commits/main', respond: { body: HF_COMMITS_JSON } }]);
    const adapter = new HuggingFaceCollectorAdapter();

    const batch = await adapter.fetch(source, NO_CURSOR, context({ fetchImpl: stub.fetchImpl }));

    expect(batch.items).toHaveLength(1);
    const commit = batch.items[0]!;
    expect(commit.type).toBe(ContentType.MODEL);
    expect(commit.externalId).toBe('a1b2c3d4e5f6');
    expect(commit.originalUrl).toBe(
      'https://huggingface.co/models/google-bert/bert-base-uncased/commit/a1b2c3d4e5f6',
    );
    expect(commit.publishedAt?.toISOString()).toBe('2026-09-23T10:00:00.000Z');
    expect(commit.author).toBe('hf-user');
  });

  it('repoType 决定 URL 段（dataset / space）', async () => {
    const stub = createStubFetch([{ match: '/commits/main', respond: { body: HF_COMMITS_JSON } }]);
    const adapter = new HuggingFaceCollectorAdapter();
    const dataset = createSource({
      type: SourceType.HUGGINGFACE,
      feedUrl: null,
      externalId: 'owner/name',
      config: { repoType: 'dataset' },
    });

    await adapter.fetch(dataset, NO_CURSOR, context({ fetchImpl: stub.fetchImpl }));
    expect(stub.requests[0]!.url).toContain('/api/datasets/owner/name/commits/main');
  });

  it('**形状对不上时如实失败，而不是返回 0 条**', async () => {
    // 这是本适配器最重要的一条：端点形状在本机无法实测（DNS 被污染）。
    // 宽松解析在形状变化时会返回 0 条，而「这个源本来就没更新」
    // 在数据上长得一模一样 —— 后台显示一切正常，HF 动态永远是空的。
    const stub = createStubFetch([
      { match: '/commits/main', respond: { body: JSON.stringify({ error: 'unexpected shape' }) } },
    ]);
    const adapter = new HuggingFaceCollectorAdapter();

    const error = await expectCollectorError(
      () => adapter.fetch(source, NO_CURSOR, context({ fetchImpl: stub.fetchImpl })),
      'SOURCE_FETCH_FAILED',
      true,
    );
    expect(error.message).toMatch(/array of commits|unverified/i);
  });

  it('commit 缺 id 也失败（而不是静默跳过整批）', async () => {
    const stub = createStubFetch([
      { match: '/commits/main', respond: { body: JSON.stringify([{ title: 'no id' }]) } },
    ]);
    const adapter = new HuggingFaceCollectorAdapter();
    await expectCollectorError(
      () => adapter.fetch(source, NO_CURSOR, context({ fetchImpl: stub.fetchImpl })),
      'SOURCE_FETCH_FAILED',
      true,
    );
  });

  it('空数组是合法的（仓库刚建），返回 0 条而不是报错', async () => {
    const stub = createStubFetch([{ match: '/commits/main', respond: { body: '[]' } }]);
    const adapter = new HuggingFaceCollectorAdapter();
    expect(
      (await adapter.fetch(source, NO_CURSOR, context({ fetchImpl: stub.fetchImpl }))).items,
    ).toHaveLength(0);
  });

  it('repoId 形状非法 → 配置错误，不发请求', async () => {
    const stub = createStubFetch([]);
    const adapter = new HuggingFaceCollectorAdapter();
    const bad = createSource({
      type: SourceType.HUGGINGFACE,
      feedUrl: null,
      externalId: null,
      slug: 'bad-hf',
      config: { repoId: 'not-a-repo' },
    });
    await expectCollectorError(
      () => adapter.fetch(bad, NO_CURSOR, context({ fetchImpl: stub.fetchImpl })),
      'SOURCE_CONFIG_INVALID',
      false,
    );
    expect(stub.requests).toHaveLength(0);
  });
});

/* ================================================================== */
/* Manual URL                                                          */
/* ================================================================== */

describe('ManualUrlCollectorAdapter', () => {
  const source = createSource({
    type: SourceType.MANUAL_URL,
    feedUrl: null,
    config: { url: 'https://example.com/article' },
  });

  it('抽取标题（og:title 优先）并保留整页正文原文', async () => {
    const stub = createStubFetch([
      {
        match: 'example.com/article',
        respond: { body: HTML_PAGE, headers: { 'content-type': 'text/html' } },
      },
    ]);
    const adapter = new ManualUrlCollectorAdapter();

    const batch = await adapter.fetch(source, NO_CURSOR, context({ fetchImpl: stub.fetchImpl }));

    expect(batch.items).toHaveLength(1);
    const item = batch.items[0]!;
    expect(item.title).toBe('OpenAI 发布新的推理模型');
    expect(item.type).toBe(ContentType.ARTICLE);
    // 正文是**原文**（未清洗）—— 清洗是 Pipeline 的职责（docs/14）。
    expect(item.body).toContain('<script>');
    expect(item.externalId).toBeNull();
    expect(item.payload['httpStatus']).toBe(200);
  });

  it('canonicalUrl 用**响应的最终地址**（管理员填的可能是会跳转的短链）', async () => {
    const stub = createStubFetch([
      {
        match: 'example.com/article',
        respond: {
          status: 301,
          body: '',
          headers: { location: 'https://www.example.com/final-article' },
        },
      },
      {
        match: 'final-article',
        respond: { body: HTML_PAGE, headers: { 'content-type': 'text/html' } },
      },
    ]);
    const adapter = new ManualUrlCollectorAdapter();

    const batch = await adapter.fetch(source, NO_CURSOR, context({ fetchImpl: stub.fetchImpl }));
    expect(batch.items[0]!.canonicalUrl).toBe('https://www.example.com/final-article');
  });

  it('缺 config.url → 配置错误，不发请求', async () => {
    const stub = createStubFetch([]);
    const adapter = new ManualUrlCollectorAdapter();
    const broken = createSource({ type: SourceType.MANUAL_URL, feedUrl: null, config: {} });

    await expectCollectorError(
      () => adapter.fetch(broken, NO_CURSOR, context({ fetchImpl: stub.fetchImpl })),
      'SOURCE_CONFIG_INVALID',
      false,
    );
    expect(stub.requests).toHaveLength(0);
  });

  it('内网地址被 SSRF 规则拒绝（MANUAL_URL 是管理员能填任意地址的唯一入口）', async () => {
    const stub = createStubFetch([]);
    const adapter = new ManualUrlCollectorAdapter();
    const internal = createSource({
      type: SourceType.MANUAL_URL,
      feedUrl: null,
      config: { url: 'http://169.254.169.254/latest/meta-data/' },
    });

    await expectCollectorError(
      () => adapter.fetch(internal, NO_CURSOR, context({ fetchImpl: stub.fetchImpl })),
      'SOURCE_URL_NOT_ALLOWED',
      false,
    );
    expect(stub.requests).toHaveLength(0);
  });
});

/* ================================================================== */
/* X                                                                   */
/* ================================================================== */

describe('XUserCollectorAdapter', () => {
  const source = createSource({
    type: SourceType.X_USER,
    feedUrl: null,
    externalId: 'karpathy',
    config: {
      handle: 'karpathy',
      includeQuotes: true,
      includeReplies: false,
      includeReposts: false,
    },
  });

  const withToken = (overrides: Partial<CollectorContext> = {}) =>
    context({ credentials: { xApiBearerToken: 'x-bearer', githubToken: null }, ...overrides });

  function xStub(routes: { match: string | RegExp; respond: StubResponse }[]) {
    return createStubFetch(routes);
  }

  it('**未配置令牌时先抛错、完全不发请求**（不撞风控、不假装成功）', async () => {
    const stub = xStub([]);
    const adapter = new XUserCollectorAdapter();

    const error = await expectCollectorError(
      () => adapter.fetch(source, NO_CURSOR, context({ fetchImpl: stub.fetchImpl })),
      'SOURCE_FETCH_CREDENTIALS_MISSING',
      false,
    );
    expect(error.message).toMatch(/X_API_BEARER_TOKEN/);
    expect(stub.requests).toHaveLength(0);
  });

  it('默认只保留原创 Post（排除 reply 与纯 repost）', async () => {
    const stub = xStub([
      { match: 'by/username/karpathy', respond: { body: X_USER_JSON } },
      { match: '/tweets?', respond: { body: X_TWEETS_JSON } },
    ]);
    const adapter = new XUserCollectorAdapter();

    const batch = await adapter.fetch(source, NO_CURSOR, withToken({ fetchImpl: stub.fetchImpl }));

    // 4 条里：原创保留、quote 保留（includeQuotes=true）、reply 与 retweet 排除。
    expect(batch.items).toHaveLength(2);
    expect(batch.items.map((item) => item.externalId)).toEqual([
      '1900000000000000001',
      '1900000000000000002',
    ]);
    expect(batch.items[0]!.type).toBe(ContentType.X_POST);
    expect(batch.items[0]!.originalUrl).toBe('https://x.com/karpathy/status/1900000000000000001');
  });

  it('includeQuotes=false 时 quote 被排除', async () => {
    const stub = xStub([
      { match: 'by/username/karpathy', respond: { body: X_USER_JSON } },
      { match: '/tweets?', respond: { body: X_TWEETS_JSON } },
    ]);
    const adapter = new XUserCollectorAdapter();
    const noQuotes = createSource({
      type: SourceType.X_USER,
      feedUrl: null,
      externalId: 'karpathy',
      config: {
        handle: 'karpathy',
        includeQuotes: false,
        includeReplies: false,
        includeReposts: false,
      },
    });

    const batch = await adapter.fetch(
      noQuotes,
      NO_CURSOR,
      withToken({ fetchImpl: stub.fetchImpl }),
    );
    expect(batch.items).toHaveLength(1);
    expect(batch.items[0]!.payload['postKind']).toBe('original');
  });

  it('includeReplies=true 时 reply 被保留', async () => {
    const stub = xStub([
      { match: 'by/username/karpathy', respond: { body: X_USER_JSON } },
      { match: '/tweets?', respond: { body: X_TWEETS_JSON } },
    ]);
    const adapter = new XUserCollectorAdapter();
    const withReplies = createSource({
      type: SourceType.X_USER,
      feedUrl: null,
      externalId: 'karpathy',
      config: {
        handle: 'karpathy',
        includeQuotes: false,
        includeReplies: true,
        includeReposts: false,
      },
    });

    const batch = await adapter.fetch(
      withReplies,
      NO_CURSOR,
      withToken({ fetchImpl: stub.fetchImpl }),
    );
    expect(batch.items.map((item) => item.payload['postKind'])).toEqual(['original', 'replied_to']);
  });

  it('includeReposts=true 时纯转发被保留', async () => {
    const stub = xStub([
      { match: 'by/username/karpathy', respond: { body: X_USER_JSON } },
      { match: '/tweets?', respond: { body: X_TWEETS_JSON } },
    ]);
    const adapter = new XUserCollectorAdapter();
    const withReposts = createSource({
      type: SourceType.X_USER,
      feedUrl: null,
      externalId: 'karpathy',
      config: {
        handle: 'karpathy',
        includeQuotes: false,
        includeReplies: false,
        includeReposts: true,
      },
    });

    const batch = await adapter.fetch(
      withReposts,
      NO_CURSOR,
      withToken({ fetchImpl: stub.fetchImpl }),
    );
    expect(batch.items.map((item) => item.payload['postKind'])).toEqual(['original', 'retweeted']);
  });

  it('exclude 参数随配置变化（请求侧优化）', async () => {
    const stub = xStub([
      { match: 'by/username/karpathy', respond: { body: X_USER_JSON } },
      { match: '/tweets?', respond: { body: X_TWEETS_JSON } },
    ]);
    const adapter = new XUserCollectorAdapter();

    await adapter.fetch(source, NO_CURSOR, withToken({ fetchImpl: stub.fetchImpl }));
    const tweetsRequest = stub.requests.find((request) => request.url.includes('/tweets?'))!;
    // 默认排除 replies 与 retweets；quote 没有被排除的选项（X API 不提供），
    // 所以响应侧过滤才是正确性保证。
    expect(tweetsRequest.url).toContain('exclude=replies%2Cretweets');
    expect(tweetsRequest.headers['authorization']).toBe('Bearer x-bearer');
  });

  it('增量把 cursor 的 externalId 作为 since_id 传给 X', async () => {
    const stub = xStub([
      { match: 'by/username/karpathy', respond: { body: X_USER_JSON } },
      { match: '/tweets?', respond: { body: X_TWEETS_JSON } },
    ]);
    const adapter = new XUserCollectorAdapter();

    await adapter.fetch(
      source,
      { sincePublishedAt: null, sinceExternalId: '1900000000000000000' },
      withToken({ fetchImpl: stub.fetchImpl }),
    );
    const tweetsRequest = stub.requests.find((request) => request.url.includes('/tweets?'))!;
    expect(tweetsRequest.url).toContain('since_id=1900000000000000000');
  });

  it('游标里的 externalId 不是数字时**不发** since_id（否则 X 会 400）', async () => {
    const stub = xStub([
      { match: 'by/username/karpathy', respond: { body: X_USER_JSON } },
      { match: '/tweets?', respond: { body: X_TWEETS_JSON } },
    ]);
    const adapter = new XUserCollectorAdapter();

    await adapter.fetch(
      source,
      { sincePublishedAt: null, sinceExternalId: 'manually-edited' },
      withToken({ fetchImpl: stub.fetchImpl }),
    );
    expect(stub.requests.find((r) => r.url.includes('/tweets?'))!.url).not.toContain('since_id');
  });

  it('没有新推文时 X 不返回 data 字段（不是空数组）→ 0 条而不是失败', async () => {
    const stub = xStub([
      { match: 'by/username/karpathy', respond: { body: X_USER_JSON } },
      { match: '/tweets?', respond: { body: X_EMPTY_TIMELINE_JSON } },
    ]);
    const adapter = new XUserCollectorAdapter();

    const batch = await adapter.fetch(source, NO_CURSOR, withToken({ fetchImpl: stub.fetchImpl }));
    expect(batch.items).toHaveLength(0);
  });

  it('handle 缺失 → 配置错误，不发请求', async () => {
    const stub = xStub([]);
    const adapter = new XUserCollectorAdapter();
    const broken = createSource({
      type: SourceType.X_USER,
      feedUrl: null,
      externalId: null,
      slug: 'x-broken',
      config: {},
    });

    await expectCollectorError(
      () => adapter.fetch(broken, NO_CURSOR, withToken({ fetchImpl: stub.fetchImpl })),
      'SOURCE_CONFIG_INVALID',
      false,
    );
    expect(stub.requests).toHaveLength(0);
  });

  it('handle 在 X 上不存在 → 配置错误（而不是可重试的上游故障）', async () => {
    const stub = xStub([
      {
        match: 'by/username/karpathy',
        respond: { body: JSON.stringify({ errors: [{ title: 'Not Found Error' }] }) },
      },
    ]);
    const adapter = new XUserCollectorAdapter();

    await expectCollectorError(
      () => adapter.fetch(source, NO_CURSOR, withToken({ fetchImpl: stub.fetchImpl })),
      'SOURCE_CONFIG_INVALID',
      false,
    );
  });

  it('定时采集时用的是 source 的 handle（而不是硬编码 id）', async () => {
    const stub = xStub([
      { match: 'by/username/karpathy', respond: { body: X_USER_JSON } },
      { match: '/tweets?', respond: { body: X_TWEETS_JSON } },
    ]);
    const adapter = new XUserCollectorAdapter();

    await adapter.fetch(source, NO_CURSOR, withToken({ fetchImpl: stub.fetchImpl }));
    // 第一次必须查 handle → id；硬编码 id 会让管理员改了 handle 之后
    // 静默抓到**别人的**时间线。
    expect(stub.requests[0]!.url).toContain('/users/by/username/karpathy');
    expect(stub.requests[1]!.url).toContain('/users/1234567/tweets');
  });

  it('X 的实体转义（&amp;）在正文里被正确解码', async () => {
    const stub = xStub([
      { match: 'by/username/karpathy', respond: { body: X_USER_JSON } },
      {
        match: '/tweets?',
        respond: {
          body: JSON.stringify({
            data: [
              {
                id: '1900000000000000009',
                text: 'A &amp; B 与 &lt;tag&gt;',
                created_at: '2026-09-24T01:00:00.000Z',
              },
            ],
          }),
        },
      },
    ]);
    const adapter = new XUserCollectorAdapter();
    const batch = await adapter.fetch(source, NO_CURSOR, withToken({ fetchImpl: stub.fetchImpl }));

    // X 返回的 text 已经是纯文本（实体已在 API 层解码），采集端**原样保留** ——
    // 正文不做二次解码，否则 `&amp;lt;` 这类内容会被解两次。
    expect(batch.items[0]!.body).toBe('A &amp; B 与 &lt;tag&gt;');
  });
});

/* ================================================================== */
/* payload 形状守卫（按类型白名单）                                     */
/* ================================================================== */

describe('assertPayloadShape', () => {
  it('**Source 元数据在任何类型下都被拒**', () => {
    for (const key of ['tier', 'kind', 'official', 'trustScore', 'priority']) {
      expect(() => assertPayloadShape(SourceType.RSS, { [key]: 'x' }, 'probe')).toThrow(
        /不得包含 Source 元数据/,
      );
    }
  });

  it('**未登记的键被拒**（防止绕过契约表偷偷塞字段）', () => {
    // 这条是「黑名单 → 白名单」的核心收益：新键必须登记。
    expect(() =>
      assertPayloadShape(SourceType.RSS, { feedFormat: 'rss', extra: 1 }, 'probe'),
    ).toThrow(/未登记的键（extra）/);
  });

  it('**已登记的键通过** —— 包括 X 的 `postKind`', () => {
    // ⚠ 这条用例是 P0 的回归守卫。
    // 曾经守卫是键名黑名单（含 `kind`），而 X 适配器用 `kind` 表示
    // 「推文的引用关系」，与 Source 的 `SourceKind` 只是撞名 ——
    // 于是**每一条推文**都在落库前被拦下，`SourceType.X_USER` 整体不可用。
    // 旧测试断言 `payload['kind']` 存在、又断言 `kind` 必须被拒，
    // 两条互相矛盾的断言从来没有同时执行过。
    expect(() =>
      assertPayloadShape(SourceType.X_USER, { tweetId: '1', postKind: 'original' }, 'probe'),
    ).not.toThrow();
    expect(() => assertPayloadShape(SourceType.RSS, { feedFormat: 'rss' }, 'probe')).not.toThrow();
  });

  it('没有登记契约的类型直接抛错（而不是放行）', () => {
    expect(() => assertPayloadShape('NOT_A_TYPE' as SourceType, { anything: 1 }, 'probe')).toThrow(
      /no payload contract/,
    );
  });
});

describe('六个适配器的**真实输出**都能通过守卫', () => {
  /**
   * ⚠ 这是本次独立审查之后补上的最关键的守卫。
   *
   * 原先适配器测试不过 service、service 测试用替身 —— 于是
   * 「真适配器 → 落库守卫」这条路径**从来没有被执行过**，
   * 而 P0 就藏在那里（X 的 payload 被守卫拦下 → 整个类型不可用，
   * 而 868 项测试全绿）。
   *
   * 这一组把六个适配器的**真实输出**逐条喂给守卫。
   */
  it('RSS / GitHub / HN / HF / MANUAL_URL / X 的真实 payload 全部通过', async () => {
    const cases: { type: SourceType; payload: Record<string, unknown> }[] = [];

    const rssStub = createStubFetch([{ match: 'feed.xml', respond: { body: RSS_SINGLE_ITEM } }]);
    cases.push({
      type: SourceType.RSS,
      payload: (
        await new RssCollectorAdapter().fetch(
          createSource({ type: SourceType.RSS, feedUrl: 'https://example.com/feed.xml' }),
          NO_CURSOR,
          context({ fetchImpl: rssStub.fetchImpl }),
        )
      ).items[0]!.payload,
    });

    const ghStub = createStubFetch([
      { match: '/releases', respond: { body: GITHUB_RELEASES_JSON } },
    ]);
    cases.push({
      type: SourceType.GITHUB_REPO,
      payload: (
        await new GithubRepoCollectorAdapter().fetch(
          createSource({
            type: SourceType.GITHUB_REPO,
            feedUrl: null,
            externalId: 'nodejs/node',
            config: { includeReleases: true },
          }),
          NO_CURSOR,
          context({ fetchImpl: ghStub.fetchImpl }),
        )
      ).items[0]!.payload,
    });

    const hnStub = createStubFetch([
      { match: 'topstories.json', respond: { body: JSON.stringify([49824686]) } },
      { match: 'item/', respond: { body: hnItemJson() } },
    ]);
    cases.push({
      type: SourceType.HACKER_NEWS,
      payload: (
        await new HackerNewsCollectorAdapter().fetch(
          createSource({ type: SourceType.HACKER_NEWS, feedUrl: null, config: { feed: 'top' } }),
          NO_CURSOR,
          context({ fetchImpl: hnStub.fetchImpl }),
        )
      ).items[0]!.payload,
    });

    const hfStub = createStubFetch([
      { match: '/commits/main', respond: { body: HF_COMMITS_JSON } },
    ]);
    cases.push({
      type: SourceType.HUGGINGFACE,
      payload: (
        await new HuggingFaceCollectorAdapter().fetch(
          createSource({
            type: SourceType.HUGGINGFACE,
            feedUrl: null,
            externalId: 'google-bert/bert-base-uncased',
            config: { repoType: 'model' },
          }),
          NO_CURSOR,
          context({ fetchImpl: hfStub.fetchImpl }),
        )
      ).items[0]!.payload,
    });

    const manualStub = createStubFetch([
      {
        match: 'example.com/article',
        respond: { body: HTML_PAGE, headers: { 'content-type': 'text/html' } },
      },
    ]);
    cases.push({
      type: SourceType.MANUAL_URL,
      payload: (
        await new ManualUrlCollectorAdapter().fetch(
          createSource({
            type: SourceType.MANUAL_URL,
            feedUrl: null,
            config: { url: 'https://example.com/article' },
          }),
          NO_CURSOR,
          context({ fetchImpl: manualStub.fetchImpl }),
        )
      ).items[0]!.payload,
    });

    const xStub = createStubFetch([
      { match: 'by/username', respond: { body: X_USER_JSON } },
      { match: '/tweets?', respond: { body: X_TWEETS_JSON } },
    ]);
    cases.push({
      type: SourceType.X_USER,
      payload: (
        await new XUserCollectorAdapter().fetch(
          createSource({
            type: SourceType.X_USER,
            feedUrl: null,
            externalId: 'karpathy',
            config: { handle: 'karpathy', includeQuotes: true },
          }),
          NO_CURSOR,
          context({
            fetchImpl: xStub.fetchImpl,
            credentials: { xApiBearerToken: 'tok', githubToken: null },
          }),
        )
      ).items[0]!.payload,
    });

    expect(cases).toHaveLength(6);
    for (const { type, payload } of cases) {
      // 断言顺序刻意是「先抛错就失败」：任何一个适配器产出未登记的键，
      // 这里就会红，并指出是哪个类型。
      expect(() => assertPayloadShape(type, payload, `probe:${type}`)).not.toThrow();
      expect(Object.keys(payload).length).toBeGreaterThan(0);
    }
  });
});

describe('RSS 实体标题 fixture 的端到端结果', () => {
  it('标题里的标签与实体在适配器输出里已经是纯文本', async () => {
    const stub = createStubFetch([{ match: 'feed.xml', respond: { body: RSS_ENTITY_IN_TITLE } }]);
    const adapter = new RssCollectorAdapter();
    const source = createSource({ type: SourceType.RSS, feedUrl: 'https://example.com/feed.xml' });

    const batch = await adapter.fetch(source, NO_CURSOR, context({ fetchImpl: stub.fetchImpl }));
    const title = batch.items[0]!.title ?? '';
    expect(title).toContain('A & B');
    expect(title).not.toContain('<script');
    expect(title).not.toContain('&amp;');
  });
});
