/**
 * 类型化 config 校验的直接单测（`buildSourceConfig`）。
 *
 * 这里跑的是**真实校验代码**，不经过 HTTP、不经过仓储、不联网。
 * 之所以要单独测一层：`sources-api.spec.ts` 里同一批用例走的是完整 HTTP 链路，
 * 一旦 DTO 层先拦下（例如 slug 形状不对），错误码就变成了 `VALIDATION_FAILED`，
 * 看起来「也是 400」，实际上 config 校验根本没被执行到。
 */

import { describe, expect, it } from 'vitest';
import { SourceType } from '@signal/contracts';
import { buildSourceConfig } from '../src/modules/sources/source-config.schema';
import { UrlSafetyError } from '../src/modules/sources/url-safety';

function build(type: SourceType, config: unknown, rest: Partial<{ externalId: string | null; feedUrl: string | null; baseUrl: string | null }> = {}) {
  return buildSourceConfig({
    type,
    config,
    externalId: rest.externalId ?? null,
    feedUrl: rest.feedUrl ?? null,
    baseUrl: rest.baseUrl ?? null,
  });
}

/**
 * 断言被 config 校验拒绝。
 *
 * ⚠ 必须把「没抛错」与「抛了别的错」分开报：
 * 早期写法是在 try 里 `throw new Error('本应拒绝但被放行')`，
 * 结果那个错误被自己的 catch 抓住，断言退化成
 * `expect(undefined).toBe('SOURCE_CONFIG_INVALID')` —— 报错信息完全对不上原因。
 */
function expectConfigInvalid(type: SourceType, config: unknown): void {
  let thrown: unknown;
  try {
    build(type, config);
  } catch (error) {
    thrown = error;
  }
  if (thrown === undefined) {
    throw new Error(`本应拒绝但被放行：${type} ${JSON.stringify(config)}`);
  }
  expect((thrown as { code?: string }).code, `拒绝原因不是 config 错误：${String(thrown)}`).toBe(
    'SOURCE_CONFIG_INVALID',
  );
}

/**
 * 取 config 校验失败时的**字段级原因**。
 *
 * 不能断言 `error.message`：`AppError` 的 message 是给客户端看的
 * `safeMessage`（"Source config is invalid for type X"），
 * 具体哪一项不合法在 `details.fields` 里。断言 message 会永远匹配不上。
 */
function configErrorFields(run: () => unknown): string[] {
  try {
    run();
  } catch (error) {
    const details = (error as { details?: { fields?: unknown } }).details;
    const fields = details?.fields;
    if (Array.isArray(fields)) return fields.map(String);
    return [];
  }
  throw new Error('本应抛出 config 错误，但通过了');
}

describe('RSS', () => {
  it('feedUrl 从顶层提升到列，config 里不留副本（避免两个事实源）', () => {
    const result = build(SourceType.RSS, {}, { feedUrl: 'https://example.com/rss.xml' });
    expect(result.feedUrl).toBe('https://example.com/rss.xml');
    expect(result.config).not.toHaveProperty('feedUrl');
    expect(result.config.maxItems).toBe(50);
  });

  it('config.feedUrl 是等价的别名', () => {
    const result = build(SourceType.RSS, { feedUrl: 'https://example.com/rss.xml' });
    expect(result.feedUrl).toBe('https://example.com/rss.xml');
  });

  it('两处都给了但值不同 → 拒绝（不悄悄挑一个用）', () => {
    const fields = configErrorFields(() =>
      build(
        SourceType.RSS,
        { feedUrl: 'https://a.example/feed' },
        { feedUrl: 'https://b.example/feed' },
      ),
    );
    expect(fields.join(' ')).toContain('given twice with different values');
  });

  it('两处给了同一个值 → 放行', () => {
    const result = build(
      SourceType.RSS,
      { feedUrl: 'https://a.example/feed' },
      { feedUrl: 'https://a.example/feed' },
    );
    expect(result.feedUrl).toBe('https://a.example/feed');
  });

  it('既没有 feedUrl 也没有 baseUrl → 拒绝（否则采集器无从下手）', () => {
    expectConfigInvalid(SourceType.RSS, {});
  });

  it('maxItems 范围是 1–500', () => {
    const feed = { feedUrl: 'https://example.com/feed' };
    expect(build(SourceType.RSS, { ...feed, maxItems: 1 }).config.maxItems).toBe(1);
    expect(build(SourceType.RSS, { ...feed, maxItems: 500 }).config.maxItems).toBe(500);
    expectConfigInvalid(SourceType.RSS, { ...feed, maxItems: 0 });
    expectConfigInvalid(SourceType.RSS, { ...feed, maxItems: 501 });
  });

  it('私网 feedUrl → UrlSafetyError（不是 config 错误）', () => {
    expect(() => build(SourceType.RSS, { feedUrl: 'http://127.0.0.1/feed' })).toThrow(
      UrlSafetyError,
    );
  });
});

describe('X_USER', () => {
  const HANDLE = { handle: 'karpathy' };

  it('docs/06 的默认值：保留原创、收录 Quote、排除 Reply、排除纯 Repost', () => {
    const result = build(SourceType.X_USER, HANDLE);
    expect(result.config).toEqual({
      handle: 'karpathy',
      includeQuotes: true,
      includeReplies: false,
      includeReposts: false,
    });
  });

  it('存在默认值会被显式写下（全量快照，而不是稀疏对象）', () => {
    // 这条是刻意的：Collector 读的就是这份 JSON。
    // 若只写「偏离默认值的键」，采集器就得自己猜默认值 —— 两边假设一旦不同，
    // 采集行为会静默变化且无处报错。
    const result = build(SourceType.X_USER, HANDLE);
    expect(Object.keys(result.config).sort()).toEqual([
      'handle',
      'includeQuotes',
      'includeReplies',
      'includeReposts',
    ]);
  });

  it('externalId 归一化成 handle', () => {
    expect(build(SourceType.X_USER, HANDLE, { externalId: 'KARPATHY' }).externalId).toBe(
      'karpathy',
    );
  });

  it('externalId 与 handle 不一致 → 拒绝', () => {
    const fields = configErrorFields(() =>
      build(SourceType.X_USER, HANDLE, { externalId: 'someoneelse' }),
    );
    expect(fields.join(' ')).toContain('externalId must match config.handle');
  });

  it('缺 handle → 拒绝', () => {
    expectConfigInvalid(SourceType.X_USER, {});
    expectConfigInvalid(SourceType.X_USER, { includeQuotes: true });
  });

  it.each([
    ['含空格', 'kar pathy'],
    ['含连字符（X 不允许）', 'andrej-karpathy'],
    ['超过 15 字符', 'a'.repeat(16)],
    ['空串', ''],
  ])('handle %s → 拒绝', (_label, handle) => {
    expectConfigInvalid(SourceType.X_USER, { handle });
  });

  it('15 字符的 handle 是合法的边界值', () => {
    expect(build(SourceType.X_USER, { handle: 'a'.repeat(15) }).config.handle).toHaveLength(15);
  });

  it('非布尔的开关 → 拒绝', () => {
    expectConfigInvalid(SourceType.X_USER, { handle: 'karpathy', includeQuotes: 'yes' });
    expectConfigInvalid(SourceType.X_USER, { handle: 'karpathy', includeReplies: 1 });
  });

  it('未知键 → 拒绝（拼错的 includQuotes 必须当场报错）', () => {
    expectConfigInvalid(SourceType.X_USER, { handle: 'karpathy', includQuotes: true });
  });

  it('seed 标记被接受并保留', () => {
    const result = build(SourceType.X_USER, {
      handle: 'karpathy',
      seed: true,
      seedNote: '演示数据',
    });
    expect(result.config.seed).toBe(true);
    expect(result.config.seedNote).toBe('演示数据');
  });

  it('X 来源没有任何订阅语义的键 —— 出现即被拒', () => {
    expectConfigInvalid(SourceType.X_USER, { handle: 'karpathy', subscribe: true });
    expectConfigInvalid(SourceType.X_USER, { handle: 'karpathy', following: ['a'] });
  });
});

describe('GITHUB_REPO / HUGGINGFACE', () => {
  it('GITHUB_REPO 接受 config.repo 并提升到 externalId', () => {
    const result = build(SourceType.GITHUB_REPO, { repo: 'vllm-project/vllm' });
    expect(result.externalId).toBe('vllm-project/vllm');
    expect(result.config).not.toHaveProperty('repo');
    expect(result.config.includeReleases).toBe(true);
  });

  it('GITHUB_REPO 也接受 externalId', () => {
    expect(build(SourceType.GITHUB_REPO, {}, { externalId: 'a/b' }).externalId).toBe('a/b');
  });

  it('GITHUB_REPO 既没有 repo 也没有 externalId → 拒绝', () => {
    expectConfigInvalid(SourceType.GITHUB_REPO, {});
  });

  it.each([['没有斜杠', 'vllm'], ['三段', 'a/b/c'], ['尾部斜杠', 'a/']])(
    'GITHUB_REPO 形状 %s → 拒绝',
    (_label, repo) => {
      expectConfigInvalid(SourceType.GITHUB_REPO, { repo });
    },
  );

  it('HUGGINGFACE 的 repoType 决定 API 段，且默认 model', () => {
    expect(build(SourceType.HUGGINGFACE, { repoId: 'meta-llama/Llama-3' }).config.repoType).toBe(
      'model',
    );
    expect(
      build(SourceType.HUGGINGFACE, { repoId: 'a/b', repoType: 'dataset' }).config.repoType,
    ).toBe('dataset');
    expectConfigInvalid(SourceType.HUGGINGFACE, { repoId: 'a/b', repoType: 'weights' });
  });
});

describe('HACKER_NEWS', () => {
  it('默认 top + minScore 0', () => {
    expect(build(SourceType.HACKER_NEWS, {}).config).toEqual({ feed: 'top', minScore: 0 });
  });

  it.each([['top'], ['new'], ['best'], ['ask'], ['show'], ['job']])(
    '内置榜单 %s 合法',
    (feed) => {
      expect(build(SourceType.HACKER_NEWS, { feed }).config.feed).toBe(feed);
    },
  );

  it('非内置榜单 → 拒绝', () => {
    expectConfigInvalid(SourceType.HACKER_NEWS, { feed: 'trending' });
  });

  it('minScore 超范围 → 拒绝', () => {
    expectConfigInvalid(SourceType.HACKER_NEWS, { minScore: -1 });
    expectConfigInvalid(SourceType.HACKER_NEWS, { minScore: 10_001 });
  });
});

describe('MANUAL_URL', () => {
  it('url 必填，且会做 SSRF 校验', () => {
    expect(build(SourceType.MANUAL_URL, { url: 'https://example.com/post' }).config.url).toBe(
      'https://example.com/post',
    );
    expectConfigInvalid(SourceType.MANUAL_URL, { note: '只有备注' });
    expect(() => build(SourceType.MANUAL_URL, { url: 'http://169.254.169.254/' })).toThrow(
      UrlSafetyError,
    );
  });

  it('note 可选且限长 500', () => {
    expect(build(SourceType.MANUAL_URL, { url: 'https://example.com', note: 'hi' }).config.note).toBe(
      'hi',
    );
    expectConfigInvalid(SourceType.MANUAL_URL, {
      url: 'https://example.com',
      note: 'x'.repeat(501),
    });
  });

  it('缺 url 是 config 错误，私网 url 是安全错误 —— 两者必须可区分', () => {
    // 前者说明「忘了填」，后者说明「填了一个不许抓的地址」，
    // 管理员要做的事完全不同。
    let missing: unknown;
    try {
      build(SourceType.MANUAL_URL, {});
    } catch (error) {
      missing = error;
    }
    expect((missing as { code?: string }).code).toBe('SOURCE_CONFIG_INVALID');

    let blocked: unknown;
    try {
      build(SourceType.MANUAL_URL, { url: 'http://10.0.0.1/' });
    } catch (error) {
      blocked = error;
    }
    expect((blocked as { code?: string }).code).toBe('SOURCE_URL_NOT_ALLOWED');
  });
});

describe('通用规则', () => {
  it('config 不是对象 → 拒绝', () => {
    expectConfigInvalid(SourceType.RSS, 'a string');
    expectConfigInvalid(SourceType.RSS, [1, 2, 3]);
  });

  it('config 省略 = 空对象（全部走默认值）', () => {
    expect(build(SourceType.HACKER_NEWS, undefined).config.feed).toBe('top');
  });

  it('baseUrl 会被 SSRF 校验（所有类型，纵深防御）', () => {
    expect(() =>
      build(SourceType.HACKER_NEWS, {}, { baseUrl: 'http://192.168.0.1/' }),
    ).toThrow(UrlSafetyError);
  });

  it('每种 SourceType 都有对应分支，且都能被正常校验通过', () => {
    // 用 `Record<SourceType, …>` 而不是数组：将来新增枚举值却忘了在这里补，
    // TypeScript 会直接编译失败 —— 比运行期才发现更早。
    const valid: Record<SourceType, { config: unknown; feedUrl?: string }> = {
      [SourceType.RSS]: { config: {}, feedUrl: 'https://example.com/feed' },
      [SourceType.X_USER]: { config: { handle: 'karpathy' } },
      [SourceType.GITHUB_REPO]: { config: { repo: 'a/b' } },
      [SourceType.HACKER_NEWS]: { config: {} },
      [SourceType.HUGGINGFACE]: { config: { repoId: 'a/b' } },
      [SourceType.MANUAL_URL]: { config: { url: 'https://example.com/post' } },
    };

    for (const type of Object.values(SourceType)) {
      const entry = valid[type];
      const result = build(type, entry.config, { feedUrl: entry.feedUrl ?? null });
      expect(result.config, `类型 ${type} 应当产出 config`).toBeTypeOf('object');
    }
  });
});
