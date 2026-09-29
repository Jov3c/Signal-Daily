/**
 * `publishing` 队列契约的守卫。
 *
 * ── 这个文件存在的第一个理由：**契约的 `JobId.dailyDraft` 是坏的** ──
 * 它产出 2 段（`daily-draft:2026-09-29`），而 `bullmq@5` 要求含 `:` 的
 * 自定义 jobId **恰好 3 段**，否则 `queue.add()` **同步抛错**。
 * 这条由 Agent 06 的独立审查发现（CCR 第 0 项），Agent 05 重申过一次，
 * 至今无人裁决。本模块因此自造了 3 段 builder。
 *
 * 下面有一条**把契约仍然坏着这件事钉住**的用例：如果将来有人把契约修好了，
 * 那条会红 —— 那时应当删掉它，并把本模块切回契约 builder。
 * 「契约坏了」是一个**会被修复的状态**，不是永久事实，
 * 所以它值得一条会过期的守卫来提醒。
 *
 * ⚠ 第二条规矩来自 Agent 06 的 P0 教训：**集成测试自己拼 jobId 字面量、
 * 从来没调用过 builder**，于是 builder 坏了也全绿。
 * 这里所有断言都**调用真的 builder**。
 */

import { describe, expect, it } from 'vitest';
import {
  DAILY_TARGET_PUBLISH_HOUR,
  JobId,
  JobName,
  JOB_TO_QUEUE,
  PUBLISHING_RETRY,
  QueueName,
} from '@signal/contracts';
import {
  BULLMQ_JOBID_SEGMENTS,
  PUBLISHING_JOB_OPTIONS,
  PUBLISHING_SLOT,
  PUBLISHING_SLOTS_IN_ORDER,
  SLOT_JOB_NAME,
  SLOT_TIME,
  assertPublishingQueueContract,
  dailyDraftJobId,
  publishingQueueProblems,
  dailyPublishJobId,
  isBullMqAcceptableJobId,
  isPublishingJobData,
} from '../src/jobs/publishing/queue';

const DATE = '2026-09-29';

describe('JobId 必须是 BullMQ 能接受的 3 段', () => {
  it('两个 builder 的产物都是 3 段', () => {
    for (const slot of Object.values(PUBLISHING_SLOT)) {
      const draft = dailyDraftJobId(DATE, slot);
      const publish = dailyPublishJobId(DATE, slot);

      expect(draft.split(':')).toHaveLength(BULLMQ_JOBID_SEGMENTS);
      expect(publish.split(':')).toHaveLength(BULLMQ_JOBID_SEGMENTS);
      expect(isBullMqAcceptableJobId(draft), draft).toBe(true);
      expect(isBullMqAcceptableJobId(publish), publish).toBe(true);
    }
  });

  it('同一参数重复调用得到**同一个** jobId（幂等的前提）', () => {
    expect(dailyDraftJobId(DATE, PUBLISHING_SLOT.GENERATE_DRAFT)).toBe(
      dailyDraftJobId(DATE, PUBLISHING_SLOT.GENERATE_DRAFT),
    );
  });

  it('⚠ **同一天的三个草稿槽位必须得到三个不同的 jobId**', () => {
    // 这是本模块自造 builder 的**根本理由**：docs/10 在同一个业务日上有
    // 两次（现在是三次）草稿生成。如果第三段不区分它们，
    // BullMQ 会把第二次入队当成重复任务**直接丢掉** ——
    // 07:00 的刷新永远不会执行，而且不报任何错。
    const ids = [
      dailyDraftJobId(DATE, PUBLISHING_SLOT.INIT_DRAFT),
      dailyDraftJobId(DATE, PUBLISHING_SLOT.GENERATE_DRAFT),
      dailyDraftJobId(DATE, PUBLISHING_SLOT.REFRESH_DRAFT),
    ];

    expect(new Set(ids).size).toBe(3);
  });

  it('不同业务日的 jobId 不同', () => {
    expect(dailyDraftJobId('2026-09-29', PUBLISHING_SLOT.GENERATE_DRAFT)).not.toBe(
      dailyDraftJobId('2026-09-30', PUBLISHING_SLOT.GENERATE_DRAFT),
    );
  });

  it('**契约的 JobId.dailyDraft 仍然是坏的**（修好之后请删掉这条并切回契约）', () => {
    const contractJobId = JobId.dailyDraft(DATE);

    expect(contractJobId).toBe('daily-draft:2026-09-29');
    expect(contractJobId.split(':')).toHaveLength(2);
    // 这正是 BullMQ 会拒绝的形态（`Custom Id cannot contain :`）。
    expect(isBullMqAcceptableJobId(contractJobId)).toBe(false);

    // 而我们的 builder 不是它 —— 这一条防止「顺手改回契约 builder」。
    expect(dailyDraftJobId(DATE, PUBLISHING_SLOT.GENERATE_DRAFT)).not.toBe(contractJobId);
  });
});

describe('槽位与 docs/10 的调度表一致', () => {
  it('五个槽位，按时间先后', () => {
    expect(PUBLISHING_SLOTS_IN_ORDER).toHaveLength(5);
    const minutes = PUBLISHING_SLOTS_IN_ORDER.map((slot) => {
      const { hour, minute } = SLOT_TIME[slot];
      return hour * 60 + minute;
    });
    expect([...minutes].sort((a, b) => a - b)).toEqual(minutes);
  });

  it('时刻逐条对齐 docs/10（00:10 / 05:30 / 07:00 / 07:30 / 08:00）', () => {
    expect(SLOT_TIME[PUBLISHING_SLOT.INIT_DRAFT]).toEqual({ hour: 0, minute: 10 });
    expect(SLOT_TIME[PUBLISHING_SLOT.GENERATE_DRAFT]).toEqual({ hour: 5, minute: 30 });
    expect(SLOT_TIME[PUBLISHING_SLOT.REFRESH_DRAFT]).toEqual({ hour: 7, minute: 0 });
    expect(SLOT_TIME[PUBLISHING_SLOT.REVIEW_REMINDER]).toEqual({ hour: 7, minute: 30 });
    expect(SLOT_TIME[PUBLISHING_SLOT.PUBLISH]).toEqual({ hour: 8, minute: 0 });
  });

  it('⚠ 发布槽的时刻**必须**等于契约的目标发布时刻（否则「排期」与「发布」会脱节）', () => {
    // 这条钉住的是 `apps/api` 侧移除「自定义 scheduledAt」之后仍然成立的前提：
    // 排期落库的 `scheduledAt`（api 从 DAILY_TARGET_PUBLISH_HOUR 算）
    // 与 worker 真正发布的时刻（本表的 PUBLISH 槽）**必须来自同一个常量**。
    // 两边各自硬编码 08:00 的话，改常量就会静默脱节 ——
    // 那时 `scheduledAt` 会显示一个与真实发布时刻不同的时间，
    // 而两个模块的测试都还是绿的。
    expect(SLOT_TIME[PUBLISHING_SLOT.PUBLISH]).toEqual({
      hour: DAILY_TARGET_PUBLISH_HOUR,
      minute: 0,
    });
  });

  it('槽位标识是**补零的字符串**（`0530` 与 `530` 在 jobId 里是两个不同的键）', () => {
    for (const slot of Object.values(PUBLISHING_SLOT)) {
      expect(slot).toMatch(/^\d{4}$/);
    }
  });

  it('产生 Job 的槽位都挂在 publishing 队列（docs/13）', () => {
    for (const [slot, jobName] of Object.entries(SLOT_JOB_NAME)) {
      if (jobName === undefined) continue;
      expect(JOB_TO_QUEUE[jobName as keyof typeof JOB_TO_QUEUE], slot).toBe(QueueName.PUBLISHING);
    }
  });

  it('⚠ 07:30 那一趟**刻意不入队**（docs/13 没有「日报提醒」这个 Job 名）', () => {
    expect(SLOT_JOB_NAME[PUBLISHING_SLOT.REVIEW_REMINDER]).toBeUndefined();
  });

  it('入队的 Job 名都在契约的 10 个之内（没有发明新 Job）', () => {
    const contractJobNames = Object.values(JobName) as string[];
    for (const jobName of Object.values(SLOT_JOB_NAME)) {
      if (jobName === undefined) continue;
      expect(contractJobNames).toContain(jobName);
    }
  });

  it('草稿三趟共用一个 Job 名，发布单独一个', () => {
    expect(SLOT_JOB_NAME[PUBLISHING_SLOT.INIT_DRAFT]).toBe(JobName.PUBLISHING_DAILY_DRAFT);
    expect(SLOT_JOB_NAME[PUBLISHING_SLOT.GENERATE_DRAFT]).toBe(JobName.PUBLISHING_DAILY_DRAFT);
    expect(SLOT_JOB_NAME[PUBLISHING_SLOT.REFRESH_DRAFT]).toBe(JobName.PUBLISHING_DAILY_DRAFT);
    expect(SLOT_JOB_NAME[PUBLISHING_SLOT.PUBLISH]).toBe(JobName.PUBLISHING_DAILY_PUBLISH);
  });
});

describe('入队选项取契约值', () => {
  it('attempts 与 docs/13 的 Publishing 重试策略一致', () => {
    expect(PUBLISHING_JOB_OPTIONS.attempts).toBe(PUBLISHING_RETRY.attempts);
    expect(PUBLISHING_JOB_OPTIONS.attempts).toBe(3);
  });

  it('`removeOnFail: false` —— docs/13 的 Dead Letter 要求失败的任务被保留', () => {
    expect(PUBLISHING_JOB_OPTIONS.removeOnFail).toBe(false);
  });
});

describe('启动期自检', () => {
  it('当前实现通过', () => {
    expect(() => assertPublishingQueueContract()).not.toThrow();
  });

  it('**有牙齿**：把 jobId 换成契约那个坏形态，自检必须报错', () => {
    // 直接对判定函数下手，验证「3 段」这条规矩真的在起作用 ——
    // 而不是只验证「当前的常量恰好通过」。
    expect(isBullMqAcceptableJobId(JobId.dailyDraft(DATE))).toBe(false);
    expect(isBullMqAcceptableJobId('daily-draft:2026-09-29:0530')).toBe(true);
    // 4 段同样会被 BullMQ 拒绝
    expect(isBullMqAcceptableJobId('daily-draft:2026-09-29:0530:extra')).toBe(false);
    // 不含 `:` 的 id 不受这条规则约束
    expect(isBullMqAcceptableJobId('nodots')).toBe(true);
  });

  /**
   * ⚠ 这一组是 §23 独立审查要求的：原先自检的测试**只有 `not.toThrow()`**，
   * 那是一条没有牙齿的断言 —— 把函数体掏空、或删掉里面任何一条检查，
   * 它**仍然是绿的**。现在喂**坏输入**，断言它**真的会报错**。
   */
  it('有牙齿：jobId 换成 2 段契约形态 → 问题清单里有它', () => {
    const problems = publishingQueueProblems({
      jobIdSamples: [JobId.dailyDraft(DATE)],
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/2 segments|BullMQ needs 3/);
  });

  it('有牙齿：Job 名挂到别的队列 → 问题清单里有它', () => {
    const problems = publishingQueueProblems({
      // 把草稿作业挂到 ai 队列（真实会犯的错）
      slotJobName: { [PUBLISHING_SLOT.GENERATE_DRAFT]: JobName.AI_TRANSLATE },
    });
    expect(problems.some((problem) => problem.includes('not publishing'))).toBe(true);
  });

  it('有牙齿：attempts 偏离契约重试策略 → 问题清单里有它', () => {
    const problems = publishingQueueProblems({ attempts: 1 });
    expect(problems.some((problem) => problem.includes('drifted'))).toBe(true);
  });

  it('干净输入 → 没有问题（对照上面三条，证明不是恒报错）', () => {
    expect(publishingQueueProblems()).toEqual([]);
    expect(publishingQueueProblems({ attempts: PUBLISHING_RETRY.attempts })).toEqual([]);
  });
});

describe('Job 载荷校验', () => {
  it('合法载荷通过', () => {
    expect(isPublishingJobData({ businessDate: DATE, slot: '0530' })).toBe(true);
  });

  it('业务日格式不对 → 拒（重试也没用，是入队方写错了）', () => {
    expect(isPublishingJobData({ businessDate: '2026/09/29', slot: '0530' })).toBe(false);
    expect(isPublishingJobData({ businessDate: 'tomorrow', slot: '0530' })).toBe(false);
  });

  it('槽位不在表里 → 拒', () => {
    expect(isPublishingJobData({ businessDate: DATE, slot: '9999' })).toBe(false);
  });

  it('非对象 / 缺字段 → 拒', () => {
    for (const bad of [null, undefined, 'x', 42, [], {}, { businessDate: DATE }]) {
      expect(isPublishingJobData(bad)).toBe(false);
    }
  });
});
