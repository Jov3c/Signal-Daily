/**
 * `HttpSourceTester` 的测试。
 *
 * ★ 关键点：这里跑的是**真实的探测实现**，只有网络那一层被换掉。
 * 为什么强调这个 —— Agent 01 的教训是「测试全绿但真代码从没跑过」：
 * 如果整个 tester 都被替身换掉，那么 URL 拼法、状态码判定、
 * 「响应到底像不像 feed」这些真正的逻辑就一次都没被执行过，
 * 而测试会一直显示绿色。
 *
 * 所以这里注入的是 `fetchImpl` / `lookup`（桩），保留 `HttpSourceTester`
 * 本身的全部逻辑。
 */

import { describe, expect, it } from 'vitest';
import { SourceKind, SourceTier, SourceType } from '@signal/contracts';
import { createLogger } from '@signal/logger';
import { HttpSourceTester, TEST_MAX_BYTES, looksLikeFeed } from '../src/modules/sources/source-tester';
import type { SourceRecord } from '../src/modules/sources/repository';
import { createTestSourceConfig } from './support/sources-test-app';
import type { DnsAddress } from '../src/modules/sources/url-safety';

const LOGGER = createLogger({ service: 'test', level: 'silent' });
const PUBLIC_DNS = async (): Promise<DnsAddress[]> => [{ address: '93.184.216.34', family: 4 }];

function source(overrides: Partial<SourceRecord> = {}): SourceRecord {
  return {
    id: '1',
    name: 'Test',
    slug: 'test',
    type: SourceType.RSS,
    kind: SourceKind.OFFICIAL,
    tier: SourceTier.S,
    official: true,
    baseUrl: null,
    feedUrl: 'https://example.com/feed.xml',
    externalId: null,
    language: null,
    priority: 50,
    trustScore: 7,
    fetchIntervalSeconds: 1_800,
    enabled: true,
    config: null,
    lastFetchedAt: null,
    nextFetchAt: null,
    lastSuccessAt: null,
    lastErrorAt: null,
    lastErrorCode: null,
    createdAt: new Date('2026-09-24T00:00:00.000Z'),
    updatedAt: new Date('2026-09-24T00:00:00.000Z'),
    ...overrides,
  };
}

/** 构造一个 tester，网络层由调用方提供。 */
function tester(
  fetchImpl: typeof fetch,
  options: { xApiBearerToken?: string | null; githubToken?: string | null; lookup?: typeof PUBLIC_DNS } = {},
) {
  return new HttpSourceTester(
    createTestSourceConfig({
      xApiBearerToken: options.xApiBearerToken ?? null,
      githubToken: options.githubToken ?? null,
      fetchTimeoutMs: 1_000,
      fetchMaxBytes: 65_536,
    }),
    LOGGER,
    { fetchImpl, lookup: options.lookup ?? PUBLIC_DNS, now: () => 0 },
  );
}

/** 记录请求并返回固定响应。 */
function stubFetch(response: Response | (() => Response)) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return typeof response === 'function' ? response() : response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const FEED_XML = '<?xml version="1.0"?><rss version="2.0"><channel><title>t</title></channel></rss>';

/* ------------------------------------------------------------------ */
/* RSS                                                                 */
/* ------------------------------------------------------------------ */

describe('RSS 探测', () => {
  it('200 + 真 feed → ok', async () => {
    const { impl } = stubFetch(
      new Response(FEED_XML, { status: 200, headers: { 'content-type': 'application/rss+xml' } }),
    );
    const result = await tester(impl).test(source());

    expect(result.ok).toBe(true);
    expect(result.type).toBe(SourceType.RSS);
    expect(result.target).toBe('https://example.com/feed.xml');
  });

  it('200 但其实是 HTML 页面 → ok:false（不能因为「能连上」就说源可用）', async () => {
    const { impl } = stubFetch(
      new Response('<!doctype html><html><body>404 page</body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
    );
    const result = await tester(impl).test(source());

    expect(result.ok).toBe(false);
    expect(result.message).toContain('does not look like an RSS/Atom feed');
  });

  it('header 说是 rss 但正文是空的 → 放行（很多站点 content-type 是对的但正文很短）', async () => {
    const { impl } = stubFetch(
      new Response('', { status: 200, headers: { 'content-type': 'application/rss+xml' } }),
    );
    expect((await tester(impl).test(source())).ok).toBe(true);
  });

  it('content-type 是错的 text/html，但正文是 feed → 仍需放行', async () => {
    const { impl } = stubFetch(
      new Response(FEED_XML, { status: 200, headers: { 'content-type': 'text/html' } }),
    );
    expect((await tester(impl).test(source())).ok).toBe(true);
  });

  it.each([404, 500, 403])('HTTP %i → ok:false 并如实报告状态码', async (status) => {
    const { impl } = stubFetch(new Response('nope', { status }));
    const result = await tester(impl).test(source());

    expect(result.ok).toBe(false);
    expect(result.message).toContain(String(status));
  });

  it('GBK 编码的中文 feed（中文源常见）能正确解码并识别', async () => {
    // <rss> 用 GBK 编码的“中文”两个字
    const gbk = new Uint8Array([
      0x3c, 0x72, 0x73, 0x73, 0x3e, 0xd6, 0xd0, 0xce, 0xc4, 0x3c, 0x2f, 0x72, 0x73, 0x73, 0x3e,
    ]);
    const { impl } = stubFetch(
      new Response(gbk, { status: 200, headers: { 'content-type': 'text/xml; charset=gbk' } }),
    );
    const result = await tester(impl).test(source());

    expect(result.ok).toBe(true);
  });

  it('feedUrl 缺失时退到 baseUrl', async () => {
    const { impl, calls } = stubFetch(new Response(FEED_XML, { status: 200 }));
    await tester(impl).test(source({ feedUrl: null, baseUrl: 'https://example.com/' }));
    expect(calls[0]?.url).toBe('https://example.com/');
  });
});

/* ------------------------------------------------------------------ */
/* 各类来源的 URL 拼法（真实逻辑，不是替身）                            */
/* ------------------------------------------------------------------ */

describe('各类型探测目标', () => {
  it('X_USER 未配置令牌 → ok:false 且**完全不发请求**', async () => {
    const { impl, calls } = stubFetch(new Response('{}', { status: 200 }));
    const result = await tester(impl).test(
      source({ type: SourceType.X_USER, config: { handle: 'karpathy' } }),
    );

    expect(result.ok).toBe(false);
    expect(result.message).toContain('X_API_BEARER_TOKEN');
    expect(calls).toHaveLength(0);
  });

  it('X_USER 配了令牌 → 带上 Bearer 打官方端点', async () => {
    const { impl, calls } = stubFetch(new Response('{"data":{}}', { status: 200 }));
    const result = await tester(impl, { xApiBearerToken: 'secret-token' }).test(
      source({ type: SourceType.X_USER, config: { handle: 'karpathy' } }),
    );

    expect(result.ok).toBe(true);
    expect(calls[0]?.url).toBe('https://api.x.com/2/users/by/username/karpathy');
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer secret-token');
  });

  it('X_USER 的 handle 会被 URL 编码（防止路径注入）', async () => {
    const { impl, calls } = stubFetch(new Response('{}', { status: 200 }));
    await tester(impl, { xApiBearerToken: 't' }).test(
      source({ type: SourceType.X_USER, config: { handle: 'a/b' } }),
    );
    expect(calls[0]?.url).toBe('https://api.x.com/2/users/by/username/a%2Fb');
  });

  it('GITHUB_REPO 用 externalId 拼官方 API，未配 token 时不带 Authorization', async () => {
    const { impl, calls } = stubFetch(new Response('{}', { status: 200 }));
    await tester(impl).test(
      source({ type: SourceType.GITHUB_REPO, externalId: 'vllm-project/vllm' }),
    );

    expect(calls[0]?.url).toBe('https://api.github.com/repos/vllm-project/vllm');
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers.authorization).toBeUndefined();
    expect(headers['user-agent']).toBe('signal-app');
  });

  it('GITHUB_REPO 配了 token 时带上 Authorization', async () => {
    const { impl, calls } = stubFetch(new Response('{}', { status: 200 }));
    await tester(impl, { githubToken: 'gh-token' }).test(
      source({ type: SourceType.GITHUB_REPO, externalId: 'a/b' }),
    );
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer gh-token');
  });

  it.each([
    ['model', 'https://huggingface.co/api/models/a/b'],
    ['dataset', 'https://huggingface.co/api/datasets/a/b'],
    ['space', 'https://huggingface.co/api/spaces/a/b'],
  ])('HUGGINGFACE repoType=%s → %s', async (repoType, expected) => {
    const { impl, calls } = stubFetch(new Response('{}', { status: 200 }));
    await tester(impl).test(
      source({
        type: SourceType.HUGGINGFACE,
        externalId: 'a/b',
        config: { repoType, repoId: 'a/b' },
      }),
    );
    expect(calls[0]?.url).toBe(expected);
  });

  it('HACKER_NEWS 探测官方 API（榜单值不影响端点）', async () => {
    const { impl, calls } = stubFetch(new Response('12345', { status: 200 }));
    const result = await tester(impl).test(
      source({ type: SourceType.HACKER_NEWS, config: { feed: 'best', minScore: 50 } }),
    );

    expect(result.ok).toBe(true);
    expect(calls[0]?.url).toBe('https://hacker-news.firebaseio.com/v0/maxitem.json');
  });

  it('MANUAL_URL 用 config.url，并用 GET（HEAD 会被很多站点拒绝）', async () => {
    const { impl, calls } = stubFetch(new Response('<html></html>', { status: 200 }));
    const result = await tester(impl).test(
      source({ type: SourceType.MANUAL_URL, config: { url: 'https://example.com/post' } }),
    );

    expect(result.ok).toBe(true);
    expect(calls[0]?.url).toBe('https://example.com/post');
    expect(calls[0]?.init?.method).toBe('GET');
  });
});

/* ------------------------------------------------------------------ */
/* 安全与错误处理                                                       */
/* ------------------------------------------------------------------ */

describe('安全', () => {
  it('库里存了私网地址 → ok:false（不抛 500，因为这是探测结论）', async () => {
    const { impl, calls } = stubFetch(new Response('x', { status: 200 }));
    const result = await tester(impl).test(
      source({ type: SourceType.MANUAL_URL, config: { url: 'http://169.254.169.254/' } }),
    );

    expect(result.ok).toBe(false);
    expect(result.target).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('域名解析到内网 → ok:false，且请求没发出去', async () => {
    const { impl, calls } = stubFetch(new Response('x', { status: 200 }));
    const result = await tester(impl, {
      lookup: async () => [{ address: '10.0.0.5', family: 4 }],
    }).test(source());

    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('重定向到内网 → ok:false（docs/06：redirect 必须重新校验）', async () => {
    let hop = 0;
    const impl = (async () => {
      hop += 1;
      return hop === 1
        ? new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/' } })
        : new Response('leaked', { status: 200 });
    }) as unknown as typeof fetch;

    const result = await tester(impl).test(source());
    expect(result.ok).toBe(false);
    expect(hop).toBe(1);
  });

  it('探测目标回显时**必须去掉查询串**（URL 里可能有 token）', async () => {
    const { impl } = stubFetch(
      new Response(FEED_XML, { status: 200, headers: { 'content-type': 'application/rss+xml' } }),
    );
    const result = await tester(impl).test(
      source({ feedUrl: 'https://example.com/feed.xml?api_key=SUPERSECRET' }),
    );

    expect(result.ok).toBe(true);
    expect(result.target).toBe('https://example.com/feed.xml');
    expect(JSON.stringify(result)).not.toContain('SUPERSECRET');
  });

  it('DNS 查不到 → ok:false，消息里不含底层异常文本', async () => {
    const { impl } = stubFetch(new Response('x', { status: 200 }));
    const result = await tester(impl, {
      lookup: async () => {
        throw new Error('ENOTFOUND secret-internal-host');
      },
    }).test(source());

    expect(result.ok).toBe(false);
    expect(result.message).toBe('Source host could not be resolved');
    expect(result.message).not.toContain('secret-internal-host');
  });

  it('体积上限被压到 TEST_MAX_BYTES（探测不该下载整篇文章）', async () => {
    const { impl } = stubFetch(
      new Response(FEED_XML, { status: 200, headers: { 'content-type': 'application/rss+xml' } }),
    );
    const big = new HttpSourceTester(
      createTestSourceConfig({ fetchMaxBytes: 10 * 1024 * 1024 }),
      LOGGER,
      { fetchImpl: impl, lookup: PUBLIC_DNS, now: () => 0 },
    );
    // 直接把上限断言在常量上：真正的「边读边停」由 url-safety 的用例覆盖。
    expect(TEST_MAX_BYTES).toBeLessThan(10 * 1024 * 1024);
    expect((await big.test(source())).ok).toBe(true);
  });

  it('未预期异常照常抛出（不伪装成「源不可用」）', async () => {
    const impl = (async () => {
      // 模拟一个编程缺陷：fetch 返回的不是 Response。
      return null as unknown as Response;
    }) as unknown as typeof fetch;

    await expect(tester(impl).test(source())).rejects.toThrow();
  });
});

/* ------------------------------------------------------------------ */
/* looksLikeFeed                                                       */
/* ------------------------------------------------------------------ */

describe('looksLikeFeed', () => {
  it.each([
    ['<rss version="2.0">', null, true],
    ['<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">', null, true],
    ['<rdf:RDF xmlns:rdf="...">', null, true],
    ['<html><body>hi</body></html>', 'text/html', false],
    ['anything at all', 'application/rss+xml', true],
    ['anything at all', 'application/atom+xml; charset=utf-8', true],
  ])('looksLikeFeed(%s, %s) === %s', (body, contentType, expected) => {
    expect(looksLikeFeed(body, contentType)).toBe(expected);
  });
});
