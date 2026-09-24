/**
 * AI 队列消费者的守卫 —— 重点是**按失败原因决定重试几次**（`docs/13`）。
 *
 * 这张表是整条流水线成本控制的闸门：
 *
 * ```text
 * timeout / 429 / 5xx   3 次
 * schema invalid        1 次
 * unsupported           不 retry
 * 凭据错 / 未配置 / 预算耗尽 / 内容不存在 / 未知错误   不 retry
 * ```
 *
 * 判错的后果是双向的：把永久失败当瞬时失败 → 同一份坏 key 被重试 3 次、
 * 把额度烧光；把瞬时失败当永久 → 内容永远拿不到分，而且没人知道。
 *
 * 真实 Redis 上的端到端次数由 `ai-queue.integration.spec.ts` 再验一遍
 * （含 `attemptsMade` 语义的验证 —— 见 `ai.worker.ts` 文件头的说明）。
 */

import { describe, expect, it } from 'vitest';
import { UnrecoverableError } from 'bullmq';
import { AiTaskType } from '@signal/contracts';
import { createLogger } from '@signal/logger';
import { createMemoryStream } from '@signal/test-utils';
import {
  AiQueueWorker,
  contentIdOfJobData,
  failureKindOf,
  retryDecision,
  shouldStopRetrying,
  taskTypeOfJobName,
} from '../src/jobs/ai/ai.worker';
import {
  aiBudgetExceededError,
  aiContentNotFoundError,
  aiNotConfiguredError,
  aiPermanentError,
  aiResponseInvalidError,
  aiTaskNotImplementedError,
  aiTaskUnsupportedError,
  aiTransientError,
  aiUnauthorizedError,
} from '../src/jobs/ai/ai.errors';
import type { AiTaskOutcome } from '../src/jobs/ai/ai.service';
import type { AiFailureKind } from '../src/jobs/ai/ai.types';

const TRANSIENT_ERRORS = {
  timeout: aiTransientError({ safeMessage: 'timeout' }),
  rateLimited: aiTransientError({ safeMessage: 'too many requests', upstreamStatus: 429 }),
  serverError: aiTransientError({ safeMessage: 'boom', upstreamStatus: 503 }),
};

const NO_RETRY_ERRORS = {
  unauthorized: aiUnauthorizedError(401),
  notConfigured: aiNotConfiguredError(['AI_DEFAULT_BASE_URL']),
  budget: aiBudgetExceededError({ taskType: 'SCORE', spentUsd: 5, budgetUsd: 5 }),
  contentNotFound: aiContentNotFoundError('42'),
  unsupportedProvider: aiTaskUnsupportedError('endpoint rejects response_format'),
  unsupportedTask: aiTaskNotImplementedError('DAILY_DRAFT'),
  permanent: aiPermanentError({ safeMessage: 'bad request', upstreamStatus: 400 }),
};

describe('retryDecision 表', () => {
  it('TRANSIENT 在第 1、2 次失败后继续，第 3 次失败后停（共 3 次尝试）', () => {
    expect(retryDecision('TRANSIENT', 1)).toBe('RETRY');
    expect(retryDecision('TRANSIENT', 2)).toBe('RETRY');
    expect(retryDecision('TRANSIENT', 3)).toBe('STOP');
    expect(retryDecision('TRANSIENT', 4)).toBe('STOP');
  });

  it('SCHEMA_INVALID 第 1 次失败就停（共 1 次尝试，与契约 attempts=1 一致）', () => {
    expect(retryDecision('SCHEMA_INVALID', 1)).toBe('STOP');
  });

  it('UNSUPPORTED 立即停', () => {
    expect(retryDecision('UNSUPPORTED', 1)).toBe('STOP');
  });

  it('其余分类全部立即停', () => {
    for (const kind of [
      'NOT_CONFIGURED',
      'UNAUTHORIZED',
      'BUDGET_EXCEEDED',
      'CONTENT_NOT_FOUND',
      'PERMANENT',
    ] satisfies AiFailureKind[]) {
      expect(retryDecision(kind, 1)).toBe('STOP');
    }
  });

  it('分类覆盖完整（新增 kind 却忘了给策略时这条会红）', () => {
    for (const kind of Object.keys(NO_RETRY_ERRORS)) {
      expect(() => retryDecision(failureKindOf((NO_RETRY_ERRORS as never)[kind]), 1)).not.toThrow();
    }
  });
});

describe('错误分类', () => {
  it('瞬时错误被认成 TRANSIENT', () => {
    for (const error of Object.values(TRANSIENT_ERRORS)) {
      expect(failureKindOf(error)).toBe('TRANSIENT');
    }
  });

  it('不重试的错误各自被认成正确的 kind', () => {
    expect(failureKindOf(NO_RETRY_ERRORS.unauthorized)).toBe('UNAUTHORIZED');
    expect(failureKindOf(NO_RETRY_ERRORS.notConfigured)).toBe('NOT_CONFIGURED');
    expect(failureKindOf(NO_RETRY_ERRORS.budget)).toBe('BUDGET_EXCEEDED');
    expect(failureKindOf(NO_RETRY_ERRORS.contentNotFound)).toBe('CONTENT_NOT_FOUND');
    expect(failureKindOf(NO_RETRY_ERRORS.permanent)).toBe('PERMANENT');
    expect(failureKindOf(NO_RETRY_ERRORS.unsupportedProvider)).toBe('UNSUPPORTED');
    expect(failureKindOf(NO_RETRY_ERRORS.unsupportedTask)).toBe('UNSUPPORTED');
  });

  it('裸 Error / 非 Error 一律按 PERMANENT（不重试）', () => {
    expect(failureKindOf(new Error('boom'))).toBe('PERMANENT');
    expect(failureKindOf('字符串')).toBe('PERMANENT');
    expect(failureKindOf(null)).toBe('PERMANENT');
  });

  it('shouldStopRetrying 综合两者', () => {
    expect(shouldStopRetrying(TRANSIENT_ERRORS.timeout, 1)).toBe(false);
    expect(shouldStopRetrying(TRANSIENT_ERRORS.timeout, 3)).toBe(true);
    expect(shouldStopRetrying(NO_RETRY_ERRORS.unauthorized, 1)).toBe(true);
  });
});

describe('job 名与载荷解析', () => {
  it('ai.translate → TRANSLATE，ai.classify-score → SCORE', () => {
    expect(taskTypeOfJobName('ai.translate')).toBe(AiTaskType.TRANSLATE);
    expect(taskTypeOfJobName('ai.classify-score')).toBe(AiTaskType.SCORE);
  });

  it('别的队列的 job 名一律拒绝（挂错队列必须炸，不能静默跑错任务）', () => {
    expect(() => taskTypeOfJobName('collector.fetch-source')).toThrow(/Unexpected job name/);
    expect(() => taskTypeOfJobName('content.normalize')).toThrow(/Unexpected job name/);
  });

  it('contentId 必须是十进制字符串', () => {
    expect(contentIdOfJobData({ contentId: '42' })).toBe('42');
    expect(() => contentIdOfJobData({ contentId: 42 })).toThrow(/decimal string/);
    expect(() => contentIdOfJobData({})).toThrow(/decimal string/);
    expect(() => contentIdOfJobData(null)).toThrow(/decimal string/);
    expect(() => contentIdOfJobData({ contentId: '4; DROP TABLE' })).toThrow(/decimal string/);
  });
});

/* ------------------------------------------------------------------ */
/* handler                                                             */
/* ------------------------------------------------------------------ */

function buildWorker(
  runTask: (input: { taskType: AiTaskType; contentId: string }) => Promise<AiTaskOutcome>,
) {
  const stream = createMemoryStream();
  const worker = new AiQueueWorker({
    service: { runTask } as never,
    // handle() 不接触 Redis；这些字段只是构造需要。
    connection: { host: '127.0.0.1', port: 1 },
    logger: createLogger({ service: 'worker', destination: stream }),
  });
  return { worker, stream };
}

const FAKE_OUTCOME = { contentId: '42', taskType: AiTaskType.SCORE } as AiTaskOutcome;

describe('handler 重试收敛', () => {
  it('成功时原样返回结果', async () => {
    const { worker } = buildWorker(async () => FAKE_OUTCOME);
    await expect(
      worker.handle({ name: 'ai.classify-score', data: { contentId: '42' }, attemptsMade: 0 }),
    ).resolves.toBe(FAKE_OUTCOME);
  });

  it('第 1 次瞬时失败 → 抛原始错误（BullMQ 会重试）', async () => {
    const { worker } = buildWorker(async () => {
      throw TRANSIENT_ERRORS.timeout;
    });

    await expect(
      worker.handle({ name: 'ai.classify-score', data: { contentId: '42' }, attemptsMade: 0 }),
    ).rejects.toBe(TRANSIENT_ERRORS.timeout);
  });

  it('第 3 次瞬时失败 → 抛 UnrecoverableError（终止重试）', async () => {
    const { worker } = buildWorker(async () => {
      throw TRANSIENT_ERRORS.serverError;
    });

    await expect(
      worker.handle({ name: 'ai.classify-score', data: { contentId: '42' }, attemptsMade: 2 }),
    ).rejects.toBeInstanceOf(UnrecoverableError);
  });

  it('凭据错误在第 1 次就终止重试（不烧额度）', async () => {
    const { worker } = buildWorker(async () => {
      throw NO_RETRY_ERRORS.unauthorized;
    });

    await expect(
      worker.handle({ name: 'ai.classify-score', data: { contentId: '42' }, attemptsMade: 0 }),
    ).rejects.toBeInstanceOf(UnrecoverableError);
  });

  it('schema 非法在第 1 次就终止重试（契约 attempts=1）', async () => {
    const { worker } = buildWorker(async () => {
      throw aiResponseInvalidError('not json');
    });

    await expect(
      worker.handle({ name: 'ai.classify-score', data: { contentId: '42' }, attemptsMade: 0 }),
    ).rejects.toBeInstanceOf(UnrecoverableError);
  });

  it('未知异常不重试（避免把编程错误反复重放）', async () => {
    const { worker } = buildWorker(async () => {
      throw new Error('一个没人分类过的错误');
    });

    await expect(
      worker.handle({ name: 'ai.classify-score', data: { contentId: '42' }, attemptsMade: 0 }),
    ).rejects.toBeInstanceOf(UnrecoverableError);
  });

  it('UnrecoverableError 的消息里带上 kind 与原错误（便于 failedReason 排查）', async () => {
    const { worker } = buildWorker(async () => {
      throw NO_RETRY_ERRORS.budget;
    });

    await expect(
      worker.handle({ name: 'ai.classify-score', data: { contentId: '42' }, attemptsMade: 0 }),
    ).rejects.toThrow(/BUDGET_EXCEEDED/);
  });

  it('job 名非法时不调用 service（不会把别的任务当 AI 任务跑）', async () => {
    let called = false;
    const { worker } = buildWorker(async () => {
      called = true;
      return FAKE_OUTCOME;
    });

    await expect(
      worker.handle({ name: 'content.dedup', data: { contentId: '42' }, attemptsMade: 0 }),
    ).rejects.toThrow(/Unexpected job name/);
    expect(called).toBe(false);
  });

  it('失败会打出带 failureKind 与 decision 的日志', async () => {
    const { worker, stream } = buildWorker(async () => {
      throw TRANSIENT_ERRORS.rateLimited;
    });

    await expect(
      worker.handle({ name: 'ai.classify-score', data: { contentId: '42' }, attemptsMade: 0 }),
    ).rejects.toThrow();

    const record = stream.records().find((entry) => String(entry.msg).includes('ai job failed'));
    expect(record).toMatchObject({
      failureKind: 'TRANSIENT',
      decision: 'RETRY',
      contentId: '42',
      attempt: 1,
    });
  });
});
