import { describe, expect, it } from 'vitest';
import {
  AI_RETRY,
  COLLECTOR_RETRY,
  JOB_NAMES,
  JOB_TO_QUEUE,
  JobId,
  JobName,
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

  it('JobId 幂等格式', () => {
    expect(JobId.collectorFetchSource('42', '2026-09-23T10')).toBe('collector:42:2026-09-23T10');
    expect(JobId.normalize('99')).toBe('normalize:99');
    expect(JobId.aiScore('7', 'v3')).toBe('ai-score:7:v3');
    expect(JobId.dailyDraft('2026-09-23')).toBe('daily-draft:2026-09-23');
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
