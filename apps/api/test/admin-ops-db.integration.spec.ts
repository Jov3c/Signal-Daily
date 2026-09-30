/**
 * `admin-ops` 的真库集成测试 —— **真实 MySQL 8.4**。
 *
 * 运行：
 *
 * ```bash
 * pnpm --filter @signal/api test:integration
 * ```
 *
 * ── 这个文件要证明的，是假仓储证明不了的那几件事 ────────────────────
 *
 * | # | 断言                                              | 假仓储为什么不行 |
 * | - | ------------------------------------------------- | ---------------- |
 * | 1 | 聚合数字真的等于 `SUM`/`COUNT` 的结果              | 假仓储是我自己 `return` 的常量，等于在验我自己的算术 |
 * | 2 | 可空 token 列全 `null` 时 `_sum` 给 `null` → 0     | 这是 Prisma 的行为，不是我的代码 |
 * | 3 | `Decimal(12,6)` 的金额正确变成 number             | 同上 |
 * | 4 | 相同 `startedAt` 的翻页不会漏行（`id DESC` 兜底）  | 平局顺序只有真 SQL 才说了算 |
 * | 5 | 半开区间的边界**恰好**排除 `toUtc` 那一刻          | 差一毫秒的错只有真库能暴露 |
 * | 6 | `updateMany` + 条件的已读标记真的幂等              | 假仓储里的幂等是我写的 `if` |
 *
 * 不静默跳过：连不上库就直接失败（与 Agent 01 / 07 / 10 的集成测试同一约定）。
 * 测试数据带唯一后缀，`afterAll` 全部清理。
 */

import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient, Prisma } from '@prisma/client';
import { AiRunStatus, AiTaskType, JobRunStatus, PlatformErrorCode } from '@signal/contracts';
import { createLogger } from '@signal/logger';
import { PrismaAdminOpsRepository } from '../src/modules/admin-ops/prisma-admin-ops.repository';
import { AdminOpsService } from '../src/modules/admin-ops/service';
import type { AiUsageRollup } from '../src/modules/admin-ops/repository';

const SUFFIX = randomBytes(4).toString('hex');

function resolveDatabaseUrl(): string {
  const fromEnv = process.env.DATABASE_URL;
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  const envPath = fileURLToPath(new URL('../../../.env', import.meta.url));
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const match = /^DATABASE_URL=(.*)$/.exec(line.trim());
    if (match?.[1] !== undefined) return match[1].trim();
  }
  throw new Error('DATABASE_URL is not set and could not be read from the repository .env');
}

const prisma = new PrismaClient({ datasources: { db: { url: resolveDatabaseUrl() } } });
const repository = new PrismaAdminOpsRepository(prisma as never);
const service = new AdminOpsService(
  repository,
  { now: () => FIXED_NOW },
  createLogger({ service: 'api', level: 'silent' }),
);

/** 固定「现在」：北京时间 2026-09-30 11:00。 */
const FIXED_NOW = new Date('2026-09-30T03:00:00.000Z');

/** 本文件造的数据都带这个后缀，清理时只删自己的。 */
const JOB_TYPE = `it.jobs.${SUFFIX}`;
const OTHER_JOB_TYPE = `it.other.${SUFFIX}`;
const PROMPT_VERSION = `it-${SUFFIX}`;
const NOTIFICATION_TYPE = `IT_${SUFFIX}`;

/* ------------------------------------------------------------------ */
/* 造数据                                                              */
/* ------------------------------------------------------------------ */

async function makeJobRun(input: {
  jobType?: string;
  status: JobRunStatus;
  startedAt: Date;
  finishedAt?: Date | null;
  errorCode?: string | null;
}): Promise<bigint> {
  const row = await prisma.jobRun.create({
    data: {
      jobType: input.jobType ?? JOB_TYPE,
      jobKey: `${SUFFIX}-${String(input.startedAt.getTime())}`,
      status: input.status as never,
      startedAt: input.startedAt,
      finishedAt: input.finishedAt ?? null,
      attempts: 1,
      errorCode: input.errorCode ?? null,
    },
  });
  return row.id;
}

async function makeAiRun(input: {
  taskType: AiTaskType;
  status: AiRunStatus;
  model: string;
  createdAt: Date;
  inputTokens?: number | null;
  outputTokens?: number | null;
  costUsd?: string | null;
}): Promise<bigint> {
  const row = await prisma.aiRun.create({
    data: {
      taskType: input.taskType as never,
      provider: 'openai-compatible',
      model: input.model,
      promptVersion: PROMPT_VERSION,
      status: input.status as never,
      inputTokens: input.inputTokens ?? null,
      outputTokens: input.outputTokens ?? null,
      estimatedCostUsd:
        input.costUsd === undefined || input.costUsd === null
          ? null
          : new Prisma.Decimal(input.costUsd),
      durationMs: 100,
      createdAt: input.createdAt,
    },
  });
  return row.id;
}

afterAll(async () => {
  await prisma.aiRun.deleteMany({ where: { promptVersion: PROMPT_VERSION } });
  await prisma.jobRun.deleteMany({ where: { jobType: { in: [JOB_TYPE, OTHER_JOB_TYPE] } } });
  await prisma.adminNotification.deleteMany({ where: { type: NOTIFICATION_TYPE } });
  await prisma.$disconnect();
});

/* ------------------------------------------------------------------ */
/* Jobs                                                                */
/* ------------------------------------------------------------------ */

describe('作业运行历史（真表 job_runs）', () => {
  let ids: bigint[] = [];

  /**
   * ⚠ **顺序插、不要 `Promise.all`**。
   *
   * 前两条的 `startedAt` 完全相同，用来验平局排序；而平局的顺序由
   * `id DESC` 决定。用 `Promise.all` 时谁先拿到自增 id 是不确定的，
   * 于是断言「FAILED 在 SUCCEEDED 前面」会**随机**变红（第一版实测）。
   * 这里按固定顺序 `await`，让 id 与业务含义一起确定下来。
   */
  beforeAll(async () => {
    const succeeded = await makeJobRun({
      status: JobRunStatus.SUCCEEDED,
      startedAt: new Date('2026-09-30T01:00:00.000Z'),
      finishedAt: new Date('2026-09-30T01:00:05.000Z'),
    });
    const failed = await makeJobRun({
      status: JobRunStatus.FAILED,
      startedAt: new Date('2026-09-30T01:00:00.000Z'),
      finishedAt: new Date('2026-09-30T01:00:03.000Z'),
      errorCode: 'E_BOOM',
    });
    const running = await makeJobRun({
      status: JobRunStatus.RUNNING,
      startedAt: new Date('2026-09-30T02:00:00.000Z'),
    });
    const other = await makeJobRun({
      jobType: OTHER_JOB_TYPE,
      status: JobRunStatus.DEAD,
      startedAt: new Date('2026-09-30T03:00:00.000Z'),
    });
    ids = [succeeded, failed, running, other];
    // 前提：`failed` 的自增 id 确实大于 `succeeded`（否则平局断言没有意义）。
    expect(failed > succeeded).toBe(true);
  });

  it('按 startedAt DESC 列出，`durationMs` 由 finishedAt 派生', async () => {
    const { data, total } = await repository.listJobRuns({
      page: 1,
      pageSize: 10,
      jobType: JOB_TYPE,
    });

    expect(total).toBe(3);
    expect(data.map((row) => row.status)).toEqual([
      JobRunStatus.RUNNING,
      JobRunStatus.FAILED,
      JobRunStatus.SUCCEEDED,
    ]);
    expect(data[0]?.finishedAt).toBeNull();
    expect(data[0]?.durationMs).toBeNull();
    expect(data[1]?.durationMs).toBe(3000);
    expect(data[2]?.durationMs).toBe(5000);
  });

  it('⚠ 相同 `startedAt` 的两条不会在翻页时漏掉或重复（`id DESC` 兜底）', async () => {
    const first = await repository.listJobRuns({ page: 1, pageSize: 1, jobType: JOB_TYPE });
    const second = await repository.listJobRuns({ page: 2, pageSize: 1, jobType: JOB_TYPE });
    const third = await repository.listJobRuns({ page: 3, pageSize: 1, jobType: JOB_TYPE });

    const seen = [first.data[0]?.id, second.data[0]?.id, third.data[0]?.id];
    expect(new Set(seen).size).toBe(3);
    // 三条都是本文件造的
    for (const id of seen) expect(ids.map(String)).toContain(id);
  });

  it('按 status 筛选', async () => {
    const { data, total } = await repository.listJobRuns({
      page: 1,
      pageSize: 10,
      jobType: JOB_TYPE,
      status: JobRunStatus.FAILED,
    });
    expect(total).toBe(1);
    expect(data[0]?.errorCode).toBe('E_BOOM');
  });

  it('按 jobType 筛选时看不到别的类型', async () => {
    // 前提：表里**确实**存在另一类 jobType —— 否则下面那条断言恒真、毫无意义。
    //
    // ⚠ 这个前提用**带筛选**的查询确认，而不是「未筛选的 page 1 里必须出现它」。
    // 后者是 2026-09-30 的写法，它在 2026-10-01 变成了红的：
    //
    // ```text
    // job_runs 是**共享表**，历次集成测试不断追加 startedAt 更新的行；
    // 本文件造的那条形如 2026-09-30T03:00:00Z，于是被挤出了第一页（pageSize 50）。
    // ```
    //
    // 也就是说那条断言随**日历**和**跑过多少次**而变 —— 仓库自己的约定是
    // 「共享库上的断言必须是**增量**，不是绝对值」，这条正好违反了它。
    // 换成带筛选的存在性确认后，它验的还是同一件事，但不再依赖「谁更新」。
    const others = await repository.listJobRuns({
      page: 1,
      pageSize: 1,
      jobType: OTHER_JOB_TYPE,
    });
    expect(others.total).toBeGreaterThan(0);

    const filtered = await repository.listJobRuns({ page: 1, pageSize: 50, jobType: JOB_TYPE });
    expect(filtered.data.every((row) => row.jobType === JOB_TYPE)).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* Notifications                                                       */
/* ------------------------------------------------------------------ */

describe('管理员通知（真表 admin_notifications）', () => {
  let unreadId = '';
  let readId = '';

  beforeAll(async () => {
    const unread = await prisma.adminNotification.create({
      data: {
        type: NOTIFICATION_TYPE,
        title: '高分候选',
        body: `${SUFFIX} unread`,
        targetUrl: '/admin/review/1',
        status: 'UNREAD',
      },
    });
    const read = await prisma.adminNotification.create({
      data: {
        type: NOTIFICATION_TYPE,
        title: '来源失败',
        body: `${SUFFIX} read`,
        targetUrl: '/admin/sources/2',
        status: 'READ',
        readAt: new Date('2026-09-29T00:00:00.000Z'),
      },
    });
    unreadId = String(unread.id);
    readId = String(read.id);
  });

  it('按 status 筛选（只认那两个取值）', async () => {
    const unread = await repository.listNotifications({
      page: 1,
      pageSize: 50,
      status: 'UNREAD',
    });
    expect(unread.data.some((row) => row.id === unreadId)).toBe(true);

    const read = await repository.listNotifications({ page: 1, pageSize: 50, status: 'READ' });
    expect(read.data.some((row) => row.id === readId)).toBe(true);
    expect(read.data.some((row) => row.id === unreadId)).toBe(false);
  });

  it('findNotification 命中与不存在', async () => {
    expect(await repository.findNotification(unreadId)).not.toBeNull();
    expect(await repository.findNotification('999999999')).toBeNull();
  });

  it('⚠ 标记已读是**幂等**的：第二次不改写 `readAt`', async () => {
    const first = await service.markNotificationRead(unreadId, '7');
    expect(first.status).toBe('READ');
    expect(first.readAt).toBe(FIXED_NOW.toISOString());

    // 时钟往前走，再点一次 —— readAt 必须还是上一次的时刻。
    const second = await service.markNotificationRead(unreadId, '7');
    expect(second.readAt).toBe(first.readAt);

    // 库里也确实是那个值（不是只在返回值上做了假）。
    const row = await prisma.adminNotification.findUnique({ where: { id: BigInt(unreadId) } });
    expect(row?.readAt?.toISOString()).toBe(first.readAt);
  });

  it('已读的那条再标记，`readAt` 保持原值（不被覆盖成现在）', async () => {
    const before = await prisma.adminNotification.findUnique({ where: { id: BigInt(readId) } });
    const after = await service.markNotificationRead(readId, '7');
    expect(after.readAt).toBe(before?.readAt?.toISOString());
  });

  it('不存在 → 抛 404（不是 500）', async () => {
    await expect(service.markNotificationRead('999999999', '7')).rejects.toMatchObject({
      code: PlatformErrorCode.NOT_FOUND,
      httpStatus: 404,
    });
  });

  it('超出 BIGINT 上界的 id → 404，而不是把异常抛给数据库', async () => {
    await expect(
      service.markNotificationRead('99999999999999999999999999', '7'),
    ).rejects.toMatchObject({ httpStatus: 404 });
  });
});

/* ------------------------------------------------------------------ */
/* AI Usage                                                            */
/* ------------------------------------------------------------------ */

describe('AI 用量与成本（真表 ai_runs）', () => {
  /**
   * ⚠ 断言全部用**增量**，不用绝对值。
   *
   * 这是开发机上的**共享**数据库：别的集成测试（与手工验证）本来就往里写过
   * `ai_runs`。第一版断言 `totals.runs === 4`，于是本机实测拿到 **42** ——
   * 那不是实现错了，是测试在断言「这台机器上碰巧没有别的数据」。
   * 先量基线再比增量，这条用例才是在验**本模块**。
   */
  const WINDOW = {
    fromUtc: new Date('2026-09-29T16:00:00.000Z'),
    toUtc: new Date('2026-09-30T16:00:00.000Z'),
  };

  /** 本文件自造数据全在这个窗口内。 */
  const DAY_ONE = new Date('2026-09-29T20:00:00.000Z');
  const DAY_TWO = new Date('2026-09-30T02:00:00.000Z');

  let baseline: AiUsageRollup;
  let baselineByTask: Map<string, number>;
  let baselineByModel: Map<string, number>;

  beforeAll(async () => {
    baseline = await repository.aiUsageTotals(WINDOW);
    baselineByTask = new Map(
      (await repository.aiUsageByTaskType(WINDOW)).map((row) => [row.key, row.runs]),
    );
    baselineByModel = new Map(
      (await repository.aiUsageByModel(WINDOW)).map((row) => [row.key, row.runs]),
    );
  });

  beforeAll(async () => {
    await Promise.all([
      makeAiRun({
        taskType: AiTaskType.SCORE,
        status: AiRunStatus.SUCCEEDED,
        model: `model-a-${SUFFIX}`,
        createdAt: DAY_ONE,
        inputTokens: 100,
        outputTokens: 50,
        costUsd: '0.120000',
      }),
      makeAiRun({
        taskType: AiTaskType.SCORE,
        status: AiRunStatus.FAILED,
        model: `model-b-${SUFFIX}`,
        createdAt: DAY_ONE,
        // ⚠ 失败调用**没有 token 也没有成本** —— 三列都是 null。
        // 这正是 `_sum` 返回 null 的那个场景。
        inputTokens: null,
        outputTokens: null,
        costUsd: null,
      }),
      makeAiRun({
        taskType: AiTaskType.TRANSLATE,
        status: AiRunStatus.SKIPPED,
        model: `model-a-${SUFFIX}`,
        createdAt: DAY_TWO,
        inputTokens: 10,
        outputTokens: 20,
        costUsd: '0.030000',
      }),
      makeAiRun({
        taskType: AiTaskType.TRANSLATE,
        status: AiRunStatus.RUNNING,
        model: `model-c-${SUFFIX}`,
        createdAt: DAY_TWO,
      }),
    ]);
  });

  it('⚠ 全 null 的列不产生 NaN，也不把别的行金额抹掉', async () => {
    const totals = await repository.aiUsageTotals(WINDOW);

    expect(totals.runs - baseline.runs).toBe(4);
    expect(totals.inputTokens - baseline.inputTokens).toBe(110);
    expect(totals.outputTokens - baseline.outputTokens).toBe(70);
    // `Decimal(12,6)` 累加后是 number；有一条三列全 null，`_sum` 对它给 null
    expect(totals.estimatedCostUsd - baseline.estimatedCostUsd).toBeCloseTo(0.15, 6);
    // FAILED + SKIPPED = 2（QUEUED / RUNNING 不算失败）
    expect(totals.failedRuns - baseline.failedRuns).toBe(2);
  });

  it('按 taskType 分组，按调用数降序', async () => {
    const groups = await repository.aiUsageByTaskType(WINDOW);
    const delta = (key: string): number =>
      (groups.find((row) => row.key === key)?.runs ?? 0) - (baselineByTask.get(key) ?? 0);

    expect(delta(AiTaskType.SCORE)).toBe(2);
    expect(delta(AiTaskType.TRANSLATE)).toBe(2);
    expect(delta(AiTaskType.CLASSIFY)).toBe(0);

    const score = groups.find((row) => row.key === AiTaskType.SCORE);
    // 我造的两条里有一条三列全 null → 该组 token 就是另一条的 100/50
    expect(score?.inputTokens ?? 0).toBeGreaterThanOrEqual(100);
    expect(score?.failedRuns ?? 0).toBeGreaterThanOrEqual(baseline.failedRuns > 0 ? 0 : 1);

    const counts = groups.map((row) => row.runs);
    expect([...counts].sort((a, b) => b - a)).toEqual(counts);
  });

  it('按 model 分组', async () => {
    const groups = await repository.aiUsageByModel(WINDOW);
    const modelA = groups.find((row) => row.key === `model-a-${SUFFIX}`);
    expect(modelA?.runs).toBe(2);
    expect(modelA?.estimatedCostUsd).toBeCloseTo(0.15, 6);
    expect(baselineByModel.get(`model-a-${SUFFIX}`)).toBeUndefined();
  });

  it('⚠ 半开区间：`fromUtc` 那一刻算进来，`toUtc` 那一刻与之前**都不算**', async () => {
    const before = await repository.aiUsageTotals(WINDOW);

    await Promise.all([
      makeAiRun({
        taskType: AiTaskType.CLASSIFY,
        status: AiRunStatus.SUCCEEDED,
        model: `model-edge-${SUFFIX}`,
        createdAt: new Date('2026-09-29T15:59:59.999Z'), // 区间之前
      }),
      makeAiRun({
        taskType: AiTaskType.CLASSIFY,
        status: AiRunStatus.SUCCEEDED,
        model: `model-edge-${SUFFIX}`,
        createdAt: WINDOW.fromUtc, // 左闭 —— 算
      }),
      makeAiRun({
        taskType: AiTaskType.CLASSIFY,
        status: AiRunStatus.SUCCEEDED,
        model: `model-edge-${SUFFIX}`,
        createdAt: WINDOW.toUtc, // 右开 —— 不算
      }),
    ]);

    const after = await repository.aiUsageTotals(WINDOW);
    // 三条里只有一条落在窗口内。用闭区间会变成 2，用错边界会变成 3。
    expect(after.runs - before.runs).toBe(1);
  });

  it('最近调用按 createdAt DESC、id 与 contentId 都是 string', async () => {
    const recent = await repository.aiUsageRecent(20);
    expect(recent).toHaveLength(20);

    const times = recent.map((row) => new Date(row.createdAt).getTime());
    expect([...times].sort((a, b) => b - a)).toEqual(times);

    for (const row of recent) {
      expect(typeof row.id).toBe('string');
      if (row.contentId !== null) expect(typeof row.contentId).toBe('string');
    }
  });

  it('⚠ 服务层的 `aiUsage(1)` 在真数据上跑通（真实现 × 真调用方）', async () => {
    // 固定时钟是 2026-09-30T03:00Z → 业务日 2026-09-30，区间 [09-29T16:00Z, 09-30T16:00Z)。
    const view = await service.aiUsage(1);

    expect(view.window).toEqual({
      from: '2026-09-30',
      to: '2026-09-30',
      days: 1,
      timezone: 'Asia/Shanghai',
    });
    expect(view.daily).toHaveLength(1);
    expect(view.daily[0]?.businessDate).toBe('2026-09-30');
    // 单日视图的总量必须与「按日」那一条一致 —— 两条独立路径算出同一个数，
    // 说明按日窗口与整体窗口没有错位。
    expect(view.daily[0]?.runs).toBe(view.totals.runs);
    expect(view.totals.runs).toBeGreaterThanOrEqual(4);
  });
});
