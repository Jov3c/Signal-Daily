/**
 * Collector 集成测试 —— **真实 Redis + 真实 BullMQ**。
 *
 * 运行：
 *   REDIS_URL=redis://127.0.0.1:6390 pnpm --filter @signal/worker test:integration
 *
 * ── 只有真 Redis 才能验的几件事 ─────────────────────────────────────
 *   1. 任务**真的进了 `collector` 队列**，而不是我写了个空壳返回 `{queued:true}`；
 *   2. JobId 幂等**真的由 BullMQ 实现**（同一窗口重复入队只留一个任务）——
 *      这是 `docs/13` 的语义，替身复刻不了；
 *   3. 重试策略真的被写进了任务选项（`attempts` / `backoff`），
 *      而 `COLLECTOR_RETRY.backoff.delayMs` → BullMQ 的 `delay` 这个字段名转换
 *      写错的表现是「退避变成默认 0」，不报错；
 *   4. **队列的生产端与消费端真的对得上**：调度器放进去的载荷，
 *      `CollectorWorker` 能解析并跑完整条链路；
 *   5. `RedisSourceLock` 的互斥与「只释放自己的锁」在真 Redis 上成立
 *      （Lua compare-and-delete 是原子的）。
 *
 * 连不上 Redis 就直接失败，绝不静默跳过。
 */

import { randomBytes } from 'node:crypto';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { Queue, Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { JobId, JobName, QueueName } from '@signal/contracts';
import { createLogger } from '@signal/logger';
import { createMemoryStream } from '@signal/test-utils';
import { BullSourceFetchQueue, fetchWindow } from '../src/jobs/collectors/source-queue';
import { CollectorWorker } from '../src/jobs/collectors/collector.worker';
import type { CollectOutcome, CollectorService } from '../src/jobs/collectors/collector.service';
import {
  RedisSourceLock,
  collectorLockTtlMs,
  SCHEDULER_LOCK_TTL_MS,
} from '../src/jobs/collectors/source-lock';
import type { CollectorFetchSourcePayload } from '../src/jobs/collectors/ports';
import { redisConnectionOptions } from '../src/jobs/collectors/redis';
import { batchOf, createItem, InMemorySourceLock } from './support/collector-fakes';

const REDIS_URL = process.env['REDIS_URL'] ?? 'redis://127.0.0.1:6390';

const config = {
  nodeEnv: 'test' as const,
  fetchTimeoutMs: 10_000,
  fetchMaxBytes: 2_097_152,
  xApiBearerToken: null,
  githubToken: null,
  redisUrl: REDIS_URL,
  schedulerIntervalMs: 60_000,
};

const silentLogger = createLogger({
  service: 'queue-it',
  level: 'silent',
  destination: createMemoryStream(),
});

/**
 * ⚠ **必须是测试自己的队列名，不能是生产队列名。**
 *
 * 原先这里写的是 `QueueName.COLLECTOR`（就是生产的 `collector`），
 * 然后在 `beforeAll` / `afterAll` 里 `obliterate({force:true})` ——
 * 那会**清空共享 Redis 上真实 worker 正在消费的生产队列**，
 * 表现为「任务莫名消失」。同一个 Redis 上跑着 dist 探针时已经实测到
 * 相互污染（探针日志里出现集成测试的 sourceId）。
 *
 * 契约里的队列名仍然由生产代码使用（`BullSourceFetchQueue` 的默认参数）；
 * 这里只是把测试实例指到一个一次性的名字上。
 */
const TEST_QUEUE = `${QueueName.COLLECTOR}-it-${randomBytes(4).toString('hex')}`;

let inspectQueue: Queue<CollectorFetchSourcePayload>;

beforeAll(async () => {
  // ⚠ 先做一次**明确的**连通性探测。
  //
  // 原来只 `await waitUntilReady()`：Redis 不可用时它既不解析也不抛错，
  // 结果是 `Hook timed out in 60000ms` —— 19 个用例全部 **skip**、
  // 报错信息里一个字都没提 Redis，排查方向会被引到「测试超时」上，
  // 而且 beforeAll + afterAll 各挂满 60 秒。
  // 文件头声称「连不上就直接失败，绝不静默跳过」，而实际行为正好相反。
  // 同目录的 `collectors-db.integration.spec.ts` 用的是
  // `await prisma.$queryRaw\`SELECT 1\``，这里对齐同一种做法。
  const probe = new Redis(REDIS_URL);
  try {
    await probe.ping();
  } catch (error) {
    throw new Error(
      `Redis 不可用（${REDIS_URL}）：本套件需要真实 Redis。` +
        '请先启动 redis-server，或设置 REDIS_URL 指向一个可用实例。',
      { cause: error },
    );
  } finally {
    await probe.quit().catch(() => undefined);
  }

  inspectQueue = new Queue<CollectorFetchSourcePayload>(TEST_QUEUE, {
    connection: redisConnectionOptions(REDIS_URL),
  });
  await inspectQueue.waitUntilReady();
});

afterAll(async () => {
  await inspectQueue.obliterate({ force: true }).catch(() => undefined);
  await inspectQueue.close();
});

/** 轮询等待某个条件成立，超时即失败。 */
async function waitFor<T>(
  probe: () => Promise<T | null>,
  timeoutMs = 10_000,
  intervalMs = 50,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== null) return value;
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/* ================================================================== */
/* 入队                                                                */
/* ================================================================== */

describe('BullSourceFetchQueue —— 真 Redis 上的入队', () => {
  it('任务**真的**进了 collector 队列，队列名 / Job 名 / 载荷逐字等于契约', async () => {
    const queue = new BullSourceFetchQueue(config, TEST_QUEUE);
    const at = new Date();
    const result = await queue.enqueue(
      { sourceId: '9001', trigger: 'schedule', requestedAt: at.toISOString() },
      at,
    );

    expect(result.queue).toBe('collector');
    expect(result.jobName).toBe('collector.fetch-source');
    expect(result.window).toBe(fetchWindow(at));

    const job = await waitFor(() => inspectQueue.getJob(result.jobId));
    expect(job).toBeDefined();
    expect(job!.name).toBe(JobName.COLLECTOR_FETCH_SOURCE);
    expect(job!.data).toEqual({
      sourceId: '9001',
      trigger: 'schedule',
      requestedAt: at.toISOString(),
    });

    await queue.close();
  });

  it('**不传队列名时默认就是契约里的 `collector`**（改错会让采集整体静默停止）', async () => {
    // ⚠ 生产路径**不传**第二个参数，所以这个默认值就是实际使用的队列名。
    // `apps/api` 也往同名队列入队 —— 两边不一致时采集会整体静默停止，
    // 而没有任何测试会失败（反证：改成 'collector-typo' 曾让 202+46 项全绿）。
    const queue = new BullSourceFetchQueue(config);
    expect(queue.queueName).toBe(QueueName.COLLECTOR);
    expect(queue.queueName).toBe('collector');
    await queue.close();
  });

  it('JobId 格式是 `collector:{sourceId}:{window}`（契约的 JobId builder）', async () => {
    const queue = new BullSourceFetchQueue(config, TEST_QUEUE);
    const at = new Date('2026-09-24T02:00:00.000Z');
    const result = await queue.enqueue(
      { sourceId: '9002', trigger: 'manual', requestedAt: at.toISOString() },
      at,
    );

    expect(result.jobId).toBe(JobId.collectorFetchSource('9002', fetchWindow(at)));
    expect(result.jobId).toBe(`collector:9002:${Math.floor(at.getTime() / 60_000)}`);
    await queue.close();
  });

  it('**同一窗口重复入队只留一个任务**（幂等由 BullMQ 保证，不是替身）', async () => {
    const queue = new BullSourceFetchQueue(config, TEST_QUEUE);
    const at = new Date();
    const first = await queue.enqueue(
      { sourceId: '9003', trigger: 'schedule', requestedAt: at.toISOString() },
      at,
    );
    const second = await queue.enqueue(
      { sourceId: '9003', trigger: 'schedule', requestedAt: at.toISOString() },
      at,
    );

    expect(second.jobId).toBe(first.jobId);
    const counts = await inspectQueue.getJobCounts('waiting', 'delayed', 'active');
    const jobs = await inspectQueue.getJobs(['waiting', 'delayed', 'active']);
    const matching = jobs.filter((job) => job.id === first.jobId);
    expect(matching).toHaveLength(1);
    expect(counts).toBeDefined();

    await queue.close();
  });

  it('不同窗口产生不同 JobId（下一分钟可以再抓一次）', async () => {
    const queue = new BullSourceFetchQueue(config, TEST_QUEUE);
    const at = new Date();
    const later = new Date(at.getTime() + 60_000);
    const first = await queue.enqueue(
      { sourceId: '9004', trigger: 'schedule', requestedAt: at.toISOString() },
      at,
    );
    const second = await queue.enqueue(
      { sourceId: '9004', trigger: 'schedule', requestedAt: later.toISOString() },
      later,
    );

    expect(second.jobId).not.toBe(first.jobId);
    await queue.close();
  });

  it('重试策略真的写进了任务选项（`backoff.delay` 而不是契约里的 `delayMs`）', async () => {
    const queue = new BullSourceFetchQueue(config, TEST_QUEUE);
    const at = new Date();
    const result = await queue.enqueue(
      { sourceId: '9005', trigger: 'schedule', requestedAt: at.toISOString() },
      at,
    );

    const job = await waitFor(() => inspectQueue.getJob(result.jobId));
    // `docs/13`：Collector 3 次指数退避。契约里字段叫 `backoff.delayMs`，
    // BullMQ 叫 `backoff.delay` —— 转换写错的表现是「退避变成默认 0」，
    // 不报错，只是重试变得很密。
    expect(job!.opts.attempts).toBe(3);
    expect(job!.opts.backoff).toEqual({ type: 'exponential', delay: 5_000 });

    await queue.close();
  });

  it('Redis 不可用时**抛错**（fail-closed，绝不返回「已入队」）', async () => {
    const broken = new BullSourceFetchQueue(
      { ...config, redisUrl: 'redis://127.0.0.1:6399' },
      TEST_QUEUE,
    );
    const at = new Date();

    await expect(
      broken.enqueue({ sourceId: '9006', trigger: 'schedule', requestedAt: at.toISOString() }, at),
    ).rejects.toThrow();
    await broken.close().catch(() => undefined);
  }, 20_000);
});

/* ================================================================== */
/* 端到端：生产端 → 消费端                                             */
/* ================================================================== */

describe('端到端：调度器入队 → Worker 消费', () => {
  it('**调度器放进去的载荷，Worker 能解析并跑完整个采集链路**', async () => {
    const runs: { payload: CollectorFetchSourcePayload; attempt: number }[] = [];
    const fakeService = {
      async runCollect(
        payload: CollectorFetchSourcePayload,
        run: { attempt: number },
      ): Promise<CollectOutcome> {
        runs.push({ payload, attempt: run.attempt });
        return {
          status: 'succeeded',
          sourceId: payload.sourceId,
          collected: 1,
          stored: 1,
          skippedByAdapter: 0,
          duplicates: 0,
        };
      },
    } as unknown as CollectorService;

    const collectorWorker = new CollectorWorker(config, fakeService, silentLogger);
    const runWorker = new Worker<CollectorFetchSourcePayload>(
      TEST_QUEUE,
      (job: Job<CollectorFetchSourcePayload>) => collectorWorker.handle(job),
      { connection: redisConnectionOptions(REDIS_URL), concurrency: 1 },
    );

    const queue = new BullSourceFetchQueue(config, TEST_QUEUE);
    const at = new Date();
    await queue.enqueue(
      { sourceId: '9100', trigger: 'schedule', requestedAt: at.toISOString() },
      at,
    );

    // ⚠ 按 sourceId 过滤：本文件的用例共用同一个真实 `collector` 队列，
    // 前面用例残留的任务会被这个 Worker 一并消费掉（真队列就是这样）。
    // 直接断言 runs.length === 1 会数到别的任务 —— 那是测试的错，不是实现的。
    await waitFor(
      async () => (runs.some((entry) => entry.payload.sourceId === '9100') ? true : null),
      15_000,
    );

    const mine = runs.filter((entry) => entry.payload.sourceId === '9100');
    expect(mine).toHaveLength(1);
    expect(mine[0]!.payload).toEqual({
      sourceId: '9100',
      trigger: 'schedule',
      requestedAt: at.toISOString(),
    });
    expect(mine[0]!.attempt).toBe(1);

    await runWorker.close();
    await queue.close();
  }, 30_000);

  it('**跨 Agent 的载荷契约**：Agent 03 的 `fetch-now` 载荷形状能被本 Worker 解析', async () => {
    // Agent 03 的 `apps/api/src/modules/sources/source-enqueuer.ts` 放的是
    // `{sourceId, trigger: 'manual', requestedAt}`，并提交了 CCR 第 2 项
    // 请求固化这个形状。这里用**它文档里写的字面形状**喂进来，
    // 确认消费端不需要任何额外约定。
    const agent03Payload = {
      sourceId: '29836860',
      trigger: 'manual',
      requestedAt: '2026-09-24T01:00:56.616Z',
    };

    const runs: CollectorFetchSourcePayload[] = [];
    const fakeService = {
      async runCollect(payload: CollectorFetchSourcePayload): Promise<CollectOutcome> {
        runs.push(payload);
        return {
          status: 'skipped',
          sourceId: payload.sourceId,
          reason: 'not-found',
        };
      },
    } as unknown as CollectorService;

    const collectorWorker = new CollectorWorker(config, fakeService, silentLogger);
    const runWorker = new Worker<CollectorFetchSourcePayload>(
      TEST_QUEUE,
      (job: Job<CollectorFetchSourcePayload>) => collectorWorker.handle(job),
      { connection: redisConnectionOptions(REDIS_URL), concurrency: 1 },
    );

    const producer = new Queue<CollectorFetchSourcePayload>(TEST_QUEUE, {
      connection: redisConnectionOptions(REDIS_URL),
    });
    await producer.add(JobName.COLLECTOR_FETCH_SOURCE, agent03Payload, {
      jobId: JobId.collectorFetchSource('29836860', String(Math.floor(Date.now() / 60_000))),
    });

    await waitFor(async () => (runs.length > 0 ? true : null), 15_000);
    expect(runs.find((entry) => entry.sourceId === agent03Payload.sourceId)).toEqual(
      agent03Payload,
    );

    await runWorker.close();
    await producer.close();
  }, 30_000);

  it('**不可重试的失败不烧完 3 次尝试**（UnrecoverableError 立刻终止）', async () => {
    let calls = 0;
    const fakeService = {
      async runCollect(): Promise<CollectOutcome> {
        calls += 1;
        return {
          status: 'failed',
          sourceId: '9200',
          errorCode: 'SOURCE_FETCH_CREDENTIALS_MISSING',
          message: 'token not configured',
          retryable: false,
        };
      },
    } as unknown as CollectorService;

    const collectorWorker = new CollectorWorker(config, fakeService, silentLogger);
    const runWorker = new Worker<CollectorFetchSourcePayload>(
      TEST_QUEUE,
      (job: Job<CollectorFetchSourcePayload>) => collectorWorker.handle(job),
      { connection: redisConnectionOptions(REDIS_URL), concurrency: 1 },
    );

    const queue = new BullSourceFetchQueue(config, TEST_QUEUE);
    const at = new Date();
    await queue.enqueue(
      { sourceId: '9200', trigger: 'schedule', requestedAt: at.toISOString() },
      at,
    );

    // 等到任务进入 failed 状态。
    await waitFor(async () => {
      const failed = await inspectQueue.getFailed();
      return failed.some((job) => job.data.sourceId === '9200') ? true : null;
    }, 15_000);
    // 再等一会儿，确认没有被重试。
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(calls).toBe(1);

    await runWorker.close();
    await queue.close();
  }, 30_000);

  it('**可重试的失败确实会被重试**（与上一条形成对照）', async () => {
    let calls = 0;
    const fakeService = {
      async runCollect(): Promise<CollectOutcome> {
        calls += 1;
        return {
          status: 'failed',
          sourceId: '9300',
          errorCode: 'SOURCE_FETCH_FAILED',
          message: 'upstream 502',
          retryable: true,
        };
      },
    } as unknown as CollectorService;

    const collectorWorker = new CollectorWorker(config, fakeService, silentLogger);
    const runWorker = new Worker<CollectorFetchSourcePayload>(
      TEST_QUEUE,
      (job: Job<CollectorFetchSourcePayload>) => collectorWorker.handle(job),
      { connection: redisConnectionOptions(REDIS_URL), concurrency: 1 },
    );

    const producer = new Queue<CollectorFetchSourcePayload>(TEST_QUEUE, {
      connection: redisConnectionOptions(REDIS_URL),
    });
    await producer.add(
      JobName.COLLECTOR_FETCH_SOURCE,
      { sourceId: '9300', trigger: 'schedule', requestedAt: new Date().toISOString() },
      {
        jobId: `collector:9300:${Date.now()}`,
        attempts: 2,
        // 把退避压到最短，否则用例要等 5 秒。
        backoff: { type: 'fixed', delay: 50 },
      },
    );

    await waitFor(async () => (calls >= 2 ? true : null), 15_000);
    expect(calls).toBeGreaterThanOrEqual(2);

    await runWorker.close();
    await producer.close();
  }, 30_000);
});

/* ================================================================== */
/* 分布式锁                                                            */
/* ================================================================== */

describe('RedisSourceLock —— 真 Redis 上的互斥', () => {
  it('第一次拿得到，第二次拿不到（互斥）', async () => {
    const lock = new RedisSourceLock(config, silentLogger);
    const key = `it-lock-${Date.now()}-a`;

    const first = await lock.acquire(key, 5_000);
    const second = await lock.acquire(key, 5_000);

    expect(first).not.toBeNull();
    expect(second).toBeNull();

    await lock.release(key, first!);
    await lock.onModuleDestroy();
  });

  it('释放之后可以重新拿到', async () => {
    const lock = new RedisSourceLock(config, silentLogger);
    const key = `it-lock-${Date.now()}-b`;

    const first = await lock.acquire(key, 5_000);
    await lock.release(key, first!);
    const second = await lock.acquire(key, 5_000);

    expect(second).not.toBeNull();
    await lock.release(key, second!);
    await lock.onModuleDestroy();
  });

  it('**只释放自己持有的锁**（拿别人的 token 释放不掉）', async () => {
    // 这两步之间锁可能过期并被别人拿到，「先 GET 再 DEL」会删掉**别人的**锁。
    // 真实现用 Lua 做原子的 compare-and-delete —— 这条用例钉住它。
    const lock = new RedisSourceLock(config, silentLogger);
    const key = `it-lock-${Date.now()}-c`;

    const token = await lock.acquire(key, 5_000);
    await lock.release(key, 'someone-elses-token');

    // 别人的 token 释放不掉，锁仍然在。
    expect(await lock.acquire(key, 5_000)).toBeNull();

    await lock.release(key, token!);
    expect(await lock.acquire(key, 5_000)).not.toBeNull();
    await lock.onModuleDestroy();
  });

  it('TTL 到期后锁自动释放（进程崩溃不会永久锁死来源）', async () => {
    const lock = new RedisSourceLock(config, silentLogger);
    const key = `it-lock-${Date.now()}-d`;

    await lock.acquire(key, 150);
    await new Promise((resolve) => setTimeout(resolve, 400));

    expect(await lock.acquire(key, 5_000)).not.toBeNull();
    await lock.onModuleDestroy();
  });

  it('Redis 不可用时**抛错**，不做「拿不到就当作拿到了」的降级', async () => {
    // 降级等于关掉并发保护 —— 那会让「先查后写」的幂等重新暴露在并发双写下。
    const lock = new RedisSourceLock(
      { ...config, redisUrl: 'redis://127.0.0.1:6399' },
      silentLogger,
    );
    await expect(lock.acquire('it-lock-dead', 1_000)).rejects.toThrow();
    await lock.onModuleDestroy().catch(() => undefined);
  }, 20_000);
});

describe('持锁时长的取值', () => {
  it('采集锁的 TTL 必须**严格大于**一次采集的最坏耗时', () => {
    // 锁在任务还在跑时过期 → 后来者拿到锁 → 两个任务同时写库 → 幂等失效。
    // 这正是这把锁要防的事，所以这条关系必须成立。
    expect(collectorLockTtlMs(10_000)).toBeGreaterThan(10_000);
    expect(collectorLockTtlMs(30_000)).toBeGreaterThan(30_000);
    // 宽松到足以覆盖 HN 的多批子请求。
    expect(collectorLockTtlMs(10_000)).toBeGreaterThanOrEqual(100_000);
  });

  it('调度器锁只需要覆盖「入队」这一瞬间', () => {
    expect(SCHEDULER_LOCK_TTL_MS).toBeLessThan(collectorLockTtlMs(10_000));
  });

  it('**最坏请求数 × 超时 ≤ 采集锁 TTL**（这条不变量原先只有人工算术）', async () => {
    // 锁在采集跑完之前过期 → 后来者拿到锁 → 两个任务同时「先查后写」→ 重复落库。
    // 解析器侧已经用真库实测证明「没有锁时确实会双写」，所以这条不变量是实质的。
    const { HN_MAX_ITEMS, HN_ITEM_CONCURRENCY } =
      await import('../src/jobs/collectors/adapters/hacker-news.adapter');
    const { GITHUB_RELEASES_PER_PAGE } =
      await import('../src/jobs/collectors/adapters/github-repo.adapter');

    // 各适配器一轮采集的**顺序请求数上界**：1 次列表 + 子请求批次。
    const worstCaseRequests = Math.max(
      1 + Math.ceil(HN_MAX_ITEMS / HN_ITEM_CONCURRENCY),
      1 + GITHUB_RELEASES_PER_PAGE / GITHUB_RELEASES_PER_PAGE, // releases 是一次请求
      2, // X：一次用户查找 + 一页时间线
    );

    const timeoutMs = 10_000; // docs/20 的默认 SOURCE_FETCH_TIMEOUT_MS
    const worstCaseMs = worstCaseRequests * timeoutMs;

    expect(collectorLockTtlMs(timeoutMs)).toBeGreaterThanOrEqual(worstCaseMs);
  });

  it('锁 key 就是 docs/06 的字面格式', async () => {
    const { sourceFetchLockKey } = await import('../src/jobs/collectors/ports');
    expect(sourceFetchLockKey('123')).toBe('source-fetch:123');
  });
});

/* ================================================================== */
/* 端到端：真实 service + 真实锁 + 真实队列                             */
/* ================================================================== */

describe('端到端：真 service（内存仓储 + 真锁 + 真队列）', () => {
  it('一次完整采集：入队 → 消费 → 落库 → 推进 → 释放锁', async () => {
    const { CollectorService } = await import('../src/jobs/collectors/collector.service');
    const {
      InMemoryRawItemRepository,
      InMemorySourceRepository,
      InMemoryJobRunRepository,
      FakeClock,
      StubAdapter,
      createSource,
    } = await import('./support/collector-fakes');
    const { SourceType } = await import('@signal/contracts');

    const sourceRepository = new InMemorySourceRepository([
      createSource({ id: '9400', type: SourceType.RSS }),
    ]);
    const rawItemRepository = new InMemoryRawItemRepository();
    const jobRunRepository = new InMemoryJobRunRepository();
    const lock = new RedisSourceLock(config, silentLogger);
    const clock = new FakeClock(new Date());
    const adapter = new StubAdapter(async () => batchOf([createItem({ sourceId: '9400' })]));

    const service = new CollectorService(
      config,
      clock,
      sourceRepository,
      rawItemRepository,
      jobRunRepository,
      lock,
      Object.fromEntries(Object.values(SourceType).map((type) => [type, adapter])) as never,
      silentLogger,
    );

    const outcome = await service.runCollect(
      { sourceId: '9400', trigger: 'schedule', requestedAt: new Date().toISOString() },
      { attempt: 1, isFinalAttempt: false },
    );

    expect(outcome).toMatchObject({ status: 'succeeded', stored: 1 });
    expect(rawItemRepository.inserted).toHaveLength(1);
    expect(sourceRepository.outcomes).toHaveLength(1);

    // 真锁必须已经释放 —— 否则这个来源会被卡到 TTL 到期。
    const probe = new InMemorySourceLock();
    expect(await lock.acquire('source-fetch:9400', 1_000)).not.toBeNull();
    expect(probe).toBeDefined();

    await lock.onModuleDestroy();
  }, 30_000);
});
