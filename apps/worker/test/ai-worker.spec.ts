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
import {
  AiTaskType,
  DEAD_LETTER_JOB_RUN_STATUS,
  defaultHttpStatusForCode,
  DomainErrorCode,
  isValidErrorCode,
  JobName,
  JobRunStatus,
} from '@signal/contracts';
import { createLogger } from '@signal/logger';
import { createMemoryStream } from '@signal/test-utils';
import { AI_FAILURE_KINDS, FAILURE_KIND_TO_ERROR_CODE } from '../src/jobs/ai/ai.types';
import type { JobRunRecorder, RecordJobRunInput } from '../src/jobs/ai/job-run.repository';
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
  retryPolicyFor,
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

  it('每个失败分类都有**已登记**的错误码与重试策略', () => {
    // ⚠ 第一版这条是重言式：它遍历的是本地 `NO_RETRY_ERRORS` 对象的键，
    // 断言 retryDecision 不抛错 —— 永远为真（独立审查 P3 指出）。
    // 现在断言的是真正的不变量：分类集合 ↔ 错误码映射表**双向**一致，
    // 且每个码都在契约的 `DomainErrorCode` 里登记过。
    const registeredCodes = Object.values(DomainErrorCode);

    for (const kind of AI_FAILURE_KINDS) {
      expect(Object.hasOwn(FAILURE_KIND_TO_ERROR_CODE, kind), `${kind} 缺错误码`).toBe(true);
      expect(registeredCodes, `${kind} 的码没在契约里登记`).toContain(
        FAILURE_KIND_TO_ERROR_CODE[kind],
      );
      expect(() => retryPolicyFor(kind)).not.toThrow();
    }

    // 反向：映射表不能有分类集合之外的键
    expect(Object.keys(FAILURE_KIND_TO_ERROR_CODE).sort()).toEqual([...AI_FAILURE_KINDS].sort());
  });

  it('每个分类产生的错误码都是合法形状且能映射 HTTP status', () => {
    for (const kind of AI_FAILURE_KINDS) {
      const code = FAILURE_KIND_TO_ERROR_CODE[kind];
      expect(isValidErrorCode(code)).toBe(true);
      expect(typeof defaultHttpStatusForCode(code)).toBe('number');
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
  it('用 JobName 常量调用能正确映射（生产者与消费者必须同源）', () => {
    // ⚠ 用 `JobName.*` 而不是裸字面量：契约改名时，生产者（queue.ts）
    // 与消费者（ai.worker.ts）必须一起改。消费者写死字面量的话，
    // 改名会变成「我自己的队列拒收我自己的 job」（独立审查 P4）。
    expect(taskTypeOfJobName(JobName.AI_TRANSLATE)).toBe(AiTaskType.TRANSLATE);
    expect(taskTypeOfJobName(JobName.AI_CLASSIFY_SCORE)).toBe(AiTaskType.SCORE);
  });

  it('契约里的 Job 名就是这两个（改名会在这里暴露）', () => {
    expect(JobName.AI_TRANSLATE).toBe('ai.translate');
    expect(JobName.AI_CLASSIFY_SCORE).toBe('ai.classify-score');
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

/** 记录 JobRun 写入的替身。 */
class RecordingJobRuns implements JobRunRecorder {
  readonly records: RecordJobRunInput[] = [];

  async record(input: RecordJobRunInput): Promise<void> {
    this.records.push(input);
  }

  statuses(): string[] {
    return this.records.map((record) => String(record.status));
  }
}

function buildWorker(
  runTask: (input: { taskType: AiTaskType; contentId: string }) => Promise<AiTaskOutcome>,
  recorder?: JobRunRecorder,
) {
  const stream = createMemoryStream();
  const worker = new AiQueueWorker({
    service: { runTask } as never,
    // handle() 不接触 Redis；这些字段只是构造需要。
    connection: { host: '127.0.0.1', port: 1 },
    logger: createLogger({ service: 'worker', destination: stream }),
    ...(recorder === undefined ? {} : { recorder }),
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

/* ------------------------------------------------------------------ */
/* Dead Letter（docs/13）                                              */
/* ------------------------------------------------------------------ */

describe('JobRun 落库（docs/13 的 Dead Letter 契约）', () => {
  it('最终失败写 DEAD（运维面板据此发现并人工重试）', async () => {
    // ⚠ 独立审查 P3：第一版**完全没有写 job_runs**，
    // 于是 ai 队列最终失败的 job 只留下 BullMQ 记录与一行日志，
    // Agent 11 无法按契约从 `job_runs` 看到 DEAD 的 AI 任务。
    const recorder = new RecordingJobRuns();
    const { worker } = buildWorker(async () => {
      throw NO_RETRY_ERRORS.unauthorized;
    }, recorder);

    await expect(
      worker.handle({
        id: 'ai-score:42:v1',
        name: JobName.AI_CLASSIFY_SCORE,
        data: { contentId: '42' },
        attemptsMade: 0,
      }),
    ).rejects.toBeInstanceOf(UnrecoverableError);

    expect(recorder.statuses()).toEqual([DEAD_LETTER_JOB_RUN_STATUS]);
    expect(recorder.records[0]).toMatchObject({
      jobType: JobName.AI_CLASSIFY_SCORE,
      jobKey: 'ai-score:42:v1',
      attempts: 1,
      errorCode: 'AI_PROVIDER_UNAUTHORIZED',
    });
  });

  it('**中间**失败写 FAILED 而不是 DEAD（还要重试，不算死信）', async () => {
    const recorder = new RecordingJobRuns();
    const { worker } = buildWorker(async () => {
      throw TRANSIENT_ERRORS.timeout;
    }, recorder);

    await expect(
      worker.handle({
        name: JobName.AI_CLASSIFY_SCORE,
        data: { contentId: '42' },
        attemptsMade: 0,
      }),
    ).rejects.toThrow();

    expect(recorder.statuses()).toEqual([JobRunStatus.FAILED]);
  });

  it('成功写 SUCCEEDED', async () => {
    const recorder = new RecordingJobRuns();
    const { worker } = buildWorker(async () => FAKE_OUTCOME, recorder);

    await worker.handle({
      name: JobName.AI_TRANSLATE,
      data: { contentId: '42' },
      attemptsMade: 0,
    });

    expect(recorder.statuses()).toEqual([JobRunStatus.SUCCEEDED]);
    expect(recorder.records[0]).toMatchObject({ errorCode: null, attempts: 1 });
  });

  it('没有 jobId 时 jobKey 为 null（不伪造幂等键）', async () => {
    const recorder = new RecordingJobRuns();
    const { worker } = buildWorker(async () => FAKE_OUTCOME, recorder);

    await worker.handle({
      name: JobName.AI_TRANSLATE,
      data: { contentId: '42' },
      attemptsMade: 0,
    });

    expect(recorder.records[0]?.jobKey).toBeNull();
  });

  it('记录 JobRun 失败时**不掩盖**原始异常（观测设施坏了不该改变业务结果）', async () => {
    const exploding: JobRunRecorder = {
      async record(): Promise<void> {
        throw new Error('job_runs 表写不进去');
      },
    };
    const { worker, stream } = buildWorker(async () => {
      throw NO_RETRY_ERRORS.unauthorized;
    }, exploding);

    // 抛出的仍然是 UnrecoverableError（业务结果不变），并且有日志说明记录失败
    await expect(
      worker.handle({
        name: JobName.AI_CLASSIFY_SCORE,
        data: { contentId: '42' },
        attemptsMade: 0,
      }),
    ).rejects.toBeInstanceOf(UnrecoverableError);

    expect(
      stream.records().some((entry) => String(entry.msg).includes('failed to record job run')),
    ).toBe(true);
  });

  it('未提供 recorder 时不炸（测试可显式省略）', async () => {
    const { worker } = buildWorker(async () => FAKE_OUTCOME);
    await expect(
      worker.handle({ name: JobName.AI_TRANSLATE, data: { contentId: '42' }, attemptsMade: 0 }),
    ).resolves.toBeDefined();
  });
});
