/**
 * `CollectorService` 编排层测试。
 *
 * 这里验证的是 `tasks/agent-04-collectors.md` 的核心要求：
 * **幂等、失败隔离、状态推进、以及「抓完之后自己推进 next_fetch_at」**。
 *
 * 跑的是真实 service 代码，只把 MySQL / Redis / 适配器换成替身。
 */

import { describe, expect, it } from 'vitest';
import { SourceType } from '@signal/contracts';
import { createLogger } from '@signal/logger';
import { createMemoryStream } from '@signal/test-utils';
import { CollectorService, type CollectOutcome } from '../src/jobs/collectors/collector.service';
import type { AdapterRegistry } from '../src/jobs/collectors/adapters';
import type { CollectorSource } from '../src/jobs/collectors/ports';
import {
  FakeClock,
  InMemoryJobRunRepository,
  InMemoryRawItemRepository,
  InMemorySourceFetchQueue,
  InMemorySourceLock,
  InMemorySourceRepository,
  StubAdapter,
  batchOf,
  createItem,
  createPayload,
  createSource,
} from './support/collector-fakes';

const START = new Date('2026-09-24T02:00:00.000Z');

function buildService(options: {
  sources?: CollectorSource[];
  adapter: StubAdapter;
  rawItems?: InMemoryRawItemRepository;
  jobRuns?: InMemoryJobRunRepository;
  lock?: InMemorySourceLock;
  clock?: FakeClock;
}) {
  const sources = new InMemorySourceRepository(
    options.sources ?? [createSource({ id: '1', type: SourceType.RSS })],
  );
  const rawItems = options.rawItems ?? new InMemoryRawItemRepository();
  const jobRuns = options.jobRuns ?? new InMemoryJobRunRepository();
  const lock = options.lock ?? new InMemorySourceLock();
  const clock = options.clock ?? new FakeClock(START);
  const logStream = createMemoryStream();

  // 六个类型都填成同一个 stub —— `Record<SourceType, …>` 少一个键就编译不过，
  // 这正是我们想要的（见 adapters/index.ts 的说明）。
  const registry = Object.fromEntries(
    Object.values(SourceType).map((type) => [type, options.adapter]),
  ) as unknown as AdapterRegistry;

  const service = new CollectorService(
    {
      nodeEnv: 'test',
      fetchTimeoutMs: 5_000,
      fetchMaxBytes: 2_097_152,
      xApiBearerToken: null,
      githubToken: null,
      redisUrl: 'redis://127.0.0.1:6390',
      schedulerIntervalMs: 60_000,
    },
    clock,
    sources,
    rawItems,
    jobRuns,
    lock,
    registry,
    createLogger({ service: 'collector-test', level: 'info', destination: logStream }),
  );

  return { service, sources, rawItems, jobRuns, lock, clock, logStream };
}

const RUN = { attempt: 1, isFinalAttempt: false };

describe('CollectorService — 正常路径', () => {
  it('采集 → 去重 → 落库 → 推进状态 → 记 JobRun', async () => {
    const adapter = new StubAdapter(async () => batchOf([createItem()]));
    const { service, sources, rawItems, jobRuns } = buildService({ adapter });

    const outcome = await service.runCollect(createPayload(), RUN);

    expect(outcome).toEqual({
      status: 'succeeded',
      sourceId: '1',
      collected: 1,
      stored: 1,
      skippedByAdapter: 0,
      duplicates: 0,
    });

    const stored = rawItems.inserted[0]!;
    expect(stored.titleRaw).toBe('示例标题');
    expect(stored.status).toBe('FETCHED');
    expect(stored.canonicalUrlHash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.contentHash).toMatch(/^[0-9a-f]{64}$/);

    // next_fetch_at 必须以**本轮开始时刻**为基准推进。
    const recorded = sources.outcomes[0]!;
    expect(recorded.outcome.errorCode).toBeNull();
    expect(recorded.outcome.nextFetchAt.toISOString()).toBe('2026-09-24T02:30:00.000Z'); // +1800s
    expect(jobRuns.runs[0]!.finalled).toEqual({
      status: 'SUCCEEDED',
      errorCode: null,
      attempts: 1,
    });
  });

  it('状态推进用**本轮开始时刻**而不是结束时刻（否则周期会随抓取耗时退化）', async () => {
    const adapter = new StubAdapter(async () => batchOf([createItem()]));
    const clock = new FakeClock(START);
    const { service, sources } = buildService({ adapter, clock });

    // 模拟一次很慢的抓取：3 秒。结束时已经过了 3 秒。
    const slowAdapter = new StubAdapter(async () => {
      clock.advance(3_000);
      return batchOf([createItem()]);
    });
    const built = buildService({ adapter: slowAdapter, clock });
    await built.service.runCollect(createPayload(), RUN);

    expect(built.sources.outcomes[0]!.outcome.nextFetchAt.toISOString()).toBe(
      '2026-09-24T02:30:00.000Z',
    );
    // 对照：如果以结束时刻为基准，这里会变成 02:30:03。
    expect(sources.outcomes).toHaveLength(0);
    expect(service).toBeDefined();
  });

  it('游标来自仓储（从已落库的事实推导，不额外存状态）', async () => {
    const adapter = new StubAdapter(async () => batchOf([]));
    const { service, sources } = buildService({ adapter });

    await service.runCollect(createPayload(), RUN);
    expect(sources.cursorCalls).toEqual(['1']);
  });

  it('适配器的 warning 会进日志（不致命但不能静默）', async () => {
    const adapter = new StubAdapter(async () => ({
      ...batchOf([createItem()]),
      warnings: ['feed has an unescaped character'],
    }));
    const { service, logStream } = buildService({ adapter });

    await service.runCollect(createPayload(), RUN);
    expect(
      logStream
        .records()
        .map((record) => JSON.stringify(record))
        .join('\n'),
    ).toContain('unescaped');
  });
});

describe('CollectorService — 幂等', () => {
  it('同一批里重复的条目只写一次（批内去重）', async () => {
    const duplicates = [
      createItem({ externalId: 'same-id' }),
      // 不同 externalId、同一 canonicalUrl —— 也必须判重。
      createItem({ externalId: 'other-id', canonicalUrl: 'https://example.com/post-1' }),
    ];
    const adapter = new StubAdapter(async () => batchOf(duplicates));
    const { service, rawItems } = buildService({ adapter });

    const outcome = await service.runCollect(createPayload(), RUN);

    expect(rawItems.inserted).toHaveLength(1);
    expect(outcome).toMatchObject({ stored: 1, duplicates: 1 });
  });

  it('**抓两次不重复**：库里已有的条目第二次不再写入', async () => {
    const adapter = new StubAdapter(async () => batchOf([createItem()]));
    const rawItems = new InMemoryRawItemRepository();
    const { service } = buildService({ adapter, rawItems });

    const first = await service.runCollect(createPayload(), RUN);
    expect(first).toMatchObject({ stored: 1, duplicates: 0 });

    // 第二次：仓储里已经有这条（externalId 与 canonicalUrlHash 都命中）。
    const seeded = new InMemoryRawItemRepository();
    const inserted = rawItems.inserted[0]!;
    seeded.seedExisting({
      externalIds: [inserted.externalId!],
      canonicalUrlHashes: [inserted.canonicalUrlHash],
    });
    const second = buildService({ adapter, rawItems: seeded });
    const outcome = await second.service.runCollect(createPayload(), RUN);

    expect(outcome).toMatchObject({ collected: 1, stored: 0, duplicates: 1 });
    expect(seeded.inserted).toHaveLength(0);
  });

  it('externalId 相同但 URL 不同时也算重复（source + externalId 是第 1 条幂等键）', async () => {
    const adapter = new StubAdapter(async () => batchOf([createItem()]));
    const rawItems = new InMemoryRawItemRepository();
    rawItems.seedExisting({ externalIds: ['item-1'] });
    const { service } = buildService({ adapter, rawItems });

    expect(await service.runCollect(createPayload(), RUN)).toMatchObject({ stored: 0 });
  });

  it('externalId 为 null 时靠 canonicalUrlHash 去重', async () => {
    const adapter = new StubAdapter(async () =>
      batchOf([createItem({ externalId: null, canonicalUrl: 'https://example.com/no-id' })]),
    );
    const rawItems = new InMemoryRawItemRepository();
    const first = buildService({ adapter, rawItems });
    await first.service.runCollect(createPayload(), RUN);
    expect(rawItems.inserted).toHaveLength(1);

    const second = buildService({ adapter, rawItems });
    const outcome = await second.service.runCollect(createPayload(), RUN);
    expect(outcome).toMatchObject({ stored: 0, duplicates: 1 });
  });

  it('**payload 里出现 Source 元数据就当场失败，不写库**', async () => {
    const adapter = new StubAdapter(async () =>
      batchOf([createItem({ payload: { feedFormat: 'rss', tier: 'S' } })]),
    );
    const { service, rawItems, sources } = buildService({ adapter });

    const outcome = await service.runCollect(createPayload(), RUN);

    expect(outcome.status).toBe('failed');
    expect(rawItems.inserted).toHaveLength(0);
    // 而且这一轮被记为可重试的失败（配置问题，但代码层的守卫触发时
    // 我们按运行期错误处理，让它显式可见）。
    expect(sources.outcomes).toHaveLength(1);
  });
});

describe('CollectorService — 失败与隔离', () => {
  it('适配器抛错 → failed 结论 + 成功/失败状态分别推进', async () => {
    const adapter = new StubAdapter(async () => {
      throw new Error('upstream exploded');
    });
    const { service, sources, jobRuns } = buildService({ adapter });

    const outcome = await service.runCollect(createPayload(), RUN);

    expect(outcome.status).toBe('failed');
    const recorded = sources.outcomes[0]!;
    expect(recorded.outcome.errorCode).toBe('SOURCE_FETCH_FAILED');
    // 失败也推进 next_fetch_at —— 否则这个来源会被每一轮反复取出来。
    expect(recorded.outcome.nextFetchAt.toISOString()).toBe('2026-09-24T02:30:00.000Z');
    expect(jobRuns.runs[0]!.finalled).toMatchObject({ status: 'FAILED' });
  });

  it('最后一次尝试失败 → JobRun 记 DEAD（docs/13 的 dead-letter）', async () => {
    const adapter = new StubAdapter(async () => {
      throw new Error('still broken');
    });
    const { service, jobRuns } = buildService({ adapter });

    await service.runCollect(createPayload(), { attempt: 3, isFinalAttempt: true });
    expect(jobRuns.runs[0]!.finalled).toMatchObject({ status: 'DEAD', attempts: 3 });
  });

  it('**单 Source 失败不影响其它来源**（一个来源 = 一个任务，天然隔离）', async () => {
    const sourcesList = [
      createSource({ id: '1', slug: 'bad', type: SourceType.RSS }),
      createSource({ id: '2', slug: 'good', type: SourceType.RSS }),
    ];
    const adapter = new StubAdapter(async () => batchOf([createItem({ sourceId: '2' })]));
    const { service, sources } = buildService({ adapter, sources: sourcesList });

    const [first, second] = await Promise.all([
      service.runCollect(createPayload({ sourceId: '1' }), RUN),
      service.runCollect(createPayload({ sourceId: '2' }), RUN),
    ]);

    // 两个都成功（stub 不区分来源），关键是**两者互不影响**：
    // 分别记录了各自的状态推进，没有互相覆盖。
    expect(first.status).toBe('succeeded');
    expect(second.status).toBe('succeeded');
    expect(sources.outcomes.map((entry) => entry.sourceId).sort()).toEqual(['1', '2']);
  });

  it('失败一个、成功一个时，成功的那个仍然落库', async () => {
    const sourcesList = [
      createSource({ id: '1', slug: 'bad', type: SourceType.RSS, config: {} }),
      createSource({ id: '2', slug: 'good', type: SourceType.RSS }),
    ];
    let call = 0;
    const adapter = new StubAdapter(async () => {
      call += 1;
      if (call === 1) throw new Error('first source is broken');
      return batchOf([createItem({ sourceId: '2' })]);
    });
    const { service, rawItems, sources } = buildService({ adapter, sources: sourcesList });

    const failed = await service.runCollect(createPayload({ sourceId: '1' }), RUN);
    const succeeded = await service.runCollect(createPayload({ sourceId: '2' }), RUN);

    expect(failed.status).toBe('failed');
    expect(succeeded.status).toBe('succeeded');
    expect(rawItems.inserted).toHaveLength(1);
    expect(sources.outcomes.map((entry) => entry.outcome.errorCode)).toEqual([
      'SOURCE_FETCH_FAILED',
      null,
    ]);
  });

  it('不存在的来源 → skipped（竞态，不是失败，不写 5xx 噪声）', async () => {
    const adapter = new StubAdapter(async () => batchOf([]));
    const { service, sources } = buildService({ adapter });

    const outcome = await service.runCollect(createPayload({ sourceId: '999' }), RUN);

    expect(outcome).toEqual({ status: 'skipped', sourceId: '999', reason: 'not-found' });
    expect(sources.outcomes).toHaveLength(0);
  });

  it('**调度路径不采已停用的来源**（docs/06：停用后停止产生新抓取任务）', async () => {
    const adapter = new StubAdapter(async () => batchOf([createItem()]));
    const disabled = createSource({ id: '1', enabled: false, type: SourceType.RSS });
    const { service, rawItems } = buildService({ adapter, sources: [disabled] });

    const outcome = await service.runCollect(createPayload({ trigger: 'schedule' }), RUN);

    expect(outcome).toEqual({ status: 'skipped', sourceId: '1', reason: 'disabled' });
    expect(rawItems.inserted).toHaveLength(0);
  });

  it('手动触发（manual）**可以**采已停用的来源（disable 的语义是停止调度）', async () => {
    const adapter = new StubAdapter(async () => batchOf([createItem()]));
    const disabled = createSource({ id: '1', enabled: false, type: SourceType.RSS });
    const { service, rawItems } = buildService({ adapter, sources: [disabled] });

    const outcome = await service.runCollect(createPayload({ trigger: 'manual' }), RUN);

    expect(outcome.status).toBe('succeeded');
    expect(rawItems.inserted).toHaveLength(1);
  });
});

describe('CollectorService — 锁', () => {
  it('拿不到锁 → skipped（不等待、不重试）', async () => {
    const adapter = new StubAdapter(async () => batchOf([createItem()]));
    const lock = new InMemorySourceLock();
    // 预先占用同一把锁 —— `docs/06` 的 key 是 `source-fetch:{sourceId}`。
    await lock.acquire('source-fetch:1', 60_000);
    const { service, rawItems, jobRuns } = buildService({ adapter, lock });

    const outcome = await service.runCollect(createPayload(), RUN);

    expect(outcome).toEqual({ status: 'skipped', sourceId: '1', reason: 'locked' });
    expect(rawItems.inserted).toHaveLength(0);
    // 跳过不写 JobRun：它既不是成功也不是失败。
    expect(jobRuns.runs).toHaveLength(0);
  });

  it('正常完成后锁被释放（否则该来源会被卡到 TTL 到期）', async () => {
    const adapter = new StubAdapter(async () => batchOf([createItem()]));
    const lock = new InMemorySourceLock();
    const { service } = buildService({ adapter, lock });

    await service.runCollect(createPayload(), RUN);
    expect(lock.held.has('source-fetch:1')).toBe(false);
  });

  it('失败路径也释放锁（异常出口同样要释放）', async () => {
    const adapter = new StubAdapter(async () => {
      throw new Error('boom');
    });
    const lock = new InMemorySourceLock();
    const { service } = buildService({ adapter, lock });

    await service.runCollect(createPayload(), RUN);
    expect(lock.held.has('source-fetch:1')).toBe(false);
  });

  it('Redis 不可用 → 可重试的失败，且**不去写库**（故障时不要放大）', async () => {
    const adapter = new StubAdapter(async () => batchOf([createItem()]));
    const lock = new InMemorySourceLock();
    lock.failNext = true;
    const { service, sources, jobRuns } = buildService({ adapter, lock });

    const outcome = await service.runCollect(createPayload(), RUN);

    expect(outcome).toMatchObject({ status: 'failed', retryable: true });
    expect(sources.outcomes).toHaveLength(0);
    expect(jobRuns.runs).toHaveLength(0);
  });
});

describe('CollectorService — 结论的形状', () => {
  it('所有结论都是显式对象，**不抛异常**（由 BullMQ 处理器决定重试语义）', async () => {
    const cases: (() => Promise<CollectOutcome>)[] = [];

    const okAdapter = new StubAdapter(async () => batchOf([]));
    cases.push(() => buildService({ adapter: okAdapter }).service.runCollect(createPayload(), RUN));

    const failAdapter = new StubAdapter(async () => {
      throw new Error('x');
    });
    cases.push(() =>
      buildService({ adapter: failAdapter }).service.runCollect(createPayload(), RUN),
    );

    for (const run of cases) {
      // 任何一个抛出都会让这个 Promise.all 失败，从而让用例变红。
      await expect(run()).resolves.toBeDefined();
    }
  });

  it('未注册的 SourceType 收敛成**失败结论**并带上类型名（不是堆栈结束）', async () => {
    const adapter = new StubAdapter(async () => batchOf([]));
    const empty = {} as AdapterRegistry;
    const built = buildService({ adapter });
    const service = new CollectorService(
      {
        nodeEnv: 'test',
        fetchTimeoutMs: 5_000,
        fetchMaxBytes: 2_097_152,
        xApiBearerToken: null,
        githubToken: null,
        redisUrl: 'redis://127.0.0.1:6390',
        schedulerIntervalMs: 60_000,
      },
      built.clock,
      built.sources,
      built.rawItems,
      built.jobRuns,
      built.lock,
      empty,
      createLogger({ service: 'test', level: 'silent', destination: createMemoryStream() }),
    );

    const outcome = await service.runCollect(createPayload(), RUN);
    expect(outcome).toMatchObject({ status: 'failed' });
    // 消息里必须带上具体的 SourceType 取值 —— 否则后台只看到
    // 「采集失败」，不知道是哪种类型没人处理。
    expect((outcome as { message: string }).message).toMatch(
      /No collector adapter is registered for SourceType RSS/,
    );
  });
});

describe('队列替身自检', () => {
  it('InMemorySourceFetchQueue 生成与契约一致的 JobId', async () => {
    const queue = new InMemorySourceFetchQueue();
    const result = await queue.enqueue(
      { sourceId: '42', trigger: 'schedule', requestedAt: START.toISOString() },
      START,
    );
    expect(result.jobId).toBe(`collector:42:${Math.floor(START.getTime() / 60_000)}`);
    expect(result.queue).toBe('collector');
    expect(result.jobName).toBe('collector.fetch-source');
  });
});
