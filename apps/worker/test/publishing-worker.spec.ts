/**
 * `publishing` 消费者的守卫 —— 分派、重试判定与 Dead Letter。
 *
 * ── 这个文件里最值得看的一条 ────────────────────────────────────────
 * 「`NOT_SCHEDULED` 是**成功**，不是失败」。
 *
 * `docs/10` 说「08:00 只有 SCHEDULED 才发布」，所以「到点了但没排期 → 不发」
 * 是**契约规定的正常结果**。把它记成 job 失败会让运维面板每天早上都报一次
 * 「publish job 失败」，而那恰恰是「未审核保持草稿」在正常工作。
 * Agent 05 的 `raw_items.status = FAILED` 是数据结论、job 仍成功，
 * 这里是同一类区分。
 *
 * ⚠ 与 Agent 06 的教训对应：它的 P0 是「集成测试自己拼 jobId 字面量、
 * 从来没调用过 builder」。本文件的每个用例都走**真的分派路径**。
 */

import { describe, expect, it } from 'vitest';
import { JobName } from '@signal/contracts';
import { createLogger } from '@signal/logger';
import { createMemoryStream } from '@signal/test-utils';
import { PublishingQueueWorker } from '../src/jobs/publishing/publishing.worker';
import { PublishingService } from '../src/jobs/publishing/publishing.service';
import { PUBLISHING_SLOT, dailyDraftJobId } from '../src/jobs/publishing/queue';
import type { RecordJobRunInput } from '../src/jobs/ai';
import {
  InMemoryPublishingRepository,
  RecordingNotifier,
  makeCandidate,
} from './support/publishing-fakes';

const TODAY = '2026-09-29';
const PUBLISH_MOMENT = new Date('2026-09-29T00:00:00.000Z');

/** 记录所有 `job_runs` 写入。 */
class RecordingJobRuns {
  readonly records: RecordJobRunInput[] = [];

  async record(input: RecordJobRunInput): Promise<void> {
    this.records.push(input);
  }

  statuses(): string[] {
    return this.records.map((record) => String(record.status));
  }
}

/**
 * 一个会在**主路径上**抛错的替身（测可重试失败与 Dead Letter）。
 *
 * ⚠ 覆盖的是 `findCandidates` 而不是 `findEdition`：
 * 替身的 `ensureDraft` 直接读自己的 Map（真实实现才会先 `findEdition`），
 * 所以覆盖 `findEdition` 挡不住草稿生成这条路 ——
 * 第一版就是这么写的，结果是「以为在测失败路径，其实一路跑到成功」。
 * 这是一个**替身把测试跑空**的例子（Agent 06 的 P0 同源）。
 */
class ExplodingRepository extends InMemoryPublishingRepository {
  override async findCandidates(): Promise<never> {
    throw new Error('连接数据库失败（模拟瞬时故障）');
  }
}

function build(options: { explode?: boolean } = {}) {
  const repository =
    options.explode === true ? new ExplodingRepository() : new InMemoryPublishingRepository();
  const notifier = new RecordingNotifier();
  const recorder = new RecordingJobRuns();
  const stream = createMemoryStream();
  const logger = createLogger({ service: 'worker', destination: stream });

  const service = new PublishingService(
    repository,
    notifier,
    { now: () => PUBLISH_MOMENT },
    logger,
  );
  const worker = new PublishingQueueWorker({
    service,
    // 消费者不会真的连 Redis：本文件全部走 `handle()`。
    connection: { host: '127.0.0.1', port: 6379 },
    logger,
    recorder,
  });

  return { repository, notifier, recorder, worker, stream };
}

/** 造一个 job（与 BullMQ 的 `Job` 结构对齐的那几个字段）。 */
function job(
  name: string,
  data: unknown,
  attemptsMade = 0,
): { id: string; name: string; data: unknown; attemptsMade: number } {
  return { id: 'test-job-1', name, data, attemptsMade };
}

/* ------------------------------------------------------------------ */
/* 分派                                                                */
/* ------------------------------------------------------------------ */

describe('按 Job 名与槽位分派', () => {
  it('`publishing.daily-draft` + 0010 槽 → 只建期次、不写内容', async () => {
    const { worker, repository } = build();

    const outcome = await worker.handle(
      job(JobName.PUBLISHING_DAILY_DRAFT, {
        businessDate: TODAY,
        slot: PUBLISHING_SLOT.INIT_DRAFT,
      }),
    );

    expect(outcome).toMatchObject({ created: true });
    expect(repository.replaceCalls).toHaveLength(0);
  });

  it('`publishing.daily-draft` + 0530 槽 → 生成草稿', async () => {
    const { worker, repository } = build();
    repository.seedEdition({ businessDate: TODAY, status: 'DRAFT' as never });
    repository.candidates = [makeCandidate({ contentId: '1', title: '模型发布' })];

    const outcome = await worker.handle(
      job(JobName.PUBLISHING_DAILY_DRAFT, {
        businessDate: TODAY,
        slot: PUBLISHING_SLOT.GENERATE_DRAFT,
      }),
    );

    expect(outcome).toMatchObject({ generated: true });
    expect(repository.replaceCalls).toHaveLength(1);
  });

  it('`publishing.daily-draft` + 0700 槽 → 同样是生成（刷新就是再跑一次）', async () => {
    const { worker, repository } = build();
    repository.seedEdition({ businessDate: TODAY, status: 'DRAFT' as never });
    repository.candidates = [makeCandidate({ contentId: '1', title: '模型发布' })];

    const outcome = await worker.handle(
      job(JobName.PUBLISHING_DAILY_DRAFT, {
        businessDate: TODAY,
        slot: PUBLISHING_SLOT.REFRESH_DRAFT,
      }),
    );

    expect(outcome).toMatchObject({ generated: true });
  });

  it('`publishing.daily-publish` → 发布判定', async () => {
    const { worker, repository } = build();
    repository.seedEdition({
      businessDate: TODAY,
      status: 'SCHEDULED' as never,
      sections: [
        {
          type: 'FRONT_PAGE',
          title: '首页',
          sortOrder: 0,
          items: [{ contentId: '1', displayStyle: 'LEAD', sortOrder: 0 }],
        },
      ],
    });

    const outcome = await worker.handle(
      job(JobName.PUBLISHING_DAILY_PUBLISH, { businessDate: TODAY, slot: PUBLISHING_SLOT.PUBLISH }),
    );

    expect(outcome).toMatchObject({ published: true, reason: 'PUBLISHED', editionNo: 1 });
  });

  it('挂错队列的 Job 名 → 立即不可重试地把 job 打掉', async () => {
    const { worker } = build();
    await expect(
      worker.handle(job(JobName.AI_TRANSLATE, { businessDate: TODAY, slot: '0530' })),
    ).rejects.toThrow(/Unexpected job name/);
  });
});

/* ------------------------------------------------------------------ */
/* 业务结论 vs 任务失败                                                 */
/* ------------------------------------------------------------------ */

describe('「不发」是业务结论，不是任务失败', () => {
  it('⚠ `NOT_SCHEDULED` → job **成功**，`job_runs` 记 SUCCEEDED', async () => {
    const { worker, repository, recorder } = build();
    repository.seedEdition({ businessDate: TODAY, status: 'DRAFT' as never });

    const outcome = await worker.handle(
      job(JobName.PUBLISHING_DAILY_PUBLISH, { businessDate: TODAY, slot: PUBLISHING_SLOT.PUBLISH }),
    );

    expect(outcome).toMatchObject({ published: false, reason: 'NOT_SCHEDULED' });
    expect(recorder.statuses()).toEqual(['SUCCEEDED']);
  });

  it('`ALREADY_PUBLISHED`（幂等重跑）同样是成功', async () => {
    const { worker, repository, recorder } = build();
    repository.seedEdition({
      businessDate: TODAY,
      status: 'PUBLISHED' as never,
      editionNo: 1,
    });

    const outcome = await worker.handle(
      job(JobName.PUBLISHING_DAILY_PUBLISH, { businessDate: TODAY, slot: PUBLISHING_SLOT.PUBLISH }),
    );

    expect(outcome).toMatchObject({ reason: 'ALREADY_PUBLISHED' });
    expect(recorder.statuses()).toEqual(['SUCCEEDED']);
  });

  it('草稿生成「没有候选」也是成功（早上没采到东西是正常的）', async () => {
    const { worker, repository, recorder } = build();
    repository.seedEdition({ businessDate: TODAY, status: 'DRAFT' as never });
    repository.candidates = [];

    const outcome = await worker.handle(
      job(JobName.PUBLISHING_DAILY_DRAFT, {
        businessDate: TODAY,
        slot: PUBLISHING_SLOT.GENERATE_DRAFT,
      }),
    );

    expect(outcome).toMatchObject({ generated: false, skippedReason: 'NO_CANDIDATES' });
    expect(recorder.statuses()).toEqual(['SUCCEEDED']);
  });
});

/* ------------------------------------------------------------------ */
/* 载荷与失败                                                          */
/* ------------------------------------------------------------------ */

describe('载荷校验', () => {
  it('非对象载荷 → 不可重试 + `job_runs` 记 DEAD', async () => {
    const { worker, recorder } = build();

    await expect(
      worker.handle(job(JobName.PUBLISHING_DAILY_DRAFT, 'not-an-object')),
    ).rejects.toThrow(/payload/);
    expect(recorder.statuses()).toEqual(['DEAD']);
    expect(recorder.records[0]?.errorCode).toBe('INVALID_PAYLOAD');
  });

  it('业务日格式不对 → 不可重试（重试只会重复同一个错误）', async () => {
    const { worker, recorder } = build();

    await expect(
      worker.handle(
        job(JobName.PUBLISHING_DAILY_DRAFT, { businessDate: '2026/09/29', slot: '0530' }),
      ),
    ).rejects.toThrow(/payload/);
    expect(recorder.statuses()).toEqual(['DEAD']);
  });

  it('槽位不在表里 → 不可重试', async () => {
    const { worker, recorder } = build();

    await expect(
      worker.handle(job(JobName.PUBLISHING_DAILY_DRAFT, { businessDate: TODAY, slot: '9999' })),
    ).rejects.toThrow(/payload/);
    expect(recorder.statuses()).toEqual(['DEAD']);
  });
});

describe('可重试失败与 Dead Letter（docs/13）', () => {
  it('中间次失败 → `job_runs` 记 FAILED 并把错误抛回 BullMQ（让它重试）', async () => {
    const { worker, recorder } = build({ explode: true });

    await expect(
      worker.handle(
        job(JobName.PUBLISHING_DAILY_DRAFT, {
          businessDate: TODAY,
          slot: PUBLISHING_SLOT.GENERATE_DRAFT,
        }),
      ),
    ).rejects.toThrow(/连接数据库失败/);

    expect(recorder.statuses()).toEqual(['FAILED']);
    expect(recorder.records[0]?.attempts).toBe(1);
  });

  it('第 3 次（契约的 attempts）失败 → `job_runs` 记 DEAD（docs/13 的 Dead Letter）', async () => {
    const { worker, recorder } = build({ explode: true });

    await expect(
      worker.handle(
        job(
          JobName.PUBLISHING_DAILY_DRAFT,
          { businessDate: TODAY, slot: PUBLISHING_SLOT.GENERATE_DRAFT },
          2, // attemptsMade = 2 → 本次是第 3 次
        ),
      ),
    ).rejects.toThrow();

    expect(recorder.statuses()).toEqual(['DEAD']);
    expect(recorder.records[0]?.attempts).toBe(3);
  });

  it('成功与失败都写 `job_runs`（终态可查）', async () => {
    const { worker, recorder } = build();
    await worker.handle(
      job(JobName.PUBLISHING_DAILY_PUBLISH, { businessDate: TODAY, slot: PUBLISHING_SLOT.PUBLISH }),
    );
    expect(recorder.records).toHaveLength(1);
    expect(recorder.records[0]).toMatchObject({
      jobType: JobName.PUBLISHING_DAILY_PUBLISH,
      jobKey: 'test-job-1',
    });
  });

  it('没有 recorder 时也能跑（不因为记录失败而掩盖原始结果）', async () => {
    const repository = new InMemoryPublishingRepository();
    const notifier = new RecordingNotifier();
    const logger = createLogger({ service: 'worker', destination: createMemoryStream() });
    const service = new PublishingService(
      repository,
      notifier,
      { now: () => PUBLISH_MOMENT },
      logger,
    );
    const worker = new PublishingQueueWorker({
      service,
      connection: { host: '127.0.0.1', port: 6379 },
      logger,
    });

    await expect(
      worker.handle(
        job(JobName.PUBLISHING_DAILY_PUBLISH, {
          businessDate: TODAY,
          slot: PUBLISHING_SLOT.PUBLISH,
        }),
      ),
    ).resolves.toMatchObject({ reason: 'NO_EDITION' });
  });
});

describe('jobId 与槽位的对应（回归守卫）', () => {
  it('三个草稿槽位各自入队时拿到不同的 jobId', () => {
    const ids = new Set([
      dailyDraftJobId(TODAY, PUBLISHING_SLOT.INIT_DRAFT),
      dailyDraftJobId(TODAY, PUBLISHING_SLOT.GENERATE_DRAFT),
      dailyDraftJobId(TODAY, PUBLISHING_SLOT.REFRESH_DRAFT),
    ]);
    expect(ids.size).toBe(3);
  });
});
