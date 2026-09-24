/**
 * 独立审查之后补的**服务层回归守卫**。
 *
 * 这里的每一条都对应一个「868 项测试全绿却真实存在」的缺陷。
 * 它们的共同点是：**只有把真适配器接进真 service 才跑得到**。
 * 原先适配器测试不过 service、service 测试用替身，
 * 于是中间那段路径完全没有覆盖。
 */

import { describe, expect, it } from 'vitest';
import { SourceType } from '@signal/contracts';
import { createLogger } from '@signal/logger';
import { createMemoryStream } from '@signal/test-utils';
import { CollectorService } from '../src/jobs/collectors/collector.service';
import type { AdapterRegistry } from '../src/jobs/collectors/adapters';
import { createAdapterRegistry } from '../src/jobs/collectors/adapters';
import type { CollectorConfig } from '../src/jobs/collectors/collector.config';
import {
  EXTERNAL_ID_MAX_CHARS,
  URL_MAX_CHARS,
  clampToBytes,
  clampToChars,
  isStorableUrl,
  normalizeLanguageTag,
} from '../src/jobs/collectors/field-limits';
import {
  FakeClock,
  InMemoryJobRunRepository,
  InMemoryRawItemRepository,
  InMemorySourceLock,
  InMemorySourceRepository,
  StubAdapter,
  batchOf,
  createItem,
  createPayload,
  createSource,
  createStubFetch,
  stubLookup,
} from './support/collector-fakes';
import {
  GITHUB_REPO_JSON,
  RSS_2_0_HNRSS,
  X_TWEETS_JSON,
  X_USER_JSON,
} from './support/feed-fixtures';

const START = new Date('2026-09-24T02:00:00.000Z');
const RUN = { attempt: 1, isFinalAttempt: false };

function buildService(options: {
  adapter?: StubAdapter;
  registry?: AdapterRegistry;
  sources?: ReturnType<typeof createSource>[];
  rawItems?: InMemoryRawItemRepository;
  jobRuns?: InMemoryJobRunRepository;
  config?: Partial<CollectorConfig>;
}) {
  const sources = new InMemorySourceRepository(
    options.sources ?? [createSource({ id: '1', type: SourceType.RSS })],
  );
  const rawItems = options.rawItems ?? new InMemoryRawItemRepository();
  const jobRuns = options.jobRuns ?? new InMemoryJobRunRepository();
  const lock = new InMemorySourceLock();
  const clock = new FakeClock(START);
  const logStream = createMemoryStream();
  const adapter = options.adapter ?? new StubAdapter(async () => batchOf([]));

  const registry =
    options.registry ??
    (Object.fromEntries(
      Object.values(SourceType).map((type) => [type, adapter]),
    ) as unknown as AdapterRegistry);

  const config: CollectorConfig = {
    nodeEnv: 'test',
    fetchTimeoutMs: 5_000,
    fetchMaxBytes: 2_097_152,
    xApiBearerToken: null,
    githubToken: null,
    redisUrl: 'redis://127.0.0.1:6390',
    schedulerIntervalMs: 60_000,
    ...options.config,
  };

  const service = new CollectorService(
    config,
    clock,
    sources,
    rawItems,
    jobRuns,
    lock,
    registry,
    createLogger({ service: 'collector-guard-test', level: 'info', destination: logStream }),
  );

  return { service, sources, rawItems, jobRuns, logStream };
}

/* ================================================================== */
/* P0 的服务层回归：真适配器 × 真 service × 真守卫                      */
/* ================================================================== */

describe('真适配器接进真 service（P0 的回归守卫）', () => {
  it('**X 适配器的产出能真正落库** —— 曾经 0 条，因为 payload 被守卫拦下', async () => {
    // 这是本次独立审查最严重的一条：X 适配器用 `payload.kind` 记录推文的
    // 引用关系，与「Source 元数据不得进 payload」的黑名单守卫撞名 →
    // 每条推文都在落库前抛错 → `SourceType.X_USER` 整体不可用。
    //
    // 适配器测试断言 `payload['kind']` 存在、守卫测试断言 `kind` 必须被拒 ——
    // 两条互相矛盾的断言从来没有同时执行过，因为
    // 「真适配器 → 真 service」这条路径原先在结构上写不出来
    // （service 不透传 fetchImpl，会打真网）。
    const stub = createStubFetch([
      { match: 'by/username', respond: { body: X_USER_JSON } },
      { match: '/tweets?', respond: { body: X_TWEETS_JSON } },
    ]);
    const { service, rawItems } = buildService({
      sources: [
        createSource({
          id: '1',
          slug: 'x-karpathy',
          type: SourceType.X_USER,
          feedUrl: null,
          externalId: 'karpathy',
          config: { handle: 'karpathy', includeQuotes: true },
        }),
      ],
      registry: createAdapterRegistry(),
      config: {
        xApiBearerToken: 'test-token',
        fetchImpl: stub.fetchImpl,
        lookup: stubLookup,
      },
    });

    const outcome = await service.runCollect(createPayload(), RUN);

    expect(outcome.status).toBe('succeeded');
    expect(outcome).toMatchObject({ collected: 2, stored: 2 });
    expect(rawItems.inserted).toHaveLength(2);
    // payload 真的写进去了，且用的是 `postKind`。
    expect(rawItems.inserted[0]!.payload['postKind']).toBeDefined();
  });

  it('RSS 适配器的产出同样能落库（对照，确认上面那条不是特例）', async () => {
    const stub = createStubFetch([{ match: 'feed.xml', respond: { body: RSS_2_0_HNRSS } }]);
    const { service, rawItems } = buildService({
      sources: [
        createSource({ id: '1', type: SourceType.RSS, feedUrl: 'https://example.com/feed.xml' }),
      ],
      registry: createAdapterRegistry(),
      config: { fetchImpl: stub.fetchImpl, lookup: stubLookup },
    });

    const outcome = await service.runCollect(createPayload(), RUN);
    expect(outcome).toMatchObject({ status: 'succeeded', stored: 2 });
    expect(rawItems.inserted).toHaveLength(2);
  });

  it('GitHub 仓库的 `language`（编程语言名）不会写进 `Char(5)` 列', async () => {
    // 曾经 `repo.language = "JavaScript"` 会被直接写进 `raw_items.language`
    // （BCP-47 语言标签、`Char(5)`）→ 真库报「column too long」→
    // 该来源**永久失败**、0 条入库，而症状只是「这个来源一直是空的」。
    const stub = createStubFetch([{ match: '/repos/', respond: { body: GITHUB_REPO_JSON } }]);
    const { service, rawItems } = buildService({
      sources: [
        createSource({
          id: '1',
          slug: 'gh-nodejs',
          type: SourceType.GITHUB_REPO,
          feedUrl: null,
          externalId: 'nodejs/node',
          config: { includeReleases: false },
        }),
      ],
      registry: createAdapterRegistry(),
      config: { fetchImpl: stub.fetchImpl, lookup: stubLookup },
    });

    const outcome = await service.runCollect(createPayload(), RUN);

    expect(outcome).toMatchObject({ status: 'succeeded', stored: 1 });
    // `JavaScript` 不是语言标签 → 收敛成 null，交给 Pipeline 判定。
    expect(rawItems.inserted[0]!.language).toBeNull();
  });
});

describe('X 的 `lang` 也走语言收敛（N3）', () => {
  it('超过列宽的语言标签不会被直接写进 `Char(5)`（否则该来源永久 0 条）', async () => {
    // ⚠ 第一轮审查指出「X 的 `lang` 是同一族问题，建议一并收敛」，
    // 我当时只改了 GitHub 那条路径 —— 复审用真库复现出：
    // `lang="zh-Hant"` → `The provided value for the column is too long … Column: language`
    // → **整批 0 条入库**，而症状只是「这个来源一直是空的」。
    // 复审的反证还显示：把收敛接上 X 之后 202 项单测 + 46 项集成**全绿**，
    // 即这条路径**零覆盖** —— 所以这一条既是修复也是那条缺失的守卫。
    const stub = createStubFetch([
      { match: 'by/username', respond: { body: X_USER_JSON } },
      {
        match: '/tweets?',
        respond: {
          body: JSON.stringify({
            data: [
              {
                id: '1900000000000000001',
                text: '繁體中文的推文',
                created_at: '2026-09-24T01:00:00.000Z',
                lang: 'zh-Hant', // 6 字符 > Char(5)
              },
            ],
          }),
        },
      },
    ]);
    const { service, rawItems } = buildService({
      sources: [
        createSource({
          id: '1',
          slug: 'x-karpathy',
          type: SourceType.X_USER,
          feedUrl: null,
          externalId: 'karpathy',
          config: { handle: 'karpathy' },
        }),
      ],
      registry: createAdapterRegistry(),
      config: { xApiBearerToken: 'test-token', fetchImpl: stub.fetchImpl, lookup: stubLookup },
    });

    const outcome = await service.runCollect(createPayload(), RUN);

    expect(outcome).toMatchObject({ status: 'succeeded', stored: 1 });
    // `zh-Hant` 是合法 BCP-47 但超过列宽 → 收敛成 null，交给 Pipeline 判定。
    expect(rawItems.inserted[0]!.language).toBeNull();
  });

  it('短标签照常保留（不要把正常值也一起丢掉）', async () => {
    const stub = createStubFetch([
      { match: 'by/username', respond: { body: X_USER_JSON } },
      {
        match: '/tweets?',
        respond: {
          body: JSON.stringify({
            data: [
              {
                id: '1900000000000000002',
                text: '中文推文',
                created_at: '2026-09-24T01:00:00.000Z',
                lang: 'zh',
              },
            ],
          }),
        },
      },
    ]);
    const { service, rawItems } = buildService({
      sources: [
        createSource({
          id: '1',
          slug: 'x-karpathy',
          type: SourceType.X_USER,
          feedUrl: null,
          externalId: 'karpathy',
          config: { handle: 'karpathy' },
        }),
      ],
      registry: createAdapterRegistry(),
      config: { xApiBearerToken: 'test-token', fetchImpl: stub.fetchImpl, lookup: stubLookup },
    });

    await service.runCollect(createPayload(), RUN);
    expect(rawItems.inserted[0]!.language).toBe('zh');
  });
});

/* ================================================================== */
/* 字段长度收敛（一条坏条目不再连累整批）                               */
/* ================================================================== */

describe('RSS 的每轮上限**不会造成永久丢失**（N2 的回归守卫）', () => {
  /**
   * ⚠ 这条守卫是第二轮独立复审逼出来的。
   *
   * 原先适配器在 `maxItems` 处直接 `break` —— 而 feed 的顺序是**稳定的**
   * （新条目插在头部），所以每一轮都取**同一批**最新的 N 条，
   * 第 N+1 条之后**永远轮不到**。实测（复审者）：12 条 feed + `maxItems=2`，
   * 连采 4 轮库里仍只有 2 条，其余 10 条永久丢失。
   *
   * 当时我把它「修好了一半」：`complete` 如实了、时间游标去掉了，
   * 但丢失仍在，而 HANDOFF 里写着「其余的下一轮还有机会」——**与实测相反**。
   *
   * 现在改成：适配器返回整个窗口、由 service 在**去重之后**按 `roundLimit`
   * 截断。已经采到的被幂等键挡掉，下一轮自然从上次停下的地方继续。
   */
  it('12 条 feed + 每轮上限 2 条，连采 6 轮后**全部采到**', async () => {
    const items = Array.from({ length: 12 }, (_value, index) =>
      createItem({
        externalId: `post-${index + 1}`,
        canonicalUrl: `https://example.com/post-${index + 1}`,
        originalUrl: `https://example.com/post-${index + 1}`,
      }),
    );
    // 顺序固定（最新在前），与真实 feed 一致。
    const adapter = new StubAdapter(async () => ({
      items,
      complete: true,
      skippedCount: 0,
      warnings: [],
      roundLimit: 2,
    }));
    const rawItems = new InMemoryRawItemRepository();
    const { service } = buildService({ adapter, rawItems });

    for (let round = 0; round < 6; round += 1) {
      const outcome = await service.runCollect(createPayload(), RUN);
      expect(outcome.status).toBe('succeeded');
    }

    const stored = rawItems.inserted.map((row) => row.externalId).sort();
    expect(stored).toHaveLength(12);
    expect(stored).toEqual(items.map((item) => item.externalId).sort());
  });

  it('**真 RSS 适配器 × 真 service**：6 条 feed + maxItems=2，3 轮后全部入库', async () => {
    // ⚠ 这条才是 N2 的**端到端**守卫。
    // 上面两条用的是 `StubAdapter`，只证明了「service 会按 roundLimit 截断」——
    // 反证实测：把 RSS 适配器改回「自己按 maxItems 截断」，那两条**仍然全绿**
    // （因为 stub 不受影响）。守卫必须落在**真实的适配器 + 真实的 service**
    // 这条路径上，否则它验的是替身自己的行为。
    //
    // 这份 feed 的顺序是固定的（最新在前），与真实 feed 一致 ——
    // 正是「顺序稳定」让旧的实现永久停在最新 N 条。
    const entries = Array.from(
      { length: 6 },
      (_value, index) =>
        `<item><title>第 ${index + 1} 条</title><link>https://example.com/p-${index + 1}</link></item>`,
    ).join('\n');
    const stub = createStubFetch([
      {
        match: 'feed.xml',
        respond: {
          body: `<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>\n${entries}\n</channel></rss>`,
        },
      },
    ]);

    const { service, rawItems } = buildService({
      sources: [
        createSource({
          id: '1',
          type: SourceType.RSS,
          feedUrl: 'https://example.com/feed.xml',
          config: { maxItems: 2 },
        }),
      ],
      registry: createAdapterRegistry(),
      config: { fetchImpl: stub.fetchImpl, lookup: stubLookup },
    });

    const perRound: number[] = [];
    for (let round = 0; round < 3; round += 1) {
      const before = rawItems.inserted.length;
      const outcome = await service.runCollect(createPayload(), RUN);
      expect(outcome.status).toBe('succeeded');
      perRound.push(rawItems.inserted.length - before);
    }

    expect(perRound).toEqual([2, 2, 2]);
    // 这份 fixture 的条目没有 `<guid>`，所以 externalId 是 null —— 去重靠
    // `canonicalUrlHash`（`docs/06` 的幂等第 2 条）。断言 accordingly。
    expect(rawItems.inserted.map((row) => row.canonicalUrl).sort()).toEqual([
      'https://example.com/p-1',
      'https://example.com/p-2',
      'https://example.com/p-3',
      'https://example.com/p-4',
      'https://example.com/p-5',
      'https://example.com/p-6',
    ]);
  });

  it('观察每一轮的推进（每一轮入库 2 条且不重复）', async () => {
    const items = Array.from({ length: 6 }, (_value, index) =>
      createItem({
        externalId: `p-${index + 1}`,
        canonicalUrl: `https://example.com/p-${index + 1}`,
        originalUrl: `https://example.com/p-${index + 1}`,
      }),
    );
    const adapter = new StubAdapter(async () => ({
      items,
      complete: true,
      skippedCount: 0,
      warnings: [],
      roundLimit: 2,
    }));
    const rawItems = new InMemoryRawItemRepository();
    const { service } = buildService({ adapter, rawItems });

    const perRound: number[] = [];
    for (let round = 0; round < 3; round += 1) {
      const before = rawItems.inserted.length;
      await service.runCollect(createPayload(), RUN);
      perRound.push(rawItems.inserted.length - before);
    }

    expect(perRound).toEqual([2, 2, 2]);
    expect(rawItems.inserted.map((row) => row.externalId)).toEqual([
      'p-1',
      'p-2',
      'p-3',
      'p-4',
      'p-5',
      'p-6',
    ]);
  });
});

describe('字段长度收敛到列宽以内', () => {
  it('超长 externalId 被截断（而不是让整批失败）', async () => {
    const adapter = new StubAdapter(async () =>
      batchOf([createItem({ externalId: 'x'.repeat(600) })]),
    );
    const { service, rawItems } = buildService({ adapter });

    const outcome = await service.runCollect(createPayload(), RUN);

    expect(outcome).toMatchObject({ status: 'succeeded', stored: 1 });
    expect(rawItems.inserted[0]!.externalId).toHaveLength(EXTERNAL_ID_MAX_CHARS);
  });

  it('超长 URL 的条目被**丢掉并计数**（截断 URL 会造出 404 链接）', async () => {
    const adapter = new StubAdapter(async () =>
      batchOf([
        createItem({ externalId: 'bad', canonicalUrl: `https://example.com/${'a'.repeat(3000)}` }),
        createItem({ externalId: 'good', canonicalUrl: 'https://example.com/ok' }),
      ]),
    );
    const { service, rawItems, logStream } = buildService({ adapter });

    const outcome = await service.runCollect(createPayload(), RUN);

    // 关键：**好的那条仍然落库**（旧行为是整批失败）。
    expect(outcome).toMatchObject({ status: 'succeeded', stored: 1 });
    expect(rawItems.inserted[0]!.externalId).toBe('good');
    expect(
      logStream
        .records()
        .map((r) => JSON.stringify(r))
        .join('\n'),
    ).toMatch(/dropped or truncated/);
  });

  it('超长标题被按**字节**截断（`Text` 是 65535 字节，不是字符）', async () => {
    const adapter = new StubAdapter(async () =>
      batchOf([createItem({ title: '中'.repeat(40_000) })]),
    );
    const { service, rawItems } = buildService({ adapter });

    const outcome = await service.runCollect(createPayload(), RUN);

    expect(outcome).toMatchObject({ status: 'succeeded', stored: 1 });
    const title = rawItems.inserted[0]!.titleRaw!;
    expect(new TextEncoder().encode(title).length).toBeLessThanOrEqual(64_000);
    // 40,000 个中文字是 120,000 字节 → 必须被截断。
    expect(title.length).toBeLessThan(40_000);
  });

  it('`canonicalUrlHash` 基于**截断后**的 URL（否则去重与库里的 URL 不一致）', async () => {
    const adapter = new StubAdapter(async () => batchOf([createItem()]));
    const { service, rawItems } = buildService({ adapter });
    await service.runCollect(createPayload(), RUN);

    const { sha256Hex } = await import('../src/jobs/collectors/hashing');
    expect(rawItems.inserted[0]!.canonicalUrlHash).toBe(
      sha256Hex(rawItems.inserted[0]!.canonicalUrl),
    );
  });
});

describe('超长 externalId 的两条条目在**截断后**仍被判重（N6）', () => {
  it('只在第 513 个字符上不同的两条 guid → 只入库 1 条', async () => {
    // 先去重、后收敛时，两条未截断的 guid 各自通过批内去重，
    // 却在落库时撞成同一个 `external_id` → 库里两行同 id
    // （`raw_items` 上没有唯一约束，不报错），`docs/06` 的幂等键被绕过。
    const prefix = 'g'.repeat(600);
    const adapter = new StubAdapter(async () =>
      batchOf([
        createItem({
          externalId: `${prefix}A`,
          canonicalUrl: 'https://example.com/a',
          originalUrl: 'https://example.com/a',
        }),
        createItem({
          externalId: `${prefix}B`,
          canonicalUrl: 'https://example.com/b',
          originalUrl: 'https://example.com/b',
        }),
      ]),
    );
    const { service, rawItems } = buildService({ adapter });

    const outcome = await service.runCollect(createPayload(), RUN);

    expect(outcome).toMatchObject({ status: 'succeeded', stored: 1, duplicates: 1 });
    expect(rawItems.inserted).toHaveLength(1);
    // 落库的那个必须是**截断后**的长度。
    expect(rawItems.inserted[0]!.externalId).toHaveLength(EXTERNAL_ID_MAX_CHARS);
  });
});

describe('field-limits 工具本身', () => {
  it('clampToChars 按字符计（VARCHAR 的语义）', () => {
    expect(clampToChars('中'.repeat(10), 4)).toBe('中中中中');
  });

  it('clampToBytes 按 UTF-8 字节计且不切断字符', () => {
    // 每个中文 3 字节 → 10 字节最多 3 个字符。
    expect(clampToBytes('中'.repeat(10), 10)).toBe('中中中');
    expect(new TextEncoder().encode(clampToBytes('🚀'.repeat(10), 9)).length).toBeLessThanOrEqual(
      9,
    );
    // 未超限时原样返回。
    expect(clampToBytes('abc', 100)).toBe('abc');
  });

  it('normalizeLanguageTag 只接受 BCP-47 形状', () => {
    expect(normalizeLanguageTag('zh')).toBe('zh');
    expect(normalizeLanguageTag('en-US')).toBe('en-US');
    // 长度超过列宽 → null。
    expect(normalizeLanguageTag('Chinese')).toBeNull();
    // 编程语言名 → null（这是 P2 修复的核心）。
    expect(normalizeLanguageTag('JavaScript')).toBeNull();
    expect(normalizeLanguageTag('Jupyter Notebook')).toBeNull();
    expect(normalizeLanguageTag('')).toBeNull();
    expect(normalizeLanguageTag(null)).toBeNull();
  });

  it('isStorableUrl 只接受长度合规的绝对 http(s) 地址', () => {
    expect(isStorableUrl('https://example.com/ok')).toBe(true);
    expect(isStorableUrl(`https://example.com/${'a'.repeat(URL_MAX_CHARS)}`)).toBe(false);
    expect(isStorableUrl('javascript:alert(1)')).toBe(false);
    expect(isStorableUrl('')).toBe(false);
  });
});

/* ================================================================== */
/* JobRun 终态（F-05）                                                  */
/* ================================================================== */

describe('不可重试的失败立刻是终态 DEAD', () => {
  it('第 1 次尝试就遇到不可重试失败 → JobRun = DEAD（不是 FAILED）', async () => {
    // 曾经只按 `isFinalAttempt` 判断，于是「令牌没配」这类失败
    // （第 1 次就被 UnrecoverableError 终止，永远没有第 3 次）的 JobRun
    // **永远停在 FAILED** —— 而它恰恰是唯一需要人动手的那一类，
    // `docs/13` 的 dead-letter 视图会漏掉它们。
    const adapter = new StubAdapter(async () => {
      const { credentialsMissing } = await import('../src/jobs/collectors/errors');
      throw credentialsMissing('token not configured');
    });
    const { service, jobRuns } = buildService({ adapter });

    const outcome = await service.runCollect(createPayload(), {
      attempt: 1,
      isFinalAttempt: false,
    });

    expect(outcome).toMatchObject({ status: 'failed', retryable: false });
    expect(jobRuns.runs[0]!.finalled).toMatchObject({ status: 'DEAD', attempts: 1 });
  });

  it('对照：**可重试**失败在第 1 次尝试时仍是 FAILED', async () => {
    const adapter = new StubAdapter(async () => {
      const { fetchFailed } = await import('../src/jobs/collectors/errors');
      throw fetchFailed('upstream 502');
    });
    const { service, jobRuns } = buildService({ adapter });

    await service.runCollect(createPayload(), { attempt: 1, isFinalAttempt: false });

    expect(jobRuns.runs[0]!.finalled).toMatchObject({ status: 'FAILED' });
  });

  it('可重试失败的最后一次尝试 → DEAD', async () => {
    const adapter = new StubAdapter(async () => {
      const { fetchFailed } = await import('../src/jobs/collectors/errors');
      throw fetchFailed('upstream 502');
    });
    const { service, jobRuns } = buildService({ adapter });

    await service.runCollect(createPayload(), { attempt: 3, isFinalAttempt: true });

    expect(jobRuns.runs[0]!.finalled).toMatchObject({ status: 'DEAD', attempts: 3 });
  });
});

/* ================================================================== */
/* `complete: false` 必须可见（F-03）                                   */
/* ================================================================== */

describe('适配器没取完时记警告', () => {
  it('`complete: false` → 一条 warn 日志（而不是恒为 true 的字段）', async () => {
    const adapter = new StubAdapter(async () => ({
      ...batchOf([createItem()]),
      complete: false,
      warnings: ['feed offered 200 entries but only 50 were taken'],
    }));
    const { service, logStream } = buildService({ adapter });

    await service.runCollect(createPayload(), RUN);

    const logs = logStream
      .records()
      .map((record) => JSON.stringify(record))
      .join('\n');
    expect(logs).toMatch(/did not take everything/);
    expect(logs).toMatch(/offered 200/);
  });
});
