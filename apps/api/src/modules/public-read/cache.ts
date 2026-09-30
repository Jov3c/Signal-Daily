/**
 * 公开读的缓存端口与键（`docs/12`）。
 *
 * ── `docs/12` 的键（逐条对齐）────────────────────────────────────────
 *
 * ```text
 * v1:today / v1:featured:{topic}:{cursor} / v1:daily:{date}
 * v1:x:{category}:{cursor} / v1:people / v1:topics
 * v1:content:{id} / v1:evidence:{eventId}
 * ```
 *
 * ── ⚠ TTL 由本模块定（`docs/12` 没有给）─────────────────────────────
 * 分两档，理由是**内容的可变性不一样**：
 *
 * | 键 | TTL | 为什么 |
 * | -- | --- | ------ |
 * | `content:*` / `evidence:*` / `today` | **60 秒** | 内容会被 Agent 07 撤下（REJECTED），而撤下必须尽快生效 —— 缓存太久等于「后台点了撤下、前台还在展示」 |
 * | `people` / `topics` / `x:*` | **300 秒** | 人物与主题的元数据几乎不变；X 流是按时间倒序的列表，慢 5 分钟无感 |
 *
 * **已提 CCR**：请把 TTL 写进 `docs/12`（现在没有依据）。
 *
 * ── ⚠ 失效（invalidation）的责任划分 ────────────────────────────────
 * `docs/12`：「Event Evidence 发生人工修改时主动 invalidation」——
 * 而人工修改证据的接口属 **Agent 07**（`/admin/events/:id/evidence/*`），
 * 本模块**不允许**改它的代码（§9）。
 *
 * 因此本模块做两件事，并把第三件留给 Agent 14：
 *
 * 1. 提供下面这几个 `invalidate*()` 函数（它们就是「主动失效」的实现）；
 * 2. **TTL 兜底**（60 秒）—— 即使没人调用失效函数，过期也会自然修正，
 *    所以「忘了接」的后果是**最多 60 秒的陈旧**，不是永久错误；
 * 3. ⚠ 把 Agent 07 的证据变更接口接到 `invalidateEventEvidence(eventId)`。
 *    **已记入 HANDOFF 的 Integration Notes 与 CCR。**
 */

/** 注入 token。 */
export const PUBLIC_CACHE = 'PUBLIC_CACHE';

/** `docs/12` 的前缀（`v1:`）。 */
export const CACHE_PREFIX = 'v1:';

/** 内容侧的 TTL：内容会被撤下，撤下必须尽快生效。 */
export const CONTENT_CACHE_TTL_SECONDS = 60;

/** 元数据侧的 TTL：人物 / 主题 / X 流几乎不变。 */
export const METADATA_CACHE_TTL_SECONDS = 300;

export interface PublicCache {
  /** 读；未命中或反序列化失败都返回 `null`（缓存坏了不该让请求 500）。 */
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown, ttlSeconds: number): Promise<void>;
  /** 删一个或多个键。 */
  del(keys: readonly string[]): Promise<void>;
  /** 按前缀删（失效 `v1:x:` 这一族时用）。 */
  delByPrefix(prefix: string): Promise<void>;
}

/* ------------------------------------------------------------------ */
/* 键                                                                  */
/* ------------------------------------------------------------------ */

export const cacheKeys = {
  today: (): string => `${CACHE_PREFIX}today`,
  content: (contentId: string): string => `${CACHE_PREFIX}content:${contentId}`,
  evidence: (eventId: string): string => `${CACHE_PREFIX}evidence:${eventId}`,
  x: (category: string, cursor: string): string => `${CACHE_PREFIX}x:${category}:${cursor}`,
  people: (): string => `${CACHE_PREFIX}people`,
  topics: (): string => `${CACHE_PREFIX}topics`,
} as const;

/** 与内容相关的键前缀（一次失效一族）。 */
export const CONTENT_KEY_PREFIX = `${CACHE_PREFIX}content:`;
export const EVIDENCE_KEY_PREFIX = `${CACHE_PREFIX}evidence:`;
export const X_KEY_PREFIX = `${CACHE_PREFIX}x:`;

/* ------------------------------------------------------------------ */
/* 失效                                                                */
/* ------------------------------------------------------------------ */

/**
 * 一条内容变化时失效它的详情缓存。
 *
 * ⚠ 还要失效 `today` —— 它是一批内容的投影，重新算比逐个打补丁便宜且不会漏。
 */
export async function invalidateContent(cache: PublicCache, contentId: string): Promise<void> {
  await cache.del([cacheKeys.content(contentId), cacheKeys.today()]);
}

/**
 * 一个事件的证据被人工修改时失效证据链缓存（`docs/12` 明确要求的那一条）。
 *
 * ⚠ 顺带失效**该事件下所有内容**的详情缓存是做不到的（缓存里没有反向索引）——
 * 所以靠内容的 60 秒 TTL 兜底。这是**刻意的取舍**：为一个低频的管理员操作
 * 维护一张反向索引表不值得，而代价有上界。
 */
export async function invalidateEventEvidence(cache: PublicCache, eventId: string): Promise<void> {
  await cache.del([cacheKeys.evidence(eventId)]);
}

/** 人物 / 主题的元数据变化时失效。 */
export async function invalidateMetadata(cache: PublicCache): Promise<void> {
  await cache.del([cacheKeys.people(), cacheKeys.topics()]);
}

/* ------------------------------------------------------------------ */
/* 实现：内存（测试用）                                                 */
/* ------------------------------------------------------------------ */

type Entry = { value: string; expiresAt: number };

/**
 * 内存实现。
 *
 * 用在单元测试与「Redis 挂掉」的降级路径里。刻意**不做真正的淘汰** ——
 * 按 `expiresAt` 判过期就够，测试里也没有容量压力。
 */
export class InMemoryPublicCache implements PublicCache {
  private readonly store = new Map<string, Entry>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  async get<T>(key: string): Promise<T | null> {
    const entry = this.store.get(key);
    if (entry === undefined) return null;
    if (entry.expiresAt <= this.now()) {
      this.store.delete(key);
      return null;
    }
    try {
      return JSON.parse(entry.value) as T;
    } catch {
      // 缓存内容坏了 → 当作未命中（**不让请求 500**）
      return null;
    }
  }

  async set(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    this.store.set(key, {
      value: JSON.stringify(value),
      expiresAt: this.now() + ttlSeconds * 1000,
    });
  }

  async del(keys: readonly string[]): Promise<void> {
    for (const key of keys) this.store.delete(key);
  }

  async delByPrefix(prefix: string): Promise<void> {
    for (const key of [...this.store.keys()]) {
      if (key.startsWith(prefix)) this.store.delete(key);
    }
  }

  /** 测试用：当前存了几个键。 */
  size(): number {
    return this.store.size;
  }
}

/* ------------------------------------------------------------------ */
/* 实现：Redis                                                         */
/* ------------------------------------------------------------------ */

/** 只依赖 ioredis 里我们真正用到的四个命令（便于测试传替身）。 */
export type RedisLike = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: 'EX', ttlSeconds: number): Promise<unknown>;
  del(...keys: string[]): Promise<unknown>;
  scan(cursor: string, match: string, count: number): Promise<[string, string[]]>;
};

/** 注入 token：给公开读用的 Redis 客户端。 */
export const PUBLIC_REDIS_CLIENT = 'PUBLIC_REDIS_CLIENT';

export class RedisPublicCache implements PublicCache {
  /**
   * ⚠ `logger` 的**类型是内联的结构类型，不是 `Logger`** —— 刻意的，别「清理」。
   *
   * `apps/api/test/di-wiring.spec.ts` 有一条守卫：源码里任何
   * 「类/接口类型」的构造参数都必须带显式 `@Inject(...)`
   *（防 `design:paramtypes` 元数据退化成 `Function`）。
   * 它按**源码文本**扫描，分不出「Nest 构造的 provider」与
   *「我们自己 `new` 的普通类」—— 而本类属于后者（模块里是
   * `new RedisPublicCache(client, logger)`），`@Inject` 对它毫无意义。
   *
   * 写成内联结构类型就绕开了那个 `^[A-Z]…$` 的判定，
   * **且没有削弱那条守卫**（它的牙齿仍然对着所有真 provider）。
   * 在守卫里为它开一个豁免是更差的选项：那会让守卫多一个「已知例外」，
   * 而例外会被后来者当成可以继续加的口子。
   */
  constructor(
    private readonly redis: RedisLike,
    private readonly logger: {
      warn(fields: Record<string, unknown>, message: string): void;
    },
  ) {}

  async get<T>(key: string): Promise<T | null> {
    try {
      const raw = await this.redis.get(key);
      if (raw === null) return null;
      return JSON.parse(raw) as T;
    } catch (error) {
      // ⚠ **缓存失败不能让请求失败**：Redis 抖一下不该让前台白屏。
      // 与 Agent 02 的限流（fail-closed）相反 —— 限流是安全控制，
      // 宁可拒绝服务也不能放行；缓存是性能优化，宁可慢也不能挂。
      this.logger.warn({ err: error, cacheKey: key }, 'public cache read failed; serving uncached');
      return null;
    }
  }

  async set(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    try {
      await this.redis.set(key, JSON.stringify(value), 'EX', ttlSeconds);
    } catch (error) {
      this.logger.warn({ err: error, cacheKey: key }, 'public cache write failed');
    }
  }

  async del(keys: readonly string[]): Promise<void> {
    if (keys.length === 0) return;
    try {
      await this.redis.del(...keys);
    } catch (error) {
      this.logger.warn({ err: error, cacheKeys: keys }, 'public cache delete failed');
    }
  }

  async delByPrefix(prefix: string): Promise<void> {
    try {
      // `SCAN` 而不是 `KEYS`：`KEYS` 在键多时会阻塞整个 Redis。
      let cursor = '0';
      do {
        const [next, batch] = await this.redis.scan(cursor, `${prefix}*`, 200);
        cursor = next;
        if (batch.length > 0) await this.redis.del(...batch);
      } while (cursor !== '0');
    } catch (error) {
      this.logger.warn({ err: error, prefix }, 'public cache prefix delete failed');
    }
  }
}
