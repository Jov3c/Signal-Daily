/**
 * Collector 测试用的内存替身与 stub 网络。
 *
 * ── 设计原则（与 Agent 03 的 `source-fakes.ts` 一致）─────────────────
 * 替身只替换**外部依赖**（MySQL / Redis / 网络 / 时钟），
 * 业务逻辑（去重、状态推进、调度规则、适配器解析）跑的都是**真代码**。
 *
 * 尤其网络层：`fetchImpl` 返回的是**真的 `Response` 对象**
 * （Node 内置），因此 `safeFetchText` 里的流式读、`headers.get`、
 * 状态码分支、重定向跟随全都是真跑的。只有「字节从哪来」被换掉了。
 *
 * 这一点是 §23.3 的直接教训：Agent 01 的 FULLTEXT 用例用了纯 ASCII 探针，
 * 于是「测试全绿」只证明了拉丁文可用。这里的 fixture 因此一律用
 * **真实形态的数据**（真实 feed 片段、中文正文、真实字段名）。
 */

import type { DnsLookup, DnsAddress } from '@signal/source-core';
import { SourceType } from '@signal/contracts';
import type { Clock } from '../../src/jobs/collectors/clock';
import type {
  CollectorCursor,
  CollectedItem,
  CollectorAdapter,
  CollectorBatch,
  CollectorContext,
} from '../../src/jobs/collectors/types';
import type {
  CollectorFetchSourcePayload,
  CollectorSource,
  CollectorSourceRepository,
  EnqueuedFetch,
  ExistingKeys,
  ExistingKeysQuery,
  FetchOutcome,
  JobRunInput,
  JobRunRepository,
  NewRawItem,
  RawItemRepository,
  SourceFetchQueue,
  SourceLock,
} from '../../src/jobs/collectors/ports';

/* ------------------------------------------------------------------ */
/* 时钟                                                                */
/* ------------------------------------------------------------------ */

export class FakeClock implements Clock {
  constructor(private current: Date = new Date('2026-09-24T02:00:00.000Z')) {}

  now(): Date {
    return new Date(this.current.getTime());
  }

  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }

  set(at: Date): void {
    this.current = new Date(at.getTime());
  }
}

/* ------------------------------------------------------------------ */
/* 网络                                                                */
/* ------------------------------------------------------------------ */

/** 一个固定的公网地址。测试里不能让 DNS 真的出网 —— 那会让用例依赖网络。 */
export const PUBLIC_ADDRESS: DnsAddress[] = [{ address: '93.184.216.34', family: 4 }];

export const stubLookup: DnsLookup = async () => PUBLIC_ADDRESS;

/** 一次 stub 响应。 */
export type StubResponse = {
  status?: number;
  body?: string;
  headers?: Record<string, string>;
  /** 抛这个错误来模拟网络层失败（超时 / 连不上）。 */
  throw?: Error;
};

/** 记录下来的请求，供断言「请求了什么」与「有没有发请求」。 */
export type RecordedRequest = {
  url: string;
  headers: Record<string, string>;
  method: string;
};

/**
 * 构造一个 stub `fetch`。
 *
 * 按 URL 的子串匹配（`match`），**按顺序**取第一个命中的响应 ——
 * 顺序匹配让「第一次 302、第二次 200」这类重定向链可以被精确表达。
 */
export function createStubFetch(
  routes: { match: string | RegExp; respond: StubResponse | (() => StubResponse) }[],
): { fetchImpl: typeof fetch; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[key.toLowerCase()] = value;
    }
    requests.push({ url, headers, method: init?.method ?? 'GET' });

    const route = routes.find((candidate) =>
      typeof candidate.match === 'string'
        ? url.includes(candidate.match)
        : candidate.match.test(url),
    );
    if (route === undefined) {
      throw new Error(`No stub route for ${url}`);
    }

    const stub = typeof route.respond === 'function' ? route.respond() : route.respond;
    if (stub.throw !== undefined) throw stub.throw;

    return new Response(stub.body ?? '', {
      status: stub.status ?? 200,
      headers: stub.headers ?? { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  return { fetchImpl, requests };
}

/* ------------------------------------------------------------------ */
/* 仓储替身                                                            */
/* ------------------------------------------------------------------ */

export function createSource(overrides: Partial<CollectorSource> = {}): CollectorSource {
  return {
    id: '1',
    name: 'Example Feed',
    slug: 'example-feed',
    type: SourceType.RSS,
    baseUrl: null,
    feedUrl: 'https://example.com/feed.xml',
    externalId: null,
    language: null,
    config: { maxItems: 50 },
    fetchIntervalSeconds: 1800,
    enabled: true,
    ...overrides,
  };
}

export function createPayload(
  overrides: Partial<CollectorFetchSourcePayload> = {},
): CollectorFetchSourcePayload {
  return {
    sourceId: '1',
    trigger: 'schedule',
    requestedAt: '2026-09-24T02:00:00.000Z',
    ...overrides,
  };
}

export type RecordedOutcome = { sourceId: string; outcome: FetchOutcome };

export class InMemorySourceRepository implements CollectorSourceRepository {
  readonly outcomes: RecordedOutcome[] = [];
  readonly cursorCalls: string[] = [];
  readonly dueCalls: { now: Date; limit: number }[] = [];

  constructor(
    private readonly sources: CollectorSource[] = [],
    private cursor: CollectorCursor = { sincePublishedAt: null, sinceExternalId: null },
  ) {}

  async findById(id: string): Promise<CollectorSource | null> {
    return this.sources.find((source) => source.id === id) ?? null;
  }

  /**
   * 取到期来源。
   *
   * ── ⚠ 这个替身**只模型化规则的一半**，先前的注释说反了 ──────────────
   * 它只按 `enabled` 过滤 + 截断到 `limit`；**不**判断 `nextFetchAt`。
   * 原因：`CollectorSource`（采集侧读模型）刻意不含 `nextFetchAt`
   * （那是调度状态，不是采集输入），替身也就没有这个字段可判。
   *
   * 因此「到期」这条规则的**完整**覆盖只在真库集成测试里
   * （`collectors-db.integration.spec.ts` 的 `findDueSources` 一组），
   * 那里打的是真 SQL、真的走 `buildDueSourcesWhere()`。
   *
   * 先前的注释写着「直接解释 `@signal/source-core` 的规则 —— 替身不自己
   * 发明到期的定义」，但实现既没 import 它、也没读过 `now`：
   * 那是一句假话，会让人以为调度器的单测覆盖了到期语义。
   * 现在如实说明它覆盖什么、不覆盖什么，并且**确实**断言 `enabled` ——
   * 那是规则里属于它的一半，也是「停用后不再产生抓取任务」的调度侧保证。
   */
  async findDueSources(now: Date, limit: number): Promise<CollectorSource[]> {
    this.dueCalls.push({ now, limit });
    return this.sources.filter((source) => source.enabled).slice(0, limit);
  }

  async latestCursor(sourceId: string): Promise<CollectorCursor> {
    this.cursorCalls.push(sourceId);
    return this.cursor;
  }

  async recordFetchOutcome(sourceId: string, outcome: FetchOutcome): Promise<void> {
    this.outcomes.push({ sourceId, outcome });
  }

  setCursor(cursor: CollectorCursor): void {
    this.cursor = cursor;
  }
}

export class InMemoryRawItemRepository implements RawItemRepository {
  readonly inserted: NewRawItem[] = [];

  constructor(
    private readonly existing: ExistingKeys = {
      externalIds: new Set(),
      canonicalUrlHashes: new Set(),
    },
  ) {}

  async findExistingKeys(query: ExistingKeysQuery): Promise<ExistingKeys> {
    // 模拟真库的 `IN (...)` 语义：只返回**候选里**确实存在的。
    const externalIds = new Set<string>();
    for (const id of query.externalIds) {
      if (this.existing.externalIds.has(id)) externalIds.add(id);
    }
    const canonicalUrlHashes = new Set<string>();
    for (const hash of query.canonicalUrlHashes) {
      if (this.existing.canonicalUrlHashes.has(hash)) canonicalUrlHashes.add(hash);
    }
    return { externalIds, canonicalUrlHashes };
  }

  /**
   * 写入。**同时把键登记进 `existing`** —— 真库就是这样：
   * 写进去的行下一次 `findExistingKeys` 必须查得到。
   * 少了这一步，「抓两次不重复」这类用例会因为替身不像真库而假绿/假红。
   */
  async insertMany(items: NewRawItem[]): Promise<number> {
    this.inserted.push(...items);
    for (const item of items) {
      if (item.externalId !== null) this.existing.externalIds.add(item.externalId);
      this.existing.canonicalUrlHashes.add(item.canonicalUrlHash);
    }
    return items.length;
  }

  seedExisting(keys: { externalIds?: string[]; canonicalUrlHashes?: string[] }): void {
    for (const id of keys.externalIds ?? []) this.existing.externalIds.add(id);
    for (const hash of keys.canonicalUrlHashes ?? []) this.existing.canonicalUrlHashes.add(hash);
  }
}

export type RecordedJobRun = {
  id: string;
  input: JobRunInput;
  finalled: { status: string; errorCode: string | null; attempts: number } | null;
};

export class InMemoryJobRunRepository implements JobRunRepository {
  readonly runs: RecordedJobRun[] = [];

  async start(_at: Date, input: JobRunInput): Promise<string | null> {
    const id = `jobrun-${this.runs.length + 1}`;
    this.runs.push({ id, input, finalled: null });
    return id;
  }

  async finish(
    id: string | null,
    _at: Date,
    outcome: {
      status: 'SUCCEEDED' | 'FAILED' | 'DEAD';
      errorCode: string | null;
      attempts: number;
    },
  ): Promise<void> {
    if (id === null) return;
    const run = this.runs.find((candidate) => candidate.id === id);
    if (run !== undefined) run.finalled = outcome;
  }
}

/* ------------------------------------------------------------------ */
/* 队列与锁                                                            */
/* ------------------------------------------------------------------ */

export class InMemorySourceFetchQueue implements SourceFetchQueue {
  readonly enqueued: { payload: CollectorFetchSourcePayload; at: Date; jobId: string }[] = [];
  failNext = false;

  async enqueue(payload: CollectorFetchSourcePayload, at: Date): Promise<EnqueuedFetch> {
    if (this.failNext) throw new Error('queue unavailable');
    const window = String(Math.floor(at.getTime() / 60_000));
    const jobId = `collector:${payload.sourceId}:${window}`;
    this.enqueued.push({ payload, at, jobId });
    return { queue: 'collector', jobName: 'collector.fetch-source', jobId, window };
  }

  async close(): Promise<void> {}
}

/**
 * 内存锁。`held` 可以被测试预先占用，用来验证「拿不到锁就跳过」。
 *
 * `failNext` 是**一次性**的（用掉即复位）：名字说的是「下一次失败」，
 * 一次性的语义让「一个来源失败、其它来源照常」这类用例能精确表达。
 * 一个永久失败的开关会让所有来源一起失败，从而掩盖失败隔离本身。
 */
export class InMemorySourceLock implements SourceLock {
  readonly held = new Map<string, string>();
  failNext = false;
  private counter = 0;

  async acquire(key: string, _ttlMs: number): Promise<string | null> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('redis unavailable');
    }
    if (this.held.has(key)) return null;
    this.counter += 1;
    const token = `token-${this.counter}`;
    this.held.set(key, token);
    return token;
  }

  async release(key: string, token: string): Promise<void> {
    if (this.held.get(key) === token) this.held.delete(key);
  }
}

/* ------------------------------------------------------------------ */
/* 适配器替身                                                          */
/* ------------------------------------------------------------------ */

/** 一个只返回固定批次的适配器，用于编排层测试。 */
export class StubAdapter implements CollectorAdapter {
  readonly type = SourceType.RSS;
  calls: { cursor: CollectorCursor; context: CollectorContext }[] = [];

  constructor(private readonly respond: (call: number) => Promise<CollectorBatch>) {}

  async fetch(
    _source: CollectorSource,
    cursor: CollectorCursor,
    context: CollectorContext,
  ): Promise<CollectorBatch> {
    this.calls.push({ cursor, context });
    return this.respond(this.calls.length);
  }
}

export function createItem(overrides: Partial<CollectedItem> = {}): CollectedItem {
  return {
    sourceId: '1',
    externalId: 'item-1',
    originalUrl: 'https://example.com/post-1',
    canonicalUrl: 'https://example.com/post-1',
    title: '示例标题',
    body: '示例正文',
    language: 'zh',
    publishedAt: new Date('2026-09-24T01:00:00.000Z'),
    author: 'someone',
    type: 'ARTICLE',
    payload: { feedFormat: 'rss' },
    ...overrides,
  } as CollectedItem;
}

export function batchOf(items: CollectedItem[], skippedCount = 0): CollectorBatch {
  return { items, complete: true, skippedCount, warnings: [] };
}
