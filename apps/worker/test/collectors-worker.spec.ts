/**
 * `CollectorWorker`（BullMQ 消费端）测试。
 *
 * 这里验证的是**重试语义的翻译**：
 *   - 载荷畸形 → `UnrecoverableError`（重试同一份坏载荷没有意义）；
 *   - 失败且可重试 → 抛普通 `Error`（BullMQ 按 `COLLECTOR_RETRY` 退避重试）；
 *   - 失败且不可重试（令牌没配 / 地址非法）→ `UnrecoverableError`（立刻终止）。
 *
 * 这个区分必须被测试钉住：写错的症状是「一个坏配置的源每天烧 3 倍噪声日志」
 * 或「一个临时 502 被当成永久失败」，两者都不会报错。
 */

import { describe, expect, it } from 'vitest';
import { SourceType } from '@signal/contracts';
import { UnrecoverableError, type Job } from 'bullmq';
import { MALFORMED_PAYLOAD_LABEL, parsePayload } from '../src/jobs/collectors/collector.worker';
import type {
  CollectOutcome,
  CollectRunContext,
  CollectorService,
} from '../src/jobs/collectors/collector.service';
import type { CollectorFetchSourcePayload } from '../src/jobs/collectors/ports';
import { CollectorWorker } from '../src/jobs/collectors/collector.worker';
import { createLogger } from '@signal/logger';
import { createMemoryStream } from '@signal/test-utils';

/** 只实现 `handle` 需要的那部分 `CollectorService`。 */
class StubService {
  calls: { payload: CollectorFetchSourcePayload; run: CollectRunContext }[] = [];

  constructor(private readonly outcome: CollectOutcome | (() => Promise<CollectOutcome>)) {}

  async runCollect(
    payload: CollectorFetchSourcePayload,
    run: CollectRunContext,
  ): Promise<CollectOutcome> {
    this.calls.push({ payload, run });
    return typeof this.outcome === 'function' ? this.outcome() : this.outcome;
  }
}

function buildWorker(service: StubService) {
  return new CollectorWorker(
    {
      nodeEnv: 'test',
      fetchTimeoutMs: 10_000,
      fetchMaxBytes: 2_097_152,
      xApiBearerToken: null,
      githubToken: null,
      redisUrl: 'redis://127.0.0.1:6390',
      schedulerIntervalMs: 60_000,
    },
    service as unknown as CollectorService,
    createLogger({ service: 'worker-test', level: 'info', destination: createMemoryStream() }),
  );
}

/** 造一个只带 `handle` 需要的字段的假 Job。 */
function fakeJob(
  data: unknown,
  overrides: { attemptsMade?: number; attempts?: number; id?: string } = {},
): Job<CollectorFetchSourcePayload> {
  return {
    id: overrides.id ?? 'job-1',
    data: data as CollectorFetchSourcePayload,
    attemptsMade: overrides.attemptsMade ?? 0,
    opts: { attempts: overrides.attempts ?? 3 },
  } as Job<CollectorFetchSourcePayload>;
}

const SUCCESS: CollectOutcome = {
  status: 'succeeded',
  sourceId: '1',
  collected: 2,
  stored: 2,
  skippedByAdapter: 0,
  duplicates: 0,
};

describe('parsePayload — 载荷校验', () => {
  it('合法载荷原样通过', () => {
    const payload = { sourceId: '42', trigger: 'manual', requestedAt: '2026-09-24T02:00:00.000Z' };
    expect(parsePayload(payload)).toEqual(payload);
  });

  it('sourceId 非数字串 → null（否则 BigInt() 会抛 SyntaxError）', () => {
    expect(parsePayload({ sourceId: 'abc', trigger: 'schedule' })).toBeNull();
    expect(parsePayload({ sourceId: '', trigger: 'schedule' })).toBeNull();
    expect(parsePayload({ sourceId: 42, trigger: 'schedule' })).toBeNull();
    // 超过 20 位也不接受（BIGINT 装不下）。
    expect(parsePayload({ sourceId: '1'.repeat(21), trigger: 'schedule' })).toBeNull();
  });

  it('trigger 不在契约的两个取值里 → null', () => {
    expect(parsePayload({ sourceId: '1', trigger: 'cron' })).toBeNull();
    expect(parsePayload({ sourceId: '1' })).toBeNull();
  });

  it('不是对象 → null', () => {
    expect(parsePayload(null)).toBeNull();
    expect(parsePayload('string')).toBeNull();
    expect(parsePayload([])).toBeNull();
  });

  it('**requestedAt 缺失或非法时补一个**（它只用于日志，不该让任务判死）', () => {
    const parsed = parsePayload({ sourceId: '1', trigger: 'schedule' });
    expect(parsed).not.toBeNull();
    expect(Number.isNaN(new Date(parsed!.requestedAt).getTime())).toBe(false);

    const bad = parsePayload({ sourceId: '1', trigger: 'schedule', requestedAt: 'nonsense' });
    expect(Number.isNaN(new Date(bad!.requestedAt).getTime())).toBe(false);
  });
});

describe('CollectorWorker.handle — 重试语义', () => {
  it('成功时返回结论，不抛', async () => {
    const service = new StubService(SUCCESS);
    const worker = buildWorker(service);

    await expect(worker.handle(fakeJob({ sourceId: '1', trigger: 'schedule' }))).resolves.toEqual(
      SUCCESS,
    );
  });

  it('skipped 也不抛（跳过不是失败）', async () => {
    const service = new StubService({ status: 'skipped', sourceId: '1', reason: 'locked' });
    const worker = buildWorker(service);
    await expect(
      worker.handle(fakeJob({ sourceId: '1', trigger: 'schedule' })),
    ).resolves.toMatchObject({ status: 'skipped' });
  });

  it('**可重试的失败抛普通 Error**（BullMQ 会退避重试）', async () => {
    const service = new StubService({
      status: 'failed',
      sourceId: '1',
      errorCode: 'SOURCE_FETCH_FAILED',
      message: 'upstream 502',
      retryable: true,
    });
    const worker = buildWorker(service);

    // ⚠ 必须断言**错误类型**，不能只断言消息正则。
    // `UnrecoverableError` 的 message 也是 `${code}: ${message}`，
    // 所以 `/upstream 502/` 对两种错误**都匹配** —— 反证实测：把可重试
    // 分支反转之后单测全绿，只有需要 Redis 的集成测试抓到了。
    const error: unknown = await worker
      .handle(fakeJob({ sourceId: '1', trigger: 'schedule' }))
      .then(() => null)
      .catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(UnrecoverableError);
    expect((error as Error).message).toMatch(/upstream 502/);
  });

  it('**不可重试的失败抛 UnrecoverableError**（立刻终止，不烧完 3 次尝试）', async () => {
    const service = new StubService({
      status: 'failed',
      sourceId: '1',
      errorCode: 'SOURCE_FETCH_CREDENTIALS_MISSING',
      message: 'X_API_BEARER_TOKEN is not configured',
      retryable: false,
    });
    const worker = buildWorker(service);

    await expect(
      worker.handle(fakeJob({ sourceId: '1', trigger: 'schedule' })),
    ).rejects.toBeInstanceOf(UnrecoverableError);
  });

  it('畸形载荷 → UnrecoverableError，且**不调用 service**', async () => {
    const service = new StubService(SUCCESS);
    const worker = buildWorker(service);

    await expect(
      worker.handle(fakeJob({ sourceId: 'not-a-number', trigger: 'x' })),
    ).rejects.toThrow(MALFORMED_PAYLOAD_LABEL);
    expect(service.calls).toHaveLength(0);
  });

  it('把尝试次数与「是否最后一次」传给 service（决定 JobRun 记 FAILED 还是 DEAD）', async () => {
    const service = new StubService(SUCCESS);
    const worker = buildWorker(service);

    await worker.handle(
      fakeJob({ sourceId: '1', trigger: 'schedule' }, { attemptsMade: 0, attempts: 3 }),
    );
    await worker.handle(
      fakeJob({ sourceId: '1', trigger: 'schedule' }, { attemptsMade: 2, attempts: 3 }),
    );

    expect(service.calls[0]!.run).toEqual({ attempt: 1, isFinalAttempt: false });
    expect(service.calls[1]!.run).toEqual({ attempt: 3, isFinalAttempt: true });
  });

  it('attempts 缺省为 1 时，第一次就是最后一次', async () => {
    const service = new StubService(SUCCESS);
    const worker = buildWorker(service);

    await worker.handle(fakeJob({ sourceId: '1', trigger: 'schedule' }, { attempts: 1 }));
    expect(service.calls[0]!.run).toEqual({ attempt: 1, isFinalAttempt: true });
  });
});

describe('并发度与队列名取自契约（docs/13）', () => {
  it('QUEUE_CONCURRENCY.collector = 5，队列名是 `collector`', async () => {
    const { QUEUE_CONCURRENCY, QueueName } = await import('@signal/contracts');
    expect(QueueName.COLLECTOR).toBe('collector');
    expect(QUEUE_CONCURRENCY[QueueName.COLLECTOR]).toBe(5);
  });

  it('本模块没有发明新的 Queue / Job 名', async () => {
    const { QueueName, JobName } = await import('@signal/contracts');
    // 调度扫描是进程内定时器 + Redis 锁，**没有**新增 Job 名 ——
    // `docs/13` 的 10 个 Job 名一个都没多。
    expect(Object.values(QueueName)).toHaveLength(6);
    expect(Object.values(JobName)).toHaveLength(10);
    expect(Object.values(JobName)).toContain(JobName.COLLECTOR_FETCH_SOURCE);
  });
});

describe('类型自检', () => {
  it('SourceType 的六个值都在适配器注册表里（少一个就编译不过，这里再验一次运行期）', async () => {
    const { createAdapterRegistry, adapterFor } = await import('../src/jobs/collectors/adapters');
    const { SourceType: Types } = await import('@signal/contracts');
    const registry = createAdapterRegistry();

    for (const type of Object.values(Types)) {
      expect(adapterFor(registry, type as (typeof Types)[keyof typeof Types]).type).toBe(type);
    }
    expect(Object.values(Types)).toHaveLength(6);
    expect(SourceType.RSS).toBe('RSS');
  });
});
