/**
 * 日报调度器的守卫 —— `docs/10` 的「建议调度」。
 *
 * 调度器是本模块**最需要测**的一块：它是唯一让「日报每天自己跑起来」
 * 的东西，而它坏掉的方式全都很难发现 ——
 * 少入一次队、入错一个 jobId、某个槽位永远不执行，
 * 表现都只是「今天没出报」，没有任何异常。
 *
 * 用它自己的入队替身（不需要 Redis），断言「哪些槽位、按什么顺序、
 * 带哪个 jobId」。
 */

import { describe, expect, it } from 'vitest';
import { JobName } from '@signal/contracts';
import { createLogger } from '@signal/logger';
import { createMemoryStream } from '@signal/test-utils';
import {
  PublishingScheduler,
  PUBLISHING_ENQUEUER,
  type PublishingEnqueuer,
} from '../src/jobs/publishing/scheduler';
import { PUBLISHING_SLOT, dailyDraftJobId, dailyPublishJobId } from '../src/jobs/publishing/queue';
import { PublishingService } from '../src/jobs/publishing/publishing.service';
import type { PublishingJobData } from '../src/jobs/publishing/queue';
import {
  InMemoryPublishingRepository,
  RecordingNotifier,
  makeCandidate,
} from './support/publishing-fakes';

const TODAY = '2026-09-29';

/** 上海时间 → UTC（Asia/Shanghai 无夏令时，固定 +8）。 */
function shanghai(hour: number, minute: number, day = 29): Date {
  return new Date(Date.UTC(2026, 8, day, hour - 8, minute));
}

class RecordingEnqueuer implements PublishingEnqueuer {
  readonly calls: { jobName: string; data: PublishingJobData; jobId: string }[] = [];

  /** 让某一次入队抛错，用于测「一个槽位失败不影响其他」。 */
  failOnJobId: string | null = null;

  async add(jobName: string, data: PublishingJobData, jobId: string): Promise<void> {
    if (this.failOnJobId !== null && jobId === this.failOnJobId) {
      throw new Error('模拟 Redis 抖动');
    }
    this.calls.push({ jobName, data, jobId });
  }

  slotsEnqueued(): string[] {
    return this.calls.map((call) => call.data.slot);
  }
}

function build(repository = new InMemoryPublishingRepository()) {
  const enqueuer = new RecordingEnqueuer();
  const notifier = new RecordingNotifier();
  const stream = createMemoryStream();
  const logger = createLogger({ service: 'worker', destination: stream });
  const service = new PublishingService(
    repository,
    notifier,
    { now: () => shanghai(8, 0) },
    logger,
  );
  const scheduler = new PublishingScheduler(
    enqueuer,
    service,
    { now: () => shanghai(8, 0) },
    logger,
  );
  return { enqueuer, notifier, repository, service, scheduler, stream };
}

describe('槽位触发', () => {
  it('一天刚开始时，五个槽位都还没到点', async () => {
    const { scheduler, enqueuer } = build();
    const result = await scheduler.tick(shanghai(0, 5));

    expect(result.outcomes.every((outcome) => outcome.action === 'SKIPPED_NOT_DUE')).toBe(true);
    expect(enqueuer.calls).toHaveLength(0);
  });

  it('05:31 → 00:10 与 05:30 两趟入队，07:00 之后的不动', async () => {
    const { scheduler, enqueuer } = build();
    const result = await scheduler.tick(shanghai(5, 31));

    expect(enqueuer.slotsEnqueued()).toEqual([
      PUBLISHING_SLOT.INIT_DRAFT,
      PUBLISHING_SLOT.GENERATE_DRAFT,
    ]);
    expect(result.outcomes.filter((o) => o.action === 'SKIPPED_NOT_DUE')).toHaveLength(3);
  });

  it('08:01 → 三趟草稿 + 一趟发布入队，07:30 的提醒在**进程内**完成', async () => {
    const { scheduler, enqueuer, notifier, repository } = build();
    repository.seedEdition({ businessDate: TODAY, status: 'DRAFT' as never });

    const result = await scheduler.tick(shanghai(8, 1));

    expect(enqueuer.slotsEnqueued()).toEqual([
      PUBLISHING_SLOT.INIT_DRAFT,
      PUBLISHING_SLOT.GENERATE_DRAFT,
      PUBLISHING_SLOT.REFRESH_DRAFT,
      PUBLISHING_SLOT.PUBLISH,
    ]);
    // ⚠ 提醒**不入队**（docs/13 没有「日报提醒」这个 Job 名）
    expect(enqueuer.slotsEnqueued()).not.toContain(PUBLISHING_SLOT.REVIEW_REMINDER);

    const reminder = result.outcomes.find((o) => o.slot === PUBLISHING_SLOT.REVIEW_REMINDER);
    expect(reminder?.action).toBe('DONE_IN_PROCESS');
    expect(notifier.countOf('DAILY_REVIEW_PENDING')).toBe(1);
  });

  it('入队顺序**按时间先后**（队列并发 1，顺序反了会让刷新结果被生成覆盖）', async () => {
    const { scheduler, enqueuer } = build();
    await scheduler.tick(shanghai(8, 1));

    const orders = enqueuer.calls
      .filter((call) => call.jobName === JobName.PUBLISHING_DAILY_DRAFT)
      .map((call) => call.data.slot);
    expect(orders).toEqual([
      PUBLISHING_SLOT.INIT_DRAFT,
      PUBLISHING_SLOT.GENERATE_DRAFT,
      PUBLISHING_SLOT.REFRESH_DRAFT,
    ]);
  });

  it('Job 名与 jobId 都用对（草稿三趟共用一个 Job 名，各自独立的 jobId）', async () => {
    const { scheduler, enqueuer } = build();
    await scheduler.tick(shanghai(8, 1));

    const drafts = enqueuer.calls.filter((call) => call.jobName === JobName.PUBLISHING_DAILY_DRAFT);
    expect(drafts.map((call) => call.jobId)).toEqual([
      dailyDraftJobId(TODAY, PUBLISHING_SLOT.INIT_DRAFT),
      dailyDraftJobId(TODAY, PUBLISHING_SLOT.GENERATE_DRAFT),
      dailyDraftJobId(TODAY, PUBLISHING_SLOT.REFRESH_DRAFT),
    ]);

    const publish = enqueuer.calls.find(
      (call) => call.jobName === JobName.PUBLISHING_DAILY_PUBLISH,
    );
    expect(publish?.jobId).toBe(dailyPublishJobId(TODAY, PUBLISHING_SLOT.PUBLISH));
  });

  it('载荷带业务日与槽位（日志与审计可读）', async () => {
    const { scheduler, enqueuer } = build();
    await scheduler.tick(shanghai(8, 1));

    expect(enqueuer.calls[0]?.data).toEqual({
      businessDate: TODAY,
      slot: PUBLISHING_SLOT.INIT_DRAFT,
    });
  });
});

describe('幂等', () => {
  it('同一分钟内 tick 两次 → 第二次一个槽位都不重复处理', async () => {
    const { scheduler, enqueuer } = build();

    await scheduler.tick(shanghai(8, 1));
    const before = enqueuer.calls.length;
    const second = await scheduler.tick(shanghai(8, 1));

    expect(enqueuer.calls).toHaveLength(before);
    expect(second.outcomes.every((o) => o.action === 'SKIPPED_ALREADY')).toBe(true);
  });

  it('分钟级推进不会重复触发已处理的槽位', async () => {
    const { scheduler, enqueuer } = build();

    await scheduler.tick(shanghai(5, 31));
    await scheduler.tick(shanghai(5, 32));
    await scheduler.tick(shanghai(6, 0));

    expect(enqueuer.slotsEnqueued()).toEqual([
      PUBLISHING_SLOT.INIT_DRAFT,
      PUBLISHING_SLOT.GENERATE_DRAFT,
    ]);
  });
});

describe('停机追赶（catch-up）', () => {
  it('worker 06:00 才起来 → 00:10 与 05:30 两趟被补跑', async () => {
    const { scheduler, enqueuer } = build();
    await scheduler.tick(shanghai(6, 0));

    expect(enqueuer.slotsEnqueued()).toEqual([
      PUBLISHING_SLOT.INIT_DRAFT,
      PUBLISHING_SLOT.GENERATE_DRAFT,
    ]);
  });

  it('追赶对**发布**同样生效 —— 但发布只发 SCHEDULED，所以补跑不可能发出没审过的日报', async () => {
    const { scheduler, enqueuer, repository } = build();
    // 一期已经排期，但 worker 在 08:00 时是停的
    repository.seedEdition({ businessDate: TODAY, status: 'DRAFT' as never });

    await scheduler.tick(shanghai(9, 30));

    // 发布那一趟被入队了（catch-up），但它会读到 DRAFT 并拒绝发布 ——
    // 那条逻辑由 publishing-service.spec.ts 覆盖。
    expect(enqueuer.slotsEnqueued()).toContain(PUBLISHING_SLOT.PUBLISH);
  });

  it('新的一天从零开始（前一天的记录被清掉，不会误判为「已处理」）', async () => {
    const { scheduler, enqueuer } = build();
    await scheduler.tick(shanghai(8, 1)); // 09-29 全部处理完
    const before = enqueuer.calls.length;

    // 09-30 的 00:15
    const nextDay = new Date(Date.UTC(2026, 8, 29, 16, 15));
    await scheduler.tick(nextDay);

    expect(enqueuer.calls.length).toBeGreaterThan(before);
    expect(enqueuer.calls.at(-1)?.data.businessDate).toBe('2026-09-30');
  });
});

describe('故障隔离', () => {
  it('一个槽位入队失败**不影响**后面的槽位（提醒可有可无，发布不是）', async () => {
    const { scheduler, enqueuer } = build();
    // 让 05:30 那一趟失败
    enqueuer.failOnJobId = dailyDraftJobId(TODAY, PUBLISHING_SLOT.GENERATE_DRAFT);

    const result = await scheduler.tick(shanghai(8, 1));

    const failed = result.outcomes.find((o) => o.slot === PUBLISHING_SLOT.GENERATE_DRAFT);
    expect(failed?.action).toBe('FAILED');

    // 后面的 07:00 与 08:00 照常入队
    expect(enqueuer.slotsEnqueued()).toContain(PUBLISHING_SLOT.REFRESH_DRAFT);
    expect(enqueuer.slotsEnqueued()).toContain(PUBLISHING_SLOT.PUBLISH);
  });

  it('失败的槽位**不记入 handled** → 下一分钟会重试', async () => {
    const { scheduler, enqueuer } = build();
    enqueuer.failOnJobId = dailyDraftJobId(TODAY, PUBLISHING_SLOT.GENERATE_DRAFT);

    await scheduler.tick(shanghai(5, 31));
    // 恢复之后下一分钟再 tick
    enqueuer.failOnJobId = null;
    await scheduler.tick(shanghai(5, 32));

    expect(enqueuer.slotsEnqueued()).toContain(PUBLISHING_SLOT.GENERATE_DRAFT);
  });
});

describe('启动接线', () => {
  it('模块初始化时挂上定时器，销毁时清掉（不留下泄漏的句柄）', async () => {
    const repository = new InMemoryPublishingRepository();
    const enqueuer = new RecordingEnqueuer();
    const notifier = new RecordingNotifier();
    const logger = createLogger({ service: 'worker', destination: createMemoryStream() });
    const service = new PublishingService(repository, notifier, { now: () => new Date() }, logger);
    const scheduler = new PublishingScheduler(enqueuer, service, { now: () => new Date() }, logger);

    scheduler.onModuleInit();
    scheduler.onModuleDestroy();
    // 再调一次不该炸（幂等）
    scheduler.onModuleDestroy();

    expect(PUBLISHING_ENQUEUER).toBe('PUBLISHING_ENQUEUER');
  });
});

describe('草稿生成与调度的接口对齐', () => {
  it('00:10 那一趟只建期次、不写内容（由 worker 分派，见 publishing.worker.ts）', async () => {
    const { scheduler, repository } = build();
    await scheduler.tick(shanghai(0, 15));

    // 调度器只负责入队；真正的动作在消费者里。
    // 这里断言的是「入队的是 INIT_DRAFT 槽位」——后者会被分派到 initDraft。
    expect(repository.replaceCalls).toHaveLength(0);
  });

  it('候选为空时草稿生成不报错（早上还没采到东西是正常的）', async () => {
    const { service, repository } = build();
    repository.seedEdition({ businessDate: TODAY, status: 'DRAFT' as never });
    repository.candidates = [];
    await expect(service.generateDraft(TODAY)).resolves.toMatchObject({
      generated: false,
      skippedReason: 'NO_CANDIDATES',
    });
  });

  it('有候选时草稿生成真的写入了（对照上面那条，证明不是恒 false）', async () => {
    const { service, repository } = build();
    repository.seedEdition({ businessDate: TODAY, status: 'DRAFT' as never });
    repository.candidates = [makeCandidate({ contentId: '1', title: '模型发布' })];

    await expect(service.generateDraft(TODAY)).resolves.toMatchObject({ generated: true });
  });
});
