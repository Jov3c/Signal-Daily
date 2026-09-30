/**
 * `AdminOpsRepository` 的 Prisma 实现。
 *
 * 三张表都是**只读**的（唯一例外是通知的已读标记）。
 * 写入方分别是 worker 的 04 / 05 / 06 / 08 与 Agent 07 的通知扫描 ——
 * 本模块不产生它们，只读。
 *
 * ── ⚠ 聚合里的 `null` ────────────────────────────────────────────────
 * `input_tokens` / `output_tokens` / `estimated_cost_usd` 都是可空列
 * （AI 调用失败时只有错误码，没有 token）。`_sum` 对全 `null` 的列返回
 * `null`，`_count` 却会照数 —— 所以每个字段都要单独兜 `?? 0`，
 * 不能只判 `_sum` 整体。
 */

import { Inject, Injectable } from '@nestjs/common';
import {
  // ⚠ 运行时用 Prisma 生成的枚举值、类型用契约枚举 —— 与 Agent 05 / 07
  // 同一写法。契约与 Prisma 是两个独立的枚举，桥接表漏一个键就是编译错。
  AiRunStatus as PrismaAiRunStatus,
  AiTaskType as PrismaAiTaskType,
  JobRunStatus as PrismaJobRunStatus,
  type Prisma,
} from '@prisma/client';
import { AiRunStatus, AiTaskType, JobRunStatus } from '@signal/contracts';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  type AdminAiRun,
  type AdminJobRun,
  type AdminNotification,
  type AdminOpsRepository,
  type AiUsageGroupRow,
  type AiUsageRollup,
  type AiUsageWindow,
  type JobRunListQuery,
  type NotificationListQuery,
} from './repository';

/* ------------------------------------------------------------------ */
/* 枚举桥接（显式表：漏一个键就是编译错，不是运行时静默错）             */
/* ------------------------------------------------------------------ */

const JOB_STATUS_TO_CONTRACT: Readonly<Record<PrismaJobRunStatus, JobRunStatus>> = {
  [PrismaJobRunStatus.QUEUED]: JobRunStatus.QUEUED,
  [PrismaJobRunStatus.RUNNING]: JobRunStatus.RUNNING,
  [PrismaJobRunStatus.SUCCEEDED]: JobRunStatus.SUCCEEDED,
  [PrismaJobRunStatus.FAILED]: JobRunStatus.FAILED,
  [PrismaJobRunStatus.DEAD]: JobRunStatus.DEAD,
};

const JOB_STATUS_TO_PRISMA: Readonly<Record<JobRunStatus, PrismaJobRunStatus>> = {
  [JobRunStatus.QUEUED]: PrismaJobRunStatus.QUEUED,
  [JobRunStatus.RUNNING]: PrismaJobRunStatus.RUNNING,
  [JobRunStatus.SUCCEEDED]: PrismaJobRunStatus.SUCCEEDED,
  [JobRunStatus.FAILED]: PrismaJobRunStatus.FAILED,
  [JobRunStatus.DEAD]: PrismaJobRunStatus.DEAD,
};

/** 契约 `AiTaskType` ↔ Prisma `AiTaskType`（7 个，一一对应）。 */
const AI_TASK_TO_CONTRACT: Readonly<Record<PrismaAiTaskType, AiTaskType>> = {
  [PrismaAiTaskType.LANGUAGE_DETECT]: AiTaskType.LANGUAGE_DETECT,
  [PrismaAiTaskType.TRANSLATE]: AiTaskType.TRANSLATE,
  [PrismaAiTaskType.CLASSIFY]: AiTaskType.CLASSIFY,
  [PrismaAiTaskType.SCORE]: AiTaskType.SCORE,
  [PrismaAiTaskType.DEDUP_VERIFY]: AiTaskType.DEDUP_VERIFY,
  [PrismaAiTaskType.EVENT_CLUSTER]: AiTaskType.EVENT_CLUSTER,
  [PrismaAiTaskType.DAILY_DRAFT]: AiTaskType.DAILY_DRAFT,
};

/** 契约 `AiRunStatus` ↔ Prisma `AiRunStatus`（5 个，一一对应）。 */
const AI_RUN_STATUS_TO_CONTRACT: Readonly<Record<PrismaAiRunStatus, AiRunStatus>> = {
  [PrismaAiRunStatus.QUEUED]: AiRunStatus.QUEUED,
  [PrismaAiRunStatus.RUNNING]: AiRunStatus.RUNNING,
  [PrismaAiRunStatus.SUCCEEDED]: AiRunStatus.SUCCEEDED,
  [PrismaAiRunStatus.FAILED]: AiRunStatus.FAILED,
  [PrismaAiRunStatus.SKIPPED]: AiRunStatus.SKIPPED,
};

/** 失败判据：只有 `SUCCEEDED` 算成功（`SKIPPED` 是「没花钱也没产出」）。 */
const AI_FAILED_STATUSES: PrismaAiRunStatus[] = [
  PrismaAiRunStatus.FAILED,
  PrismaAiRunStatus.SKIPPED,
];

/* ------------------------------------------------------------------ */
/* 映射                                                                */
/* ------------------------------------------------------------------ */

function toIso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

function durationOf(startedAt: Date, finishedAt: Date | null): number | null {
  if (finishedAt === null) return null;
  const ms = finishedAt.getTime() - startedAt.getTime();
  // 时钟回拨（NTP 校正）会给出负数。负的耗时比 null 更容易误导，所以也归 null。
  return ms < 0 ? null : ms;
}

/** `Decimal | null` → number。精度取舍见 `repository.ts` 与 Agent 07 的先例。 */
function toUsd(value: Prisma.Decimal | null): number | null {
  return value === null ? null : Number(value);
}

/** `_sum.estimated_cost_usd` 是全 `null` 列时返回 `null` → 0。 */
function toUsdSum(value: Prisma.Decimal | null | undefined): number {
  return value === null || value === undefined ? 0 : Number(value);
}

@Injectable()
export class PrismaAdminOpsRepository implements AdminOpsRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /* ---------------------------------------------------------------- */
  /* Jobs                                                             */
  /* ---------------------------------------------------------------- */

  async listJobRuns(query: JobRunListQuery): Promise<{ data: AdminJobRun[]; total: number }> {
    const where: Prisma.JobRunWhereInput = {
      ...(query.jobType === undefined ? {} : { jobType: query.jobType }),
      ...(query.status === undefined ? {} : { status: JOB_STATUS_TO_PRISMA[query.status] }),
    };

    const [rows, total] = await Promise.all([
      this.prisma.jobRun.findMany({
        where,
        // `id DESC` 是必要的第二键：同一批入队的 job 会有完全相同的
        // `startedAt`（毫秒级），只按时间排序时翻页会漏行或重复行。
        orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.jobRun.count({ where }),
    ]);

    return {
      data: rows.map((row) => ({
        id: String(row.id),
        jobType: row.jobType,
        jobKey: row.jobKey,
        status: JOB_STATUS_TO_CONTRACT[row.status],
        startedAt: row.startedAt.toISOString(),
        finishedAt: toIso(row.finishedAt),
        durationMs: durationOf(row.startedAt, row.finishedAt),
        attempts: row.attempts,
        errorCode: row.errorCode,
        metadata: row.metadata,
      })),
      total,
    };
  }

  /* ---------------------------------------------------------------- */
  /* Notifications                                                    */
  /* ---------------------------------------------------------------- */

  async listNotifications(
    query: NotificationListQuery,
  ): Promise<{ data: AdminNotification[]; total: number }> {
    const where: Prisma.AdminNotificationWhereInput = {
      ...(query.status === undefined ? {} : { status: query.status }),
    };

    const [rows, total] = await Promise.all([
      this.prisma.adminNotification.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.adminNotification.count({ where }),
    ]);

    return { data: rows.map(toNotification), total };
  }

  async findNotification(id: string): Promise<AdminNotification | null> {
    const row = await this.prisma.adminNotification.findUnique({ where: { id: BigInt(id) } });
    return row === null ? null : toNotification(row);
  }

  async markNotificationRead(id: string, readAt: Date): Promise<AdminNotification | null> {
    // ⚠ `updateMany` + `status: 'UNREAD'` 作为条件，而不是先读再写：
    // 后者在两个管理员同时点开时会互相覆盖 `readAt`。
    // 命中 0 行有两种可能（不存在 / 已经读过），所以之后必须再查一次
    // —— 「已读」是合法结果，不能当成 404。
    await this.prisma.adminNotification.updateMany({
      where: { id: BigInt(id), status: 'UNREAD' },
      data: { status: 'READ', readAt },
    });
    return this.findNotification(id);
  }

  /* ---------------------------------------------------------------- */
  /* AI Usage                                                         */
  /* ---------------------------------------------------------------- */

  async aiUsageTotals(window: AiUsageWindow): Promise<AiUsageRollup> {
    const where = windowWhere(window);
    const [sum, runs, failedRuns] = await Promise.all([
      this.prisma.aiRun.aggregate({
        where,
        _sum: { inputTokens: true, outputTokens: true, estimatedCostUsd: true },
      }),
      this.prisma.aiRun.count({ where }),
      this.prisma.aiRun.count({ where: { ...where, status: { in: AI_FAILED_STATUSES } } }),
    ]);

    return {
      runs,
      failedRuns,
      inputTokens: sum._sum.inputTokens ?? 0,
      outputTokens: sum._sum.outputTokens ?? 0,
      estimatedCostUsd: toUsdSum(sum._sum.estimatedCostUsd),
    };
  }

  async aiUsageByTaskType(window: AiUsageWindow): Promise<AiUsageGroupRow[]> {
    const groups = await this.prisma.aiRun.groupBy({
      by: ['taskType'],
      where: windowWhere(window),
      _count: { _all: true },
      _sum: { inputTokens: true, outputTokens: true, estimatedCostUsd: true },
    });
    // ⚠ 失败数是**每个分组单独查**的（groupBy 不能同时按 status 再分组并
    // 保留「该组失败数」这个额外维度）。分组数最多 4 个（契约里就 4 个
    // AiTaskType），所以是 4 次小查询，可接受。
    const failed = await Promise.all(
      groups.map(async (group) =>
        this.prisma.aiRun.count({
          where: {
            ...windowWhere(window),
            taskType: group.taskType,
            status: { in: AI_FAILED_STATUSES },
          },
        }),
      ),
    );

    return groups
      .map((group, index) => toGroupRow(group.taskType, group, failed[index] ?? 0))
      .sort((a, b) => b.runs - a.runs);
  }

  async aiUsageByModel(window: AiUsageWindow): Promise<AiUsageGroupRow[]> {
    const groups = await this.prisma.aiRun.groupBy({
      by: ['model'],
      where: windowWhere(window),
      _count: { _all: true },
      _sum: { inputTokens: true, outputTokens: true, estimatedCostUsd: true },
    });
    const failed = await Promise.all(
      groups.map(async (group) =>
        this.prisma.aiRun.count({
          where: { ...windowWhere(window), model: group.model, status: { in: AI_FAILED_STATUSES } },
        }),
      ),
    );

    return groups
      .map((group, index) => toGroupRow(group.model, group, failed[index] ?? 0))
      .sort((a, b) => b.runs - a.runs);
  }

  /**
   * 单个时间窗口的汇总。
   *
   * 服务层对**每一个**业务日各调一次这个方法（`Promise.all`），
   * 而不是写一条 `GROUP BY 业务日` 的原生 SQL。理由见 `service.ts` 的说明：
   * 时区换算只有 `@signal/config` 一个真源，不在 SQL 里重写一遍。
   */
  async aiUsageForWindow(window: AiUsageWindow): Promise<AiUsageRollup> {
    return this.aiUsageTotals(window);
  }

  async aiUsageRecent(limit: number): Promise<AdminAiRun[]> {
    const rows = await this.prisma.aiRun.findMany({
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit,
    });

    return rows.map((row) => ({
      id: String(row.id),
      contentId: row.contentId === null ? null : String(row.contentId),
      taskType: AI_TASK_TO_CONTRACT[row.taskType],
      provider: row.provider,
      model: row.model,
      promptVersion: row.promptVersion,
      status: AI_RUN_STATUS_TO_CONTRACT[row.status],
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      estimatedCostUsd: toUsd(row.estimatedCostUsd),
      durationMs: row.durationMs,
      errorCode: row.errorCode,
      createdAt: row.createdAt.toISOString(),
    }));
  }
}

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

function windowWhere(window: AiUsageWindow): Prisma.AiRunWhereInput {
  // 半开区间：`>= from` 且 `< to`。闭区间会让相邻两天的边界那一毫秒被算两次。
  return { createdAt: { gte: window.fromUtc, lt: window.toUtc } };
}

type GroupAggregate = {
  _count: { _all: number };
  _sum: {
    inputTokens: number | null;
    outputTokens: number | null;
    estimatedCostUsd: Prisma.Decimal | null;
  };
};

function toGroupRow(key: string, group: GroupAggregate, failedRuns: number): AiUsageGroupRow {
  return {
    key,
    runs: group._count._all,
    failedRuns,
    inputTokens: group._sum.inputTokens ?? 0,
    outputTokens: group._sum.outputTokens ?? 0,
    estimatedCostUsd: toUsdSum(group._sum.estimatedCostUsd),
  };
}

type NotificationRow = {
  id: bigint;
  type: string;
  title: string;
  body: string;
  targetUrl: string | null;
  status: string;
  emailStatus: string;
  createdAt: Date;
  readAt: Date | null;
};

function toNotification(row: NotificationRow): AdminNotification {
  return {
    id: String(row.id),
    type: row.type,
    title: row.title,
    body: row.body,
    targetUrl: row.targetUrl,
    status: row.status,
    emailStatus: row.emailStatus,
    createdAt: row.createdAt.toISOString(),
    readAt: toIso(row.readAt),
  };
}
