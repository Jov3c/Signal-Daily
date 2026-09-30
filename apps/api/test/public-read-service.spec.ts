/**
 * 公开读的缓存与失效（`docs/12`）+ `/today` 的行为。
 *
 * 用内存缓存替身，不需要 Redis。真库的口径在
 * `public-read-db.integration.spec.ts`。
 */

import { describe, expect, it } from 'vitest';
import { ContentType, SourceKind, SourceTier, SourceType, isAppError } from '@signal/contracts';
import {
  CONTENT_CACHE_TTL_SECONDS,
  InMemoryPublicCache,
  METADATA_CACHE_TTL_SECONDS,
  cacheKeys,
  invalidateContent,
  invalidateEventEvidence,
  invalidateMetadata,
  type RedisLike,
  RedisPublicCache,
} from '../src/modules/public-read/cache';
import { PublicReadService } from '../src/modules/public-read/service';
import type { PublicContentRow, PublicReadRepository } from '../src/modules/public-read/repository';

/* ------------------------------------------------------------------ */
/* 替身                                                                */
/* ------------------------------------------------------------------ */

/** 只实现服务层用到的方法；调用计数用来断言「命中缓存时不再查库」。 */
class CountingRepository implements PublicReadRepository {
  findContentCalls = 0;
  listByWindowCalls = 0;

  constructor(private readonly content: PublicContentRow | null) {}

  async findContent(): Promise<PublicContentRow | null> {
    this.findContentCalls += 1;
    return this.content;
  }
  async findContentsByIds(): Promise<PublicContentRow[]> {
    return [];
  }
  async listByWindow(): Promise<PublicContentRow[]> {
    this.listByWindowCalls += 1;
    return [];
  }
  async listX() {
    return { rows: [], nextCursor: null };
  }
  async listPeople() {
    return [];
  }
  async findPersonBySlug() {
    return null;
  }
  async listPersonContents() {
    return [];
  }
  async listTopics() {
    return [];
  }
  async findTopicBySlug() {
    return null;
  }
  async listTopicContents() {
    return [];
  }
  async findSourceBySlug() {
    return null;
  }
  async listSourceContents() {
    return [];
  }
  async findEventEvidence(): Promise<never[]> {
    return [];
  }
  async search() {
    return { rows: [], total: 0 };
  }
  async findContentEventId() {
    return null;
  }
}

/** 一条最小可见内容。 */
function content(id = '1'): PublicContentRow {
  return {
    id,
    type: ContentType.ARTICLE,
    title: `内容 ${id}`,
    summary: null,
    bodyOriginal: null,
    bodyTranslated: null,
    language: 'zh',
    originalUrl: `https://example.com/${id}`,
    imageUrl: null,
    publishedAt: null,
    source: {
      id: '7',
      name: '某来源',
      slug: 'some-source',
      type: SourceType.RSS,
      kind: SourceKind.MEDIA,
      tier: SourceTier.B,
      official: false,
    },
    author: null,
    topics: [],
    recommendationReason: null,
    evidenceSummary: {
      independentSourceCount: 0,
      primarySource: null,
      hasOfficialConfirmation: false,
    },
  };
}

const NOW = new Date('2026-09-29T02:00:00.000Z');

function build(
  repository: CountingRepository,
  cache: InMemoryPublicCache = new InMemoryPublicCache(),
) {
  return {
    repository,
    cache,
    service: new PublicReadService(repository, cache, { now: () => NOW }),
  };
}

/* ------------------------------------------------------------------ */
/* 缓存命中                                                            */
/* ------------------------------------------------------------------ */

describe('内容详情缓存', () => {
  it('第一次查库、第二次命中缓存（不再查库）', async () => {
    const repository = new CountingRepository(content());
    const { service } = build(repository);

    await service.content('1');
    await service.content('1');

    expect(repository.findContentCalls).toBe(1);
  });

  it('⚠ **404 不进缓存** —— 否则刚审核通过的内容会在 TTL 内仍然 404', async () => {
    const repository = new CountingRepository(null);
    const { service, cache } = build(repository);

    await expect(service.content('1')).rejects.toSatisfy((error: unknown) => {
      expect(isAppError(error)).toBe(true);
      if (isAppError(error)) expect(error.code).toBe('CONTENT_NOT_VISIBLE');
      return true;
    });

    expect(cache.size()).toBe(0);
    // 第二次仍然查库（说明「不存在」没被记住）
    await service.content('1').catch(() => undefined);
    expect(repository.findContentCalls).toBe(2);
  });

  it('畸形 / 超界 id → 404，且**根本不查库**（不构成存在性探测器）', async () => {
    const repository = new CountingRepository(content());
    const { service } = build(repository);

    for (const bad of ['abc', '18446744073709551615', '']) {
      await expect(service.content(bad)).rejects.toSatisfy((error: unknown) => {
        expect(isAppError(error)).toBe(true);
        return true;
      });
    }
    expect(repository.findContentCalls).toBe(0);
  });

  it('`/today` 也走缓存，且窗口是**上海业务日**', async () => {
    const repository = new CountingRepository(content());
    const { service } = build(repository);

    const first = await service.today();
    await service.today();

    expect(repository.listByWindowCalls).toBe(2); // featured + latest，只跑一次
    // NOW = UTC 02:00 = 上海 10:00，业务日就是 09-29
    expect(first.businessDate).toBe('2026-09-29');
  });
});

/* ------------------------------------------------------------------ */
/* 失效                                                                */
/* ------------------------------------------------------------------ */

describe('缓存失效（docs/12 要求「主动 invalidation」）', () => {
  it('`invalidateContent` 删掉该内容**与 `today`**（today 是一批内容的投影）', async () => {
    const cache = new InMemoryPublicCache();
    await cache.set(cacheKeys.content('1'), content(), CONTENT_CACHE_TTL_SECONDS);
    await cache.set(cacheKeys.today(), { any: true }, CONTENT_CACHE_TTL_SECONDS);
    await cache.set(cacheKeys.content('2'), content('2'), CONTENT_CACHE_TTL_SECONDS);

    await invalidateContent(cache, '1');

    expect(await cache.get(cacheKeys.content('1'))).toBeNull();
    expect(await cache.get(cacheKeys.today())).toBeNull();
    // 别的内容不受影响
    expect(await cache.get(cacheKeys.content('2'))).not.toBeNull();
  });

  it('`invalidateEventEvidence` 删掉该事件的证据链缓存', async () => {
    const cache = new InMemoryPublicCache();
    await cache.set(cacheKeys.evidence('9'), [{ id: '1' }], CONTENT_CACHE_TTL_SECONDS);

    await invalidateEventEvidence(cache, '9');
    expect(await cache.get(cacheKeys.evidence('9'))).toBeNull();
  });

  it('`invalidateMetadata` 删掉人物与主题两个键', async () => {
    const cache = new InMemoryPublicCache();
    await cache.set(cacheKeys.people(), [], METADATA_CACHE_TTL_SECONDS);
    await cache.set(cacheKeys.topics(), [], METADATA_CACHE_TTL_SECONDS);

    await invalidateMetadata(cache);
    expect(await cache.get(cacheKeys.people())).toBeNull();
    expect(await cache.get(cacheKeys.topics())).toBeNull();
  });

  it('⚠ TTL 到点后自动过期（失效函数没接上时的**兜底**）', async () => {
    let clock = 0;
    const cache = new InMemoryPublicCache(() => clock);
    await cache.set('k', { v: 1 }, 60);

    clock = 59_000;
    expect(await cache.get('k')).not.toBeNull();

    clock = 60_001;
    expect(await cache.get('k')).toBeNull();
  });

  it('内容侧的 TTL 比元数据侧**短**（内容会被撤下，必须尽快生效）', () => {
    expect(CONTENT_CACHE_TTL_SECONDS).toBeLessThan(METADATA_CACHE_TTL_SECONDS);
  });
});

/* ------------------------------------------------------------------ */
/* Redis 实现：失败必须降级，不能挂                                            */
/* ------------------------------------------------------------------ */

describe('RedisPublicCache —— 缓存失败绝不能让请求失败', () => {
  const silent = { warn: (): void => undefined };

  function redisWith(overrides: Partial<RedisLike>): RedisLike {
    return {
      get: async () => null,
      set: async () => 'OK',
      del: async () => 1,
      scan: async () => ['0', []],
      ...overrides,
    };
  }

  it('⚠ `get` 抛错 → 返回 `null`（当作未命中），**不把异常抛给上层**', async () => {
    const cache = new RedisPublicCache(
      redisWith({
        get: () => Promise.reject(new Error('ECONNREFUSED')),
      }),
      silent,
    );
    await expect(cache.get('k')).resolves.toBeNull();
  });

  it('⚠ `set` 抛错 → 静默（不抛）', async () => {
    const cache = new RedisPublicCache(
      redisWith({ set: () => Promise.reject(new Error('ECONNREFUSED')) }),
      silent,
    );
    await expect(cache.set('k', { a: 1 }, 60)).resolves.toBeUndefined();
  });

  it('⚠ `del` / `delByPrefix` 抛错 → 静默（失效失败不该挡住写请求）', async () => {
    const cache = new RedisPublicCache(
      redisWith({
        del: () => Promise.reject(new Error('boom')),
        scan: () => Promise.reject(new Error('boom')),
      }),
      silent,
    );
    await expect(cache.del(['a'])).resolves.toBeUndefined();
    await expect(cache.delByPrefix('v1:x:')).resolves.toBeUndefined();
  });

  it('缓存里是坏 JSON → 当作未命中（不是 500）', async () => {
    const cache = new RedisPublicCache(redisWith({ get: async () => '{not json' }), silent);
    await expect(cache.get('k')).resolves.toBeNull();
  });

  it('正常路径：写入后读得到，且用了 `EX`（带 TTL）', async () => {
    const store = new Map<string, string>();
    const calls: { mode: string; ttl: number }[] = [];
    const cache = new RedisPublicCache(
      redisWith({
        get: async (key) => store.get(key) ?? null,
        set: async (key, value, mode, ttl) => {
          calls.push({ mode, ttl });
          store.set(key, value);
        },
      }),
      silent,
    );

    await cache.set('k', { a: 1 }, 60);
    expect(await cache.get<{ a: number }>('k')).toEqual({ a: 1 });
    expect(calls[0]).toEqual({ mode: 'EX', ttl: 60 });
  });
});
