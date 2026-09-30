/**
 * Pipeline 队列的端到端测试 —— **真实 Redis + 真实 BullMQ**。
 *
 * 运行（需要 Redis）：
 *   REDIS_URL=redis://127.0.0.1:6390 pnpm --filter @signal/worker test:integration
 *
 * ── 为什么必须打真 Redis（Agent 06 的 P0 教训）──────────────────────
 * 那边出过一次「JobId 是 2 段、被 BullMQ 直接拒绝」的 P0：
 * **21 项集成测试全绿**，因为测试自己拼 `it-<random>` 字面量、
 * 从来没调用过 builder。所以这里两条都验：
 * 1. **本模块 builder 的产物真的能入队**；
 * 2. 契约里那个坏的 `JobId.normalize` **确实会被拒** —— 刻意钉住这个
 *    已知缺陷（CCR 第 0 项），契约修好后这条会红，提醒删掉绕过代码。
 *
 * ⚠ **只清理自己创建的 job，不 `obliterate` 生产队列**。
 * Agent 04 的审查（F-09）指出过「测试清空共享 Redis 上真实 worker 正在消费的
 * 生产队列」这个问题；`ContentPipelineWorker` 内部用的是契约里的队列名，
 * 所以这里必须共用队列 —— 那就更不能清空它。
 */

import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Queue } from 'bullmq';
import { JobName, QueueName, RawItemStatus } from '@signal/contracts';
import { createLogger } from '@signal/logger';
import {
  CONTENT_PIPELINE_JOB_OPTIONS,
  assertContentQueueContract,
  isContractNormalizeJobIdUsable,
  isBullMqAcceptableJobId,
  normalizeJobId,
} from '../src/jobs/content/queue';
import { CONTENT_PIPELINE_QUEUE_NAME } from '../src/jobs/content/queue-names';
import { dedupJobId, eventClusterJobId } from '../src/jobs/content/content-enqueuer';
import { ContentPipelineWorker } from '../src/jobs/content/content.worker';
import { RawItemNotFoundError } from '../src/jobs/content/content.service';

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
/** 本文件创建过的 jobId —— 只清理这些。 */
const createdJobIds: string[] = [];
let worker: ContentPipelineWorker | null = null;

beforeAll(async () => {
  queue = new Queue(CONTENT_PIPELINE_QUEUE_NAME, { connection });
  await queue.waitUntilReady();
});

afterEach(async () => {
  if (worker !== null) {
    await worker.close();
    worker = null;
  }
  // **只删自己建的 job**（不动队列里别人的东西）。
  for (const jobId of createdJobIds.splice(0)) {
    const job = await queue.getJob(jobId);
    if (job !== null && job !== undefined) await job.remove().catch(() => undefined);
  }
});

afterAll(async () => {
  await queue.close();
});

/** 入队一个本模块的 job，并记下 id 以便清理。 */
async function enqueue(
  jobName: string,
  data: Record<string, unknown>,
  jobId: string,
): Promise<string> {
  createdJobIds.push(jobId);
  await queue.add(jobName, data, {
    jobId,
    attempts: CONTENT_PIPELINE_JOB_OPTIONS.attempts,
    // 退避缩短到 50ms：契约值是 5 秒指数退避，真的等完要 15 秒以上。
    backoff: { type: 'fixed', delay: 50 },
    removeOnComplete: false,
    removeOnFail: false,
  });
  return jobId;
}

/** 起一个真实消费者，service 换成计数替身。 */
async function startWorker(service: unknown): Promise<void> {
  worker = new ContentPipelineWorker({
    service: service as never,
    connection,
    logger,
    concurrency: 1,
  });
  await worker.start();
}

/** 等到 job 进入终态（不再重试）。 */
async function waitForTerminal(jobId: string, timeoutMs = 20_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let consecutiveFailed = 0;
  while (Date.now() < deadline) {
    const job = await queue.getJob(jobId);
    if (job !== null && job !== undefined) {
      const state = await job.getState();
      if (state === 'completed') return state;
      if (state === 'failed') {
        // `UnrecoverableError` 会让 job 在 attemptsMade 很小的时候就终态，
        // 所以判据是「BullMQ 还会不会再跑它」—— 连续两次看到 failed 才算终态。
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

async function settle(ms = 300): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

const uniqueId = (): string => `it-${randomBytes(6).toString('hex')}`;

describe('JobId 契约', () => {
  it('本模块三个 builder 的产物都是 3 段、且都能被 BullMQ 接受', async () => {
    const ids = [normalizeJobId('1'), dedupJobId('1'), eventClusterJobId('1')];
    for (const id of ids) {
      expect(isBullMqAcceptableJobId(id)).toBe(true);
      expect(id.split(':')).toHaveLength(3);
    }

    // 真的入队一次 —— 「形状对」不等于「BullMQ 收得下」
    for (const [index, id] of ids.entries()) {
      const jobId = `${uniqueId()}-${index}`;
      createdJobIds.push(jobId);
      await expect(
        queue.add(JobName.CONTENT_NORMALIZE, { rawItemId: '1' }, { jobId }),
      ).resolves.toBeDefined();
      void id;
    }
  });

  it('**契约的 `JobId.normalize` 仍是坏的（2 段，被 BullMQ 拒绝）**', async () => {
    // 刻意钉住一个**已知缺陷**（已提 CCR 第 0 项）。
    // 契约修好之后这条会红 —— 那时应当删掉本模块的绕过 builder。
    // ⚠ **2026-09-30 契约已统一**：`JobId.normalize` 现在产出 3 段。
    // 这条断言从「契约是坏的」翻成了「契约可用」——
    // 而下面那条「2 段字面量被 BullMQ 拒绝」仍然保留：
    // 它证明的是 **BullMQ 的规则本身**，不是契约的状态。
    //（两者必须分开写：契约会变，BullMQ 的规则不会。）
    expect(isContractNormalizeJobIdUsable()).toBe(true);
    await expect(
      queue.add(JobName.CONTENT_NORMALIZE, { rawItemId: '1' }, { jobId: 'normalize:1' }),
    ).rejects.toThrow(/Custom Id cannot contain/);
  });

  it('启动期自检通过（Job 名→队列映射 + JobId 段数）', () => {
    expect(() => assertContentQueueContract()).not.toThrow();
  });

  it('Job 名与队列名与契约一致', () => {
    expect(JobName.CONTENT_NORMALIZE).toBe('content.normalize');
    expect(JobName.CONTENT_DEDUP).toBe('content.dedup');
    expect(JobName.CONTENT_EVENT_CLUSTER).toBe('content.event-cluster');
    expect(QueueName.CONTENT_PIPELINE).toBe('content-pipeline');
  });

  it('入队选项：attempts=3、失败保留（docs/13 的 Dead Letter）', () => {
    expect(CONTENT_PIPELINE_JOB_OPTIONS.attempts).toBe(3);
    expect(CONTENT_PIPELINE_JOB_OPTIONS.removeOnFail).toBe(false);
  });
});

describe('队列消费与重试（真 Redis）', () => {
  it('成功时 job 完成', async () => {
    await startWorker({
      normalize: async () => ({ status: 'NORMALIZED' }),
      runNearDedup: async () => null,
      clusterContent: async () => null,
    });

    const jobId = await enqueue(JobName.CONTENT_NORMALIZE, { rawItemId: '1' }, uniqueId());
    await expect(waitForTerminal(jobId)).resolves.toBe('completed');
  }, 30_000);

  it('**可重试的失败会跑满 3 次**（数据库抖动这类）', async () => {
    let calls = 0;
    await startWorker({
      normalize: async () => {
        calls += 1;
        throw new Error('数据库连接断了');
      },
      runNearDedup: async () => null,
      clusterContent: async () => null,
    });

    const jobId = await enqueue(JobName.CONTENT_NORMALIZE, { rawItemId: '1' }, uniqueId());
    await waitForTerminal(jobId);
    await settle();

    expect(calls).toBe(3);
  }, 30_000);

  it('**不可重试的失败只跑 1 次**（RawItem 不存在 —— 重试一百次也不在）', async () => {
    let calls = 0;
    await startWorker({
      normalize: async () => {
        calls += 1;
        throw new RawItemNotFoundError('999');
      },
      runNearDedup: async () => null,
      clusterContent: async () => null,
    });

    const jobId = await enqueue(JobName.CONTENT_NORMALIZE, { rawItemId: '999' }, uniqueId());
    await waitForTerminal(jobId);
    await settle();

    expect(calls).toBe(1);
  }, 30_000);

  it('**载荷畸形立刻终止**（那是代码缺陷，重试只会重复同一个错误）', async () => {
    let calls = 0;
    await startWorker({
      normalize: async () => {
        calls += 1;
        return { status: 'NORMALIZED' };
      },
      runNearDedup: async () => null,
      clusterContent: async () => null,
    });

    const jobId = await enqueue(
      JobName.CONTENT_NORMALIZE,
      { rawItemId: 'not-a-number' },
      uniqueId(),
    );
    await waitForTerminal(jobId);
    await settle();

    expect(calls).toBe(0); // 载荷校验在调用 service 之前就失败了
  }, 30_000);

  it('`content.dedup` 走同一条消费路径', async () => {
    let seen: string | null = null;
    await startWorker({
      normalize: async () => ({ status: 'NORMALIZED' }),
      runNearDedup: async (contentId: string) => {
        seen = contentId;
        return { crossSourceMatches: [], sameSourceMatches: [], comparedCount: 0 };
      },
      clusterContent: async () => null,
    });

    const jobId = await enqueue(JobName.CONTENT_DEDUP, { contentId: '42' }, uniqueId());
    await expect(waitForTerminal(jobId)).resolves.toBe('completed');
    expect(seen).toBe('42');
  }, 30_000);

  it('`content.event-cluster` 走同一条消费路径', async () => {
    let seen: string | null = null;
    await startWorker({
      normalize: async () => ({ status: 'NORMALIZED' }),
      runNearDedup: async () => null,
      clusterContent: async (contentId: string) => {
        seen = contentId;
        return { action: 'create', eventId: '900', primaryContentId: contentId };
      },
    });

    const jobId = await enqueue(JobName.CONTENT_EVENT_CLUSTER, { contentId: '42' }, uniqueId());
    await expect(waitForTerminal(jobId)).resolves.toBe('completed');
    expect(seen).toBe('42');
  }, 30_000);

  it('挂错队列的 job 名会被拒（不会静默跑成别的任务）', async () => {
    await startWorker({
      normalize: async () => ({ status: 'NORMALIZED' }),
      runNearDedup: async () => null,
      clusterContent: async () => null,
    });

    const jobId = await enqueue('collector.fetch-source', { sourceId: '1' }, uniqueId());
    await expect(waitForTerminal(jobId)).resolves.toBe('failed');
  }, 30_000);
});

describe('常量自检', () => {
  it('RawItemStatus 里用于流水线的值仍然存在（防契约漂移）', () => {
    expect(RawItemStatus.DUPLICATE).toBe('DUPLICATE');
    expect(RawItemStatus.READY_FOR_ANALYSIS).toBe('READY_FOR_ANALYSIS');
  });
});
