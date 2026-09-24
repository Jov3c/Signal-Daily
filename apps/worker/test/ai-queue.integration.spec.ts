/**
 * AI 队列的端到端重试测试 —— **真实 Redis + 真实 BullMQ**。
 *
 * 运行（需要 Redis）：
 *   REDIS_URL=redis://127.0.0.1:6390 pnpm --filter @signal/worker test:integration
 *
 * ── 这个文件要验的唯一一件事 ────────────────────────────────────────
 * `ai.worker.ts` 里对 `job.attemptsMade` 的语义做了一个**假设**：
 * 「handler 收到的是含本次在内的累计尝试次数」，因此代码里写的是
 * `attempt = job.attemptsMade + 1`。BullMQ 在不同版本里对这个字段的
 * 处理并不一致，猜错的后果是**重试次数静默翻倍或减半** ——
 * 而单元测试里 `job` 是我们自己捏的对象，永远猜不出真库的行为。
 *
 * 所以这里真的把 job 塞进 Redis、真的让 Worker 去跑，然后数
 * **service 被调用了多少次**（而不是数事件），因为那才是「实际花了多少钱」。
 *
 * ⚠ `enqueue` 时把 backoff 的 delay 覆盖成 50ms：契约值是 3 秒指数退避
 * （`AI_RETRY.transient`），真的等完要 9 秒以上。attempts 仍然取自
 * `AI_JOB_OPTIONS`，被测的行为（重试几次）没有被削弱。
 *
 * ⚠ 本文件会 `obliterate` 掉 `ai` 队列，因此**只能对专用测试 Redis 运行**。
 */

import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Queue } from 'bullmq';
import { AiTaskType, JobName } from '@signal/contracts';
import { createLogger } from '@signal/logger';
import { AI_JOB_OPTIONS } from '../src/jobs/ai/queue';
import { AI_QUEUE_NAME } from '../src/jobs/ai/queue-names';
import {
  aiResponseInvalidError,
  aiTransientError,
  aiUnauthorizedError,
} from '../src/jobs/ai/ai.errors';
import { AiQueueWorker } from '../src/jobs/ai/ai.worker';
import type { AiTaskOutcome } from '../src/jobs/ai/ai.service';

/** 从环境变量或仓库根 `.env` 取连接串。 */
function resolveEnv(name: string): string {
  const fromEnv = process.env[name];
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;

  const envPath = fileURLToPath(new URL('../../../.env', import.meta.url));
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const match = new RegExp(`^${name}=(.*)$`).exec(line.trim());
    if (match?.[1] !== undefined) return match[1].trim();
  }
  throw new Error(`${name} is not set and could not be read from the repository .env`);
}

function parseRedis(redisUrl: string): { host: string; port: number } {
  const parsed = new URL(redisUrl);
  return { host: parsed.hostname, port: Number(parsed.port === '' ? 6379 : parsed.port) };
}

const connection = parseRedis(resolveEnv('REDIS_URL'));
const logger = createLogger({ service: 'worker', level: 'silent' });

let queue: Queue;
const openWorkers: AiQueueWorker[] = [];

beforeAll(async () => {
  queue = new Queue(AI_QUEUE_NAME, { connection });
  // 从干净的队列开始，避免上一次跑剩的 job 干扰计数
  await queue.obliterate({ force: true }).catch(() => undefined);
  await queue.waitUntilReady();
});

afterAll(async () => {
  for (const worker of openWorkers) await worker.close();
  await queue.obliterate({ force: true }).catch(() => undefined);
  await queue.close();
});

/** 一个「跑一次就记一次」的假 service，并可编排每次抛什么。 */
function buildCountingService(failures: (Error | null)[]) {
  const calls: { taskType: AiTaskType; contentId: string }[] = [];
  return {
    calls,
    service: {
      async runTask(input: { taskType: AiTaskType; contentId: string }): Promise<AiTaskOutcome> {
        const index = calls.length;
        calls.push(input);
        const failure = failures[index] ?? failures.at(-1) ?? null;
        if (failure !== null) throw failure;
        return { contentId: input.contentId, taskType: input.taskType } as AiTaskOutcome;
      },
    },
  };
}

/**
 * 在**一个自己的消费者**作用域里跑一段逻辑，结束后立刻关掉它。
 *
 * ⚠ 必须每个用例一个、用完即关。第一版是「所有用例共用一批 worker」，
 * 结果是 4 条用例失败：同一队列上的多个 worker 会互相抢 job，
 * 于是 A 用例入队的 job 被 B 用例的 service 消费掉 ——
 * 计数全乱，而且失败信息表现为「job 到不了终态」，很难看出真正原因。
 * 队列语义的测试必须**独占队列**。
 */
async function withWorker<T>(service: unknown, run: () => Promise<T>): Promise<T> {
  const worker = new AiQueueWorker({
    service: service as never,
    connection,
    logger,
    concurrency: 1,
  });
  openWorkers.push(worker);
  await worker.start();
  try {
    return await run();
  } finally {
    await worker.close();
  }
}

/** 入队一个 job（attempts 取契约值，backoff 缩短以便测试跑得快）。 */
async function enqueue(jobName: string, contentId: string): Promise<string> {
  const jobId = `it-${randomBytes(6).toString('hex')}`;
  await queue.add(
    jobName,
    { contentId },
    {
      jobId,
      attempts: AI_JOB_OPTIONS.attempts,
      backoff: { type: 'fixed', delay: 50 },
      removeOnComplete: false,
      removeOnFail: false,
    },
  );
  return jobId;
}

/**
 * 等到 job 进入终态（completed，或 failed 且不再重试）。
 *
 * ⚠ 第一版这里写的是「`failed` 且 `attemptsMade >= opts.attempts` 才算终态」，
 * 于是本文件里**恰好那两条「应该立即停止重试」的用例挂了**：
 * `UnrecoverableError` 会让 BullMQ 在 `attemptsMade = 1` 时就放弃 job，
 * 而我的条件要求等到 3 —— 永远等不到，超时。
 *
 * 判据应当是「**BullMQ 是否还会再跑它**」，而不是我们自己数次数：
 * 还有重试时 BullMQ 会把 job 放回 `delayed` / `waiting`，
 * 只有真正放弃时才停在 `failed`。所以直接把 `failed` 当成终态。
 *
 * 为了排除「刚失败、还没被移走」的瞬时窗口，要求连续两次轮询都看到
 * `failed` 才认（100ms），这比依赖单次采样的时序更稳。
 */
async function waitForTerminal(jobId: string, timeoutMs = 20_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let consecutiveFailed = 0;

  while (Date.now() < deadline) {
    const job = await queue.getJob(jobId);
    if (job !== undefined && job !== null) {
      const state = await job.getState();
      if (state === 'completed') return state;
      if (state === 'failed') {
        consecutiveFailed += 1;
        if (consecutiveFailed >= 2) return state;
      } else {
        consecutiveFailed = 0;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`job ${jobId} did not reach a terminal state in ${timeoutMs}ms`);
}

/** 终态后再静置一会儿，给「不该发生的那次重试」留出暴露的机会。 */
async function settle(ms = 400): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe('AI_JOB_OPTIONS 与契约一致', () => {
  it('attempts 取 AI_RETRY.transient（3 次）', () => {
    expect(AI_JOB_OPTIONS.attempts).toBe(3);
  });

  it('默认退避是指数型的 3 秒（契约值，测试里才覆盖成 50ms）', () => {
    expect(AI_JOB_OPTIONS.backoff).toEqual({ type: 'exponential', delay: 3_000 });
  });
});

describe('真实 Redis 上的重试次数', () => {
  it('瞬时失败恰好重试到 3 次（验证 attemptsMade 语义）', async () => {
    const { service, calls } = buildCountingService([aiTransientError({ safeMessage: 'timeout' })]);

    await withWorker(service, async () => {
      const jobId = await enqueue(JobName.AI_CLASSIFY_SCORE, '4242');
      const state = await waitForTerminal(jobId);
      await settle();

      expect(state).toBe('failed');
      // 这一条就是本文件的全部意义：如果 `attemptsMade` 的语义猜错了，
      // 这里会是 2 或 4，而不是 3。
      expect(calls).toHaveLength(3);
      expect(calls.every((call) => call.taskType === AiTaskType.SCORE)).toBe(true);
    });
  }, 30_000);

  it('凭据错误恰好只尝试 1 次（不烧额度）', async () => {
    const { service, calls } = buildCountingService([aiUnauthorizedError(401)]);

    await withWorker(service, async () => {
      const jobId = await enqueue(JobName.AI_CLASSIFY_SCORE, '4243');
      await waitForTerminal(jobId);
      await settle();

      expect(calls).toHaveLength(1);
    });
  }, 30_000);

  it('schema 非法恰好只尝试 1 次（契约 attempts=1）', async () => {
    const { service, calls } = buildCountingService([aiResponseInvalidError('not json')]);

    await withWorker(service, async () => {
      const jobId = await enqueue(JobName.AI_TRANSLATE, '4244');
      await waitForTerminal(jobId);
      await settle();

      expect(calls).toHaveLength(1);
      expect(calls[0]?.taskType).toBe(AiTaskType.TRANSLATE);
    });
  }, 30_000);

  it('成功后不再重试', async () => {
    const { service, calls } = buildCountingService([null]);

    await withWorker(service, async () => {
      const jobId = await enqueue(JobName.AI_CLASSIFY_SCORE, '4245');
      const state = await waitForTerminal(jobId);
      await settle();

      expect(state).toBe('completed');
      expect(calls).toHaveLength(1);
    });
  }, 30_000);

  it('先失败两次再成功 —— 共 3 次调用且最终 completed', async () => {
    const { service, calls } = buildCountingService([
      aiTransientError({ safeMessage: 'flaky 1' }),
      aiTransientError({ safeMessage: 'flaky 2' }),
      null,
    ]);

    await withWorker(service, async () => {
      const jobId = await enqueue(JobName.AI_CLASSIFY_SCORE, '4246');
      const state = await waitForTerminal(jobId);
      await settle();

      expect(state).toBe('completed');
      expect(calls).toHaveLength(3);
    });
  }, 30_000);
});

describe('幂等 JobId', () => {
  it('同一个 JobId 重复入队不会产生第二个 job', async () => {
    const jobId = `it-dup-${randomBytes(4).toString('hex')}`;
    const first = await queue.add(
      JobName.AI_CLASSIFY_SCORE,
      { contentId: '4247' },
      { jobId, removeOnComplete: false, removeOnFail: false },
    );
    const second = await queue.add(
      JobName.AI_CLASSIFY_SCORE,
      { contentId: '4247' },
      { jobId, removeOnComplete: false, removeOnFail: false },
    );

    expect(String(second.id)).toBe(String(first.id));
  }, 30_000);
});
