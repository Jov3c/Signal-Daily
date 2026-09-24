/**
 * Sources 模块测试用的内存替身。
 *
 * 与 Agent 02 的 `fakes.ts` 同一原则：替身**刻意复刻真实实现的关键约束**，
 * 否则测试就是自证。这里复刻的是：
 *   - `sources.slug` 的唯一约束（撞车抛 P2002）；
 *   - 「到期」的过滤与排序 —— **直接解释 `scheduling.ts` 里的规则对象**，
 *     而不是另写一套 if。这样 `buildDueSourcesWhere` 一旦被改坏，
 *     替身会跟着变，单元测试才可能发现；
 *   - 未出现的补丁键不改动、`config: null` 表示清空。
 *
 * 真实 SQL 的等价断言由 `sources-db.integration.spec.ts` 在真 MySQL 上再跑一遍。
 */

import { SourceKind, SourceTier, type SourceType } from '@signal/contracts';
import type {
  CreateSourceInput,
  SourceListQuery,
  SourceListResult,
  SourceRecord,
  SourceRepository,
  UpdateSourceInput,
} from '../../src/modules/sources/repository';
import {
  buildDueSourcesWhere,
  type DueSourcesFilter,
} from '../../src/modules/sources/scheduling';
import type { EnqueuedSourceFetch, SourceFetchEnqueuer } from '../../src/modules/sources/source-enqueuer';
import { JobId, JobName, QueueName } from '@signal/contracts';
import { fetchWindow, type CollectorFetchSourcePayload } from '../../src/modules/sources/source-enqueuer';
import type { SourceClock } from '../../src/modules/sources/clock';
import type { SourceTestResult, SourceTester } from '../../src/modules/sources/source-tester';

/** 可手动推进的时钟。 */
export class FakeSourceClock implements SourceClock {
  private current: Date;

  constructor(start: Date = new Date('2026-09-24T00:00:00.000Z')) {
    this.current = start;
  }

  now(): Date {
    return new Date(this.current.getTime());
  }

  advanceMs(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }

  advanceSeconds(seconds: number): void {
    this.advanceMs(seconds * 1_000);
  }

  set(at: Date): void {
    this.current = new Date(at.getTime());
  }
}

/** 复刻 `sources.slug` 唯一约束的错误形态。 */
function uniqueViolation(): Error {
  const error = new Error('Unique constraint failed on the fields: (`slug`)');
  (error as { code?: string }).code = 'P2002';
  return error;
}

/** 解释 `buildDueSourcesWhere()` 产出的规则对象（而不是另写一套判定）。 */
function matchesDueFilter(row: SourceRecord, filter: DueSourcesFilter): boolean {
  if (row.enabled !== filter.enabled) return false;
  for (const clause of filter.OR) {
    if (clause.nextFetchAt === null) {
      if (row.nextFetchAt === null) return true;
      continue;
    }
    const limit = clause.nextFetchAt.lte;
    if (row.nextFetchAt !== null && row.nextFetchAt.getTime() <= limit.getTime()) return true;
  }
  return false;
}

/** 复刻 `DUE_SOURCES_ORDER_BY`：先 `nextFetchAt` 升序，再 `id` 升序。 */
function compareDue(a: SourceRecord, b: SourceRecord): number {
  // MySQL 在 ASC 下把 NULL 排在最前，这里保持一致。
  const left = a.nextFetchAt === null ? Number.NEGATIVE_INFINITY : a.nextFetchAt.getTime();
  const right = b.nextFetchAt === null ? Number.NEGATIVE_INFINITY : b.nextFetchAt.getTime();
  if (left !== right) return left < right ? -1 : 1;
  const leftId = Number(a.id);
  const rightId = Number(b.id);
  if (leftId !== rightId) return leftId < rightId ? -1 : 1;
  return 0;
}

export class InMemorySourceRepository implements SourceRepository {
  readonly rows = new Map<string, SourceRecord>();
  private nextId = 1;

  /** 直接插入一条记录（准备测试数据用）。 */
  insert(overrides: Partial<SourceRecord> = {}): SourceRecord {
    const id = String(overrides.id ?? this.nextId++);
    const record: SourceRecord = {
      id,
      name: `Source ${id}`,
      slug: `source-${id}`,
      type: 'RSS' as SourceType,
      kind: SourceKind.OFFICIAL,
      tier: SourceTier.B,
      official: false,
      baseUrl: null,
      feedUrl: null,
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
    this.rows.set(id, record);
    return record;
  }

  async create(input: CreateSourceInput): Promise<SourceRecord> {
    if (await this.findBySlug(input.slug)) throw uniqueViolation();
    return this.insert({ ...input });
  }

  async findById(id: string): Promise<SourceRecord | null> {
    return this.rows.get(id) ?? null;
  }

  async findBySlug(slug: string): Promise<SourceRecord | null> {
    for (const row of this.rows.values()) if (row.slug === slug) return row;
    return null;
  }

  async list(query: SourceListQuery): Promise<SourceListResult> {
    const all = [...this.rows.values()]
      .filter((row) => (query.type === undefined ? true : row.type === query.type))
      .filter((row) => (query.kind === undefined ? true : row.kind === query.kind))
      .filter((row) => (query.tier === undefined ? true : row.tier === query.tier))
      .filter((row) => (query.enabled === undefined ? true : row.enabled === query.enabled))
      .filter((row) =>
        query.q === undefined
          ? true
          : row.name.toLowerCase().includes(query.q.toLowerCase()) ||
            row.slug.toLowerCase().includes(query.q.toLowerCase()),
      )
      .sort((a, b) => Number(b.id) - Number(a.id));

    const start = (query.page - 1) * query.pageSize;
    return { items: all.slice(start, start + query.pageSize), total: all.length };
  }

  async update(id: string, patch: UpdateSourceInput): Promise<SourceRecord> {
    const existing = this.rows.get(id);
    if (existing === undefined) throw new Error(`P2025: source ${id} not found`);
    if (patch.slug !== undefined && patch.slug !== existing.slug) {
      const clash = await this.findBySlug(patch.slug);
      if (clash !== null && clash.id !== id) throw uniqueViolation();
    }

    // 未出现的键不改动；`null` 是有意义的值，照写。
    const next: SourceRecord = { ...existing };
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      (next as unknown as Record<string, unknown>)[key] = value;
    }
    next.updatedAt = new Date();
    this.rows.set(id, next);
    return next;
  }

  async setEnabled(id: string, enabled: boolean, nextFetchAt: Date | null): Promise<SourceRecord> {
    const existing = this.rows.get(id);
    if (existing === undefined) throw new Error(`P2025: source ${id} not found`);
    // 与真实实现一致：`nextFetchAt` 为 null 时不覆盖原有值。
    const updated: SourceRecord = {
      ...existing,
      enabled,
      ...(nextFetchAt === null ? {} : { nextFetchAt }),
    };
    this.rows.set(id, updated);
    return updated;
  }

  async findDueSources(now: Date, limit: number): Promise<SourceRecord[]> {
    const filter = buildDueSourcesWhere(now);
    return [...this.rows.values()]
      .filter((row) => matchesDueFilter(row, filter))
      .sort(compareDue)
      .slice(0, limit);
  }
}

/** 记录被测试的调用，但不做任何网络请求。 */
export class FakeSourceTester implements SourceTester {
  readonly calls: string[] = [];
  result: SourceTestResult = {
    ok: true,
    type: 'RSS' as SourceType,
    target: 'https://example.com/feed',
    latencyMs: 1,
    message: 'ok',
  };

  async test(source: SourceRecord): Promise<SourceTestResult> {
    this.calls.push(source.id);
    return this.result;
  }
}

/** 记录入队调用，但不连 Redis。 */
export class FakeSourceFetchEnqueuer implements SourceFetchEnqueuer {
  readonly jobs: { sourceId: string; at: Date; payload: CollectorFetchSourcePayload }[] = [];
  closed = false;

  async enqueueFetchNow(sourceId: string, at: Date): Promise<EnqueuedSourceFetch> {
    const window = fetchWindow(at);
    this.jobs.push({
      sourceId,
      at,
      payload: { sourceId, trigger: 'manual', requestedAt: at.toISOString() },
    });
    return {
      queue: QueueName.COLLECTOR,
      jobName: JobName.COLLECTOR_FETCH_SOURCE,
      jobId: JobId.collectorFetchSource(sourceId, window),
      window,
    };
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}
