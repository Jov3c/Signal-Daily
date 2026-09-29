/**
 * `publishing` 队列的端到端测试 —— **真实 Redis + 真实 BullMQ**。
 *
 * 运行（需要 Redis）：
 *   REDIS_URL=redis://127.0.0.1:6390 pnpm --filter @signal/worker test:integration
 *
 * ── 这个文件存在的唯一理由，是 Agent 06 的 P0 教训 ──────────────────
 * 它的 `translateJobId` 产出 2 段，被 BullMQ **同步拒绝**，
 * 于是 `ai.translate` 根本进不了队列、翻译链路整体不可用 ——
 * 而当时 **886 项单测 + 21 项集成测试全绿**。
 * 原因是那 21 项集成测试**自己拼 `it-<random>` 字面量，从来没调用过 builder**。
 *
 * 所以这里做两件单元测试做不到的事：
 *
 * 1. **把 builder 的产物真的塞进 Redis** —— BullMQ 对含 `:` 的自定义 jobId
 *    有「恰好 3 段」的硬规则，那条规则只在 `queue.add()` 里执行；
 * 2. **让真的 Worker 去消费它** —— 证明「入队成功」不只是「没抛错」，
 *    而是「任务真的被跑到、载荷真的解析正确」。
 *
 * ⚠ 本文件会 `obliterate` 掉 `publishing` 队列，因此**只能对专用测试 Redis 运行**。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Queue } from 'bullmq';
import { JobId, JobName } from '@signal/contracts';
import { createLogger } from '@signal/logger';
import {
  PUBLISHING_JOB_OPTIONS,
  PUBLISHING_SLOT,
  dailyDraftJobId,
  dailyPublishJobId,
  isBullMqAcceptableJobId,
} from '../src/jobs/publishing/queue';
import { PUBLISHING_QUEUE_NAME } from '../src/jobs/publishing/queue-names';
import { PublishingQueueWorker } from '../src/jobs/publishing/publishing.worker';
import type { PublishingService } from '../src/jobs/publishing/publishing.service';

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
const DATE = '2026-09-29';

/**
 * 每个用例一个**合法且互不相同**的业务日。
 *
 * ⚠ 第一版给业务日加了唯一后缀（`2026-09-29-run-ab12cd`）来避免用例之间
 * 撞 Redis 状态 —— 结果那个值**不匹配 `YYYY-MM-DD`**，
 * 于是载荷校验把每个 job 都判成畸形、直接进 `DEAD`，
 * 表现是「Worker 一直不消费」。实现没问题，是测试数据不合理。
 *
 * 业务日在这里只是 job 的标识（替身 service 不解析它），
 * 所以用一个单调计数器造合法日期即可。
 */
let dateCounter = 0;
function uniqueDate(): string {
  dateCounter += 1;
  const month = String(Math.floor((dateCounter - 1) / 28) + 1).padStart(2, '0');
  const day = String(((dateCounter - 1) % 28) + 1).padStart(2, '0');
  return `2019-${month}-${day}`;
}

let queue: Queue;

/** 一个记录调用的 service 替身（只关心「被跑到没有、载荷对不对」）。 */
function fakeService() {
  const calls: { method: string; businessDate: string }[] = [];
  const service = {
    async initDraft(businessDate: string) {
      calls.push({ method: 'initDraft', businessDate });
      return { editionId: '1', businessDate, status: 'DRAFT', created: true };
    },
    async generateDraft(businessDate: string) {
      calls.push({ method: 'generateDraft', businessDate });
      return {
        businessDate,
        editionId: '1',
        generated: true,
        skippedReason: null,
        status: 'DRAFT',
        sectionCount: 1,
        itemCount: 1,
        notes: [],
      };
    },
    async publishIfScheduled(businessDate: string) {
      calls.push({ method: 'publishIfScheduled', businessDate });
      return { businessDate, published: true, reason: 'PUBLISHED', editionNo: 1, issues: [] };
    },
    async remindIfNotReviewing(businessDate: string) {
      calls.push({ method: 'remindIfNotReviewing', businessDate });
      return { businessDate, notified: true, reason: 'NOTIFIED' };
    },
  };
  return { service: service as unknown as PublishingService, calls };
}

beforeAll(async () => {
  queue = new Queue(PUBLISHING_QUEUE_NAME, { connection });
  // 干净起点。⚠ 这只对专用测试 Redis 安全。
  await queue.obliterate({ force: true }).catch(() => undefined);
});

afterAll(async () => {
  await queue.obliterate({ force: true }).catch(() => undefined);
  await queue.close();
});

describe('builder 的产物真的能被 BullMQ 接受（Agent 06 的 P0 回归守卫）', () => {
  it('四个槽位的 jobId 都能入队（含 07:30 那个虽然不产生 Job，也验一次格式）', async () => {
    for (const slot of Object.values(PUBLISHING_SLOT)) {
      const jobId = dailyDraftJobId(uniqueDate(), slot);
      expect(isBullMqAcceptableJobId(jobId), jobId).toBe(true);

      // ⚠ 这一行才是重点：真的调用 `queue.add()`。
      // BullMQ 的段数规则就在这里执行，2 段会**同步抛错**。
      const job = await queue.add(
        JobName.PUBLISHING_DAILY_DRAFT,
        { businessDate: DATE, slot },
        { ...PUBLISHING_JOB_OPTIONS, jobId },
      );
      expect(job.id).toBe(jobId);
    }
  });

  it('发布的 jobId 同样能被接受', async () => {
    const jobId = dailyPublishJobId(uniqueDate(), PUBLISHING_SLOT.PUBLISH);
    const job = await queue.add(
      JobName.PUBLISHING_DAILY_PUBLISH,
      { businessDate: DATE, slot: PUBLISHING_SLOT.PUBLISH },
      { ...PUBLISHING_JOB_OPTIONS, jobId },
    );
    expect(job.id).toBe(jobId);
  });

  it('⚠ **契约的 `JobId.dailyDraft` 被 BullMQ 拒绝**（这就是本模块自造 builder 的原因）', async () => {
    const contractJobId = JobId.dailyDraft(uniqueDate());

    await expect(
      queue.add(
        JobName.PUBLISHING_DAILY_DRAFT,
        { businessDate: DATE, slot: PUBLISHING_SLOT.GENERATE_DRAFT },
        { ...PUBLISHING_JOB_OPTIONS, jobId: contractJobId },
      ),
    ).rejects.toThrow(/Custom Id cannot contain/);
  });
});

describe('同一天三趟草稿是三个独立的 job（第三段必须区分它们）', () => {
  it('三个槽位入队之后队列里有 3 个不同的 job，而不是 1 个', async () => {
    await queue.obliterate({ force: true });
    const date = uniqueDate();

    for (const slot of [
      PUBLISHING_SLOT.INIT_DRAFT,
      PUBLISHING_SLOT.GENERATE_DRAFT,
      PUBLISHING_SLOT.REFRESH_DRAFT,
    ]) {
      await queue.add(
        JobName.PUBLISHING_DAILY_DRAFT,
        { businessDate: date, slot },
        { ...PUBLISHING_JOB_OPTIONS, jobId: dailyDraftJobId(date, slot) },
      );
    }

    const waiting = await queue.getJobs(['waiting', 'delayed', 'active', 'completed']);
    const ids = new Set(waiting.map((job) => job.id));
    expect(ids.size).toBe(3);
  });

  it('同一个槽位重复入队 → 队列里仍然只有 1 个（幂等的前提）', async () => {
    await queue.obliterate({ force: true });
    const date = uniqueDate();
    const jobId = dailyDraftJobId(date, PUBLISHING_SLOT.GENERATE_DRAFT);
    const data = { businessDate: date, slot: PUBLISHING_SLOT.GENERATE_DRAFT };

    await queue.add(JobName.PUBLISHING_DAILY_DRAFT, data, {
      ...PUBLISHING_JOB_OPTIONS,
      jobId,
    });
    await queue.add(JobName.PUBLISHING_DAILY_DRAFT, data, {
      ...PUBLISHING_JOB_OPTIONS,
      jobId,
    });

    const jobs = await queue.getJobs(['waiting', 'delayed', 'active', 'completed']);
    expect(jobs.filter((job) => job.id === jobId)).toHaveLength(1);
  });
});

describe('真的跑起来：Worker 消费 builder 产出的 job', () => {
  it('三个草稿槽位分别被分派到 initDraft / generateDraft / generateDraft', async () => {
    await queue.obliterate({ force: true });
    const { service, calls } = fakeService();

    const worker = new PublishingQueueWorker({
      service,
      connection,
      logger,
      concurrency: 1,
    });

    await worker.start();
    try {
      const date = uniqueDate();
      for (const slot of [
        PUBLISHING_SLOT.INIT_DRAFT,
        PUBLISHING_SLOT.GENERATE_DRAFT,
        PUBLISHING_SLOT.REFRESH_DRAFT,
      ]) {
        await queue.add(
          JobName.PUBLISHING_DAILY_DRAFT,
          { businessDate: date, slot },
          { ...PUBLISHING_JOB_OPTIONS, jobId: dailyDraftJobId(date, slot) },
        );
      }

      // 等三趟都跑完（并发 1，按入队顺序）
      await waitFor(() => calls.length >= 3, 15_000);

      expect(calls).toEqual([
        { method: 'initDraft', businessDate: date },
        { method: 'generateDraft', businessDate: date },
        { method: 'generateDraft', businessDate: date },
      ]);
    } finally {
      await worker.close();
    }
  });

  it('发布 job 被分派到 publishIfScheduled', async () => {
    await queue.obliterate({ force: true });
    const { service, calls } = fakeService();

    const worker = new PublishingQueueWorker({ service, connection, logger, concurrency: 1 });
    await worker.start();
    try {
      const date = uniqueDate();
      await queue.add(
        JobName.PUBLISHING_DAILY_PUBLISH,
        { businessDate: date, slot: PUBLISHING_SLOT.PUBLISH },
        { ...PUBLISHING_JOB_OPTIONS, jobId: dailyPublishJobId(date, PUBLISHING_SLOT.PUBLISH) },
      );

      await waitFor(() => calls.length >= 1, 15_000);
      expect(calls[0]).toEqual({ method: 'publishIfScheduled', businessDate: date });
    } finally {
      await worker.close();
    }
  });
});

/** 轮询等待条件成立（避免用固定 sleep）。 */
async function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`condition not met within ${String(timeoutMs)}ms`);
}
