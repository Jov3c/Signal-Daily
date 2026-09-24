/**
 * `SourceScheduler` 测试。
 *
 * 覆盖 `docs/06` 的调度规则与三层容错（整轮 / 单来源 / 入队）。
 */

import { describe, expect, it } from 'vitest';
import { SourceType } from '@signal/contracts';
import { createLogger } from '@signal/logger';
import { createMemoryStream } from '@signal/test-utils';
import { SourceScheduler } from '../src/jobs/collectors/scheduler.service';
import {
  FakeClock,
  InMemorySourceFetchQueue,
  InMemorySourceLock,
  InMemorySourceRepository,
  createSource,
} from './support/collector-fakes';

const START = new Date('2026-09-24T02:00:00.000Z');

function build(sources = [createSource({ id: '1' })]) {
  const repository = new InMemorySourceRepository(sources);
  const queue = new InMemorySourceFetchQueue();
  const lock = new InMemorySourceLock();
  const clock = new FakeClock(START);
  const logStream = createMemoryStream();

  const scheduler = new SourceScheduler(
    {
      nodeEnv: 'test',
      fetchTimeoutMs: 10_000,
      fetchMaxBytes: 2_097_152,
      xApiBearerToken: null,
      githubToken: null,
      redisUrl: 'redis://127.0.0.1:6390',
      schedulerIntervalMs: 60_000,
    },
    clock,
    repository,
    queue,
    lock,
    createLogger({ service: 'scheduler-test', level: 'info', destination: logStream }),
  );

  return { scheduler, repository, queue, lock, clock, logStream };
}

describe('SourceScheduler', () => {
  it('把到期来源入队，载荷形状与 Agent 03 的 fetch-now 一致', async () => {
    const { scheduler, queue, clock } = build();

    const result = await scheduler.tick();

    expect(result).toEqual({ due: 1, enqueued: 1, locked: 0, failed: 0 });
    expect(queue.enqueued[0]!.payload).toEqual({
      sourceId: '1',
      trigger: 'schedule',
      requestedAt: clock.now().toISOString(),
    });
  });

  it('**停用的来源不会被入队**（`docs/06`：停用后停止产生新抓取任务）', async () => {
    // 这条由替身的 `enabled` 过滤承担 —— 那是调度器能管到的那一半规则。
    // `nextFetchAt` 那一半只在真库集成测试里覆盖（见 collector-fakes.ts 的说明）。
    const { scheduler, queue } = build([
      createSource({ id: '1', enabled: true }),
      createSource({ id: '2', enabled: false }),
    ]);

    const result = await scheduler.tick();

    expect(result.due).toBe(1);
    expect(queue.enqueued.map((entry) => entry.payload.sourceId)).toEqual(['1']);
  });

  it('没有到期来源时不入队（也不会出错）', async () => {
    const { scheduler, queue } = build([]);
    expect(await scheduler.tick()).toEqual({ due: 0, enqueued: 0, locked: 0, failed: 0 });
    expect(queue.enqueued).toHaveLength(0);
  });

  it('用**注入的时钟**查询到期（绝不用 SQL 的 NOW()，时区会差 8 小时）', async () => {
    const { scheduler, repository, clock } = build();
    await scheduler.tick();

    expect(repository.dueCalls).toHaveLength(1);
    expect(repository.dueCalls[0]!.now.toISOString()).toBe(clock.now().toISOString());
    // 与契约的批次上限一致（`@signal/source-core` 的 DUE_SOURCES_BATCH_SIZE）。
    expect(repository.dueCalls[0]!.limit).toBe(100);
  });

  it('**单个来源入队失败不影响同批其它来源**', async () => {
    const sources = [
      createSource({ id: '1', slug: 'a' }),
      createSource({ id: '2', slug: 'b' }),
      createSource({ id: '3', slug: 'c' }),
    ];
    const { scheduler, queue } = build(sources);
    // 第 2 个来源入队失败。
    let calls = 0;
    const originalEnqueue = queue.enqueue.bind(queue);
    queue.enqueue = async (payload, at) => {
      calls += 1;
      if (calls === 2) throw new Error('queue rejected this one');
      return originalEnqueue(payload, at);
    };

    const result = await scheduler.tick();

    expect(result).toMatchObject({ due: 3, enqueued: 2, failed: 1 });
    expect(queue.enqueued.map((entry) => entry.payload.sourceId)).toEqual(['1', '3']);
  });

  it('锁被占用时跳过（同一来源另有任务在跑，不重复入队）', async () => {
    const { scheduler, queue, lock } = build();
    await lock.acquire('source-fetch:1', 60_000);

    const result = await scheduler.tick();

    expect(result).toEqual({ due: 1, enqueued: 0, locked: 1, failed: 0 });
    expect(queue.enqueued).toHaveLength(0);
  });

  it('入队后立刻释放锁（不覆盖任务的实际执行时间）', async () => {
    const { scheduler, lock } = build();
    await scheduler.tick();
    expect(lock.held.has('source-fetch:1')).toBe(false);
  });

  it('Redis 拿不到锁 → 记 failed，不影响其它来源', async () => {
    const sources = [createSource({ id: '1' }), createSource({ id: '2' })];
    const { scheduler, lock, queue } = build(sources);
    lock.failNext = true;

    const result = await scheduler.tick();

    expect(result.failed).toBe(1);
    expect(result.enqueued).toBe(1);
    expect(queue.enqueued).toHaveLength(1);
  });

  it('**整轮失败被吞掉并记日志**（定时器回调抛出未捕获异常会直接结束进程）', async () => {
    const { scheduler, repository, logStream } = build();
    repository.findDueSources = async () => {
      throw new Error('mysql is down');
    };

    await expect(scheduler.tick()).resolves.toEqual({
      due: 0,
      enqueued: 0,
      locked: 0,
      failed: 0,
    });
    expect(
      logStream
        .records()
        .map((r) => JSON.stringify(r))
        .join('\n'),
    ).toContain('mysql is down');
  });

  it('上一轮还没跑完时跳过这一轮（慢库 + 60s 间隔会撞上）', async () => {
    const { scheduler, repository, logStream } = build();
    let release: (() => void) | undefined;
    repository.findDueSources = async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return [];
    };

    const first = scheduler.tick();
    const second = await scheduler.tick();

    expect(second).toEqual({ due: 0, enqueued: 0, locked: 0, failed: 0 });
    expect(
      logStream
        .records()
        .map((r) => JSON.stringify(r))
        .join('\n'),
    ).toContain('previous tick is still running');

    release?.();
    await first;
  });
});

describe('SourceScheduler — 启停', () => {
  it('start 是幂等的，stop 之后不再触发', async () => {
    const { scheduler, queue } = build();
    scheduler.start();
    scheduler.start(); // 重复调用不该产生第二个定时器
    scheduler.stop();
    // 停止之后 tick 不再被自动调用 —— 数量保持为 0。
    expect(queue.enqueued).toHaveLength(0);
  });
});

describe('调度规则来自共享包（不是本模块自己发明的）', () => {
  it('到期查询用的 where 里包含 `nextFetchAt: null`（否则 seed 的 8 个来源永远不采）', async () => {
    // 这条断言直接打在共享包的规则对象上 —— 它是 Agent 03（写库方）
    // 与本模块（读库方）之间唯一的约定，两边必须完全一致。
    const { buildDueSourcesWhere } = await import('@signal/source-core');
    const where = buildDueSourcesWhere(START);

    expect(where.enabled).toBe(true);
    expect(where.OR).toContainEqual({ nextFetchAt: null });
    expect(where.OR).toContainEqual({ nextFetchAt: { lte: START } });

    // 而真正实现里的 findDueSources 也确实用了它（替身直接解释该规则）。
    const { scheduler, repository } = build([
      createSource({ id: '1', type: SourceType.RSS, enabled: true }),
      createSource({ id: '2', type: SourceType.RSS, enabled: false }),
    ]);
    await scheduler.tick();
    expect(repository.dueCalls).toHaveLength(1);
  });
});
