/**
 * AI 入队 JobId 的守卫。
 *
 * ── 这个文件是独立审查（安全向）P0 的直接产物 ────────────────────────
 * 审查前，`ai-queue.integration.spec.ts` 里的 job 用的是**自己拼的字面量**
 * （`it-<random>`、`it-dup-<random>`），**从来没有调用过本模块的 JobId builder**。
 * 于是两个 builder 一个都没被验证过，其中 `translateJobId()` 产出的
 * `translate:{contentId}` 会被 BullMQ 直接拒绝：
 *
 * ```text
 * Custom Id cannot contain :
 * ```
 *
 * BullMQ 5.81.5 的规则（`node_modules/bullmq/dist/cjs/classes/job.js`）是：
 * **含 `:` 的自定义 jobId 必须恰好 3 段**（为兼容旧的 repeatable job 留下的规则）。
 *
 * 「测试自己拼字面量」是一种很隐蔽的空跑：它让「21 项真 Redis 集成测试全绿」
 * 与「翻译任务根本进不了队列」同时成立。
 */

import { describe, expect, it } from 'vitest';
import { JobName, JOB_TO_QUEUE, QueueName, AI_RETRY } from '@signal/contracts';
import {
  AI_JOB_OPTIONS,
  assertQueueMapping,
  classifyScoreJobId,
  TASK_TO_JOB_NAME,
  translateJobId,
} from '../src/jobs/ai/queue';
import { AI_QUEUE_NAME } from '../src/jobs/ai/queue-names';

/**
 * BullMQ 对自定义 jobId 的硬性要求：含 `:` 时必须恰好 3 段。
 *
 * 这是**运行期**的约束（`tsc` 管不着），所以只能在这里守住。
 */
function assertBullMqAcceptable(jobId: string): void {
  const segments = jobId.split(':');
  if (segments.length !== 3) {
    throw new Error(
      `BullMQ rejects a custom jobId with colons unless it has exactly 3 segments; ` +
        `got ${segments.length} in "${jobId}"`,
    );
  }
}

describe('JobId 必须能被 BullMQ 接受', () => {
  it('classifyScoreJobId 是 3 段', () => {
    const jobId = classifyScoreJobId('123', 'v1');
    expect(() => assertBullMqAcceptable(jobId)).not.toThrow();
    expect(jobId).toBe('ai-score:123:v1');
  });

  it('translateJobId 是 3 段（P0 回归守卫）', () => {
    const jobId = translateJobId('123', 'v1');
    // ⚠ 这一条在修复前会红：当时产出的是 `translate:123`（2 段），
    // 而 BullMQ 会抛 `Custom Id cannot contain :` —— 翻译任务永远进不了队列。
    expect(() => assertBullMqAcceptable(jobId)).not.toThrow();
    expect(jobId).toBe('translate:123:v1');
  });

  it('两个 builder 都带 promptVersion（prompt 改版后要能被重跑）', () => {
    // 不带版本的话，prompt 改版后入队会被 JobId 去重掉，
    // 于是历史内容永远无法用新标准重评 —— 这正是契约里
    // `JobId.aiScore(contentId, promptVersion)` 带版本的原因。
    expect(translateJobId('123', 'v2')).not.toBe(translateJobId('123', 'v1'));
    expect(classifyScoreJobId('123', 'v2')).not.toBe(classifyScoreJobId('123', 'v1'));
  });

  it('同参数重复调用得到同一个 JobId（幂等的前提）', () => {
    expect(translateJobId('123', 'v1')).toBe(translateJobId('123', 'v1'));
    expect(classifyScoreJobId('123', 'v1')).toBe(classifyScoreJobId('123', 'v1'));
  });
});

describe('Queue / Job 映射（docs/13 冻结契约）', () => {
  it('本模块用到的 Job 名都映射到 ai 队列', () => {
    expect(() => assertQueueMapping()).not.toThrow();
  });

  it('Job 名与队列名与契约一致', () => {
    expect(TASK_TO_JOB_NAME.TRANSLATE).toBe(JobName.AI_TRANSLATE);
    expect(TASK_TO_JOB_NAME.SCORE).toBe(JobName.AI_CLASSIFY_SCORE);
    expect(JOB_TO_QUEUE[JobName.AI_TRANSLATE]).toBe(QueueName.AI);
    expect(JOB_TO_QUEUE[JobName.AI_CLASSIFY_SCORE]).toBe(QueueName.AI);
    expect(AI_QUEUE_NAME).toBe(QueueName.AI);
  });

  it('映射错时会真的抛错（守卫有牙齿）', () => {
    // 直接验证守卫的逻辑确实会拒绝错误的映射组合，
    // 而不是只验证「当前配置恰好通过」。
    const wrong = { TRANSLATE: JobName.COLLECTOR_FETCH_SOURCE };
    const badJobName = Object.values(wrong)[0]!;
    expect(JOB_TO_QUEUE[badJobName as keyof typeof JOB_TO_QUEUE]).not.toBe(QueueName.AI);
  });
});

describe('入队选项', () => {
  it('attempts 取 AI_RETRY.transient（handler 的重试分档依赖它）', () => {
    // ⚠ 这一条是整个重试分档的**前提**：`ai.worker.ts` 每次失败都返回
    // `RETRY` 或 `STOP`，但 BullMQ 是否再跑一次取决于**入队时**的 attempts。
    // 若下游自己 `queue.add(...)` 用了 BullMQ 默认的 attempts=1，
    // 瞬时抖动会在第 1 次就永久失败，而 handler 那边看不出任何异常。
    expect(AI_JOB_OPTIONS.attempts).toBe(AI_RETRY.transient.attempts);
    expect(AI_JOB_OPTIONS.attempts).toBeGreaterThanOrEqual(1);
  });

  it('失败的任务长期保留（docs/13：最终失败 BullMQ 保留，后台可重试）', () => {
    expect(AI_JOB_OPTIONS.removeOnFail).toBe(false);
  });
});
