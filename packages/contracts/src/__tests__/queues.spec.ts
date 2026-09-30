import { describe, expect, it } from 'vitest';
import {
  AI_RETRY,
  COLLECTOR_RETRY,
  JOB_NAMES,
  JOB_TO_QUEUE,
  BULLMQ_JOBID_SEGMENTS,
  JobId,
  JobName,
  assertAllJobIdBuildersAreAcceptable,
  isBullMqAcceptableJobId,
  PUBLISHING_RETRY,
  QUEUE_CONCURRENCY,
  QUEUE_NAMES,
  QueueName,
} from '../index';

describe('Queue / Job 契约（docs/13）', () => {
  it('固定 Queue 名，不得有近义 Queue', () => {
    expect(QUEUE_NAMES).toEqual([
      'collector',
      'content-pipeline',
      'ai',
      'publishing',
      'notification',
      'maintenance',
    ]);
  });

  it('固定 Job 名', () => {
    expect(JOB_NAMES).toEqual([
      'collector.fetch-source',
      'content.normalize',
      'content.dedup',
      'content.event-cluster',
      'ai.translate',
      'ai.classify-score',
      'publishing.daily-draft',
      'publishing.daily-publish',
      'notification.admin-email',
      'maintenance.cleanup',
    ]);
  });

  it('每个 Job 都映射到已登记的 Queue', () => {
    for (const job of JOB_NAMES) {
      expect(QUEUE_NAMES).toContain(JOB_TO_QUEUE[job]);
    }
    expect(JOB_TO_QUEUE[JobName.COLLECTOR_FETCH_SOURCE]).toBe(QueueName.COLLECTOR);
    expect(JOB_TO_QUEUE[JobName.AI_CLASSIFY_SCORE]).toBe(QueueName.AI);
    expect(JOB_TO_QUEUE[JobName.PUBLISHING_DAILY_PUBLISH]).toBe(QueueName.PUBLISHING);
  });

  it('JobId 幂等格式（**每个 builder 都恰好 3 段**）', () => {
    expect(JobId.collectorFetchSource('42', '2026-09-23T10')).toBe('collector:42:2026-09-23T10');
    expect(JobId.normalize('99', 'v1')).toBe('normalize:99:v1');
    expect(JobId.aiScore('7', 'v3')).toBe('ai-score:7:v3');
    expect(JobId.aiTranslate('7', 'v3')).toBe('translate:7:v3');
    expect(JobId.dailyDraft('2026-09-23', '0530')).toBe('daily-draft:2026-09-23:0530');
    expect(JobId.dailyPublish('2026-09-23', '0800')).toBe('daily-publish:2026-09-23:0800');
  });

  /**
   * ⚠ **这条守卫的存在理由值得单独写下来。**
   *
   * 契约原先有 2/4 个 builder 产出 2 段，而 `bullmq@5` 对含 `:` 的 jobId
   * 要求恰好 3 段 —— 「照着契约用」等于「入队必炸」。这件事被**四个 Agent**
   * 各自发现、各自绕过了一遍（06 提 CCR → 05 重申 → 08 自造并补真 Redis 证据
   * → 10 再记录），而**契约自己的测试一直是绿的**（因为它断言的就是那两段）。
   *
   * 这条断言**对着每一个 builder** 验它可以被 BullMQ 接受 ——
   * 将来再加 builder 而忘了段数，它会立刻红。
   */
  it('⚠ 每一个 builder 的产物都能被 BullMQ 接受（段数不变式）', () => {
    // 逐条列出（不遍历 `JobId` 对象）：遍历会漏掉「新加了一个 builder 但
    // 忘了加进样本」的情况，而这里**新增 builder 必须显式加一行**才生效……
    expect(isBullMqAcceptableJobId(JobId.collectorFetchSource('1', 'w'))).toBe(true);
    expect(isBullMqAcceptableJobId(JobId.normalize('1', 'v1'))).toBe(true);
    expect(isBullMqAcceptableJobId(JobId.aiScore('1', 'v1'))).toBe(true);
    expect(isBullMqAcceptableJobId(JobId.aiTranslate('1', 'v1'))).toBe(true);
    expect(isBullMqAcceptableJobId(JobId.dailyDraft('2026-09-30', '0530'))).toBe(true);
    expect(isBullMqAcceptableJobId(JobId.dailyPublish('2026-09-30', '0800'))).toBe(true);

    // 覆盖完整性：`JobId` 上的键**一个都不能漏** —— 上面那 6 行是手写的，
    // 漏一个就等于漏一条 builder 没被守卫。
    expect(Object.keys(JobId).sort()).toEqual([
      'aiScore',
      'aiTranslate',
      'collectorFetchSource',
      'dailyDraft',
      'dailyPublish',
      'normalize',
    ]);

    // 不变式本身可以被调用（不是死代码），且当前实现通过
    expect(() => assertAllJobIdBuildersAreAcceptable()).not.toThrow();
  });

  it('段数判定有牙齿：2 段 / 4 段都算不可接受', () => {
    expect(BULLMQ_JOBID_SEGMENTS).toBe(3);
    expect(isBullMqAcceptableJobId('normalize:1')).toBe(false);
    expect(isBullMqAcceptableJobId('daily-draft:2026-09-30')).toBe(false);
    expect(isBullMqAcceptableJobId('a:b:c:d')).toBe(false);
    // 不含 `:` 的不受这条规则约束（BullMQ 只对含 `:` 的做这个检查）
    expect(isBullMqAcceptableJobId('nodots')).toBe(true);
  });

  it('初始并发度', () => {
    expect(QUEUE_CONCURRENCY[QueueName.COLLECTOR]).toBe(5);
    expect(QUEUE_CONCURRENCY[QueueName.CONTENT_PIPELINE]).toBe(8);
    expect(QUEUE_CONCURRENCY[QueueName.AI]).toBe(3);
    expect(QUEUE_CONCURRENCY[QueueName.PUBLISHING]).toBe(1);
    expect(QUEUE_CONCURRENCY[QueueName.NOTIFICATION]).toBe(2);
  });

  it('重试策略：Collector 3 次，AI schema invalid 只 1 次、unsupported 不重试', () => {
    expect(COLLECTOR_RETRY.attempts).toBe(3);
    expect(COLLECTOR_RETRY.backoff?.type).toBe('exponential');
    expect(AI_RETRY.transient.attempts).toBe(3);
    expect(AI_RETRY.schemaInvalid.attempts).toBe(1);
    expect(AI_RETRY.unsupported.attempts).toBe(0);
    expect(PUBLISHING_RETRY.attempts).toBe(3);
  });
});
