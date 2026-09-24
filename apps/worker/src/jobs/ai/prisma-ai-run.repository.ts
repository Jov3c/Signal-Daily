/**
 * `AiRepository` 的 Prisma 实现。
 *
 * ⚠ 本文件是**唯一**允许把 AI 产物写进数据库的地方。
 * 特别地：它只写 `contents` 的分数列、`recommendation_reason`、
 * `body_translated` 与 `ai_analysis` —— **从不写 `sources` 的任何列**。
 * `docs/08`：「AI 不能修改 Source Tier / 不能自己宣布某来源官方」。
 * `ai-score-write-scope.spec.ts` 会直接断言这一点。
 */

import type { Prisma, PrismaClient } from '@prisma/client';
import { AiRunStatus, SOURCE_KINDS, SOURCE_TIERS } from '@signal/contracts';
import type {
  AiArtifact,
  AiContentRecord,
  AiRepository,
  AiTopicRecord,
  FinishAiRunInput,
  StartAiRunInput,
} from './ai-run.repository';
import type { AiSpendSummary } from './budget';
import type { EvidenceProjection, SourceIdentity } from './evidence-context';
import { toContractEvidenceType, toPrismaAiRunStatus, toPrismaAiTaskType } from './contract-enum';
import { toContractEnum } from './enum-guard';

/** 只取本模块需要的列，避免把 LongText 正文在不需要时也拉出来。 */
const CONTENT_SELECT = {
  id: true,
  title: true,
  bodyOriginal: true,
  bodyTranslated: true,
  language: true,
  eventId: true,
  source: {
    select: { name: true, kind: true, tier: true, official: true },
  },
} as const;

export class PrismaAiRepository implements AiRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async findContent(contentId: string): Promise<AiContentRecord | null> {
    const row = await this.prisma.content.findUnique({
      where: { id: toBigIntId(contentId) },
      select: CONTENT_SELECT,
    });
    if (row === null) return null;

    const source: SourceIdentity & { name: string } = {
      name: row.source.name,
      kind: toContractEnum(SOURCE_KINDS, row.source.kind, 'SourceKind'),
      tier: toContractEnum(SOURCE_TIERS, row.source.tier, 'SourceTier'),
      official: row.source.official,
    };

    return {
      id: String(row.id),
      title: row.title,
      bodyOriginal: row.bodyOriginal,
      bodyTranslated: row.bodyTranslated,
      language: row.language,
      eventId: row.eventId === null ? null : String(row.eventId),
      source,
    };
  }

  async findEventEvidences(eventId: string): Promise<EvidenceProjection[]> {
    const rows = await this.prisma.eventEvidence.findMany({
      where: { eventId: toBigIntId(eventId) },
      select: { id: true, sourceId: true, evidenceType: true, isPrimary: true },
      orderBy: { id: 'asc' },
    });

    return rows.map((row) => ({
      id: String(row.id),
      sourceId: row.sourceId === null ? null : String(row.sourceId),
      evidenceType: toContractEvidenceType(row.evidenceType),
      isPrimary: row.isPrimary,
    }));
  }

  async listTopics(): Promise<AiTopicRecord[]> {
    const rows = await this.prisma.topic.findMany({
      select: { slug: true, name: true },
      orderBy: { slug: 'asc' },
    });
    return rows.map((row) => ({ slug: row.slug, name: row.name }));
  }

  async startAiRun(input: StartAiRunInput): Promise<string> {
    const row = await this.prisma.aiRun.create({
      data: {
        contentId: input.contentId === null ? null : toBigIntId(input.contentId),
        taskType: toPrismaAiTaskType(input.taskType),
        provider: input.provider,
        model: input.model,
        promptVersion: input.promptVersion,
        status: toPrismaAiRunStatus(AiRunStatus.RUNNING),
      },
      select: { id: true },
    });
    return String(row.id);
  }

  async finishAiRun(input: FinishAiRunInput): Promise<void> {
    const aiRunId = toBigIntId(input.aiRunId);

    const runUpdate = {
      status: toPrismaAiRunStatus(input.status),
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      estimatedCostUsd: input.estimatedCostUsd,
      durationMs: input.durationMs,
      errorCode: input.errorCode,
    };

    // 没有产物可写时不做事务 —— 一次写就是一次写，不必为一个 UPDATE 起事务。
    const contentWrite = this.contentWriteFor(input);
    if (contentWrite === null) {
      await this.prisma.aiRun.update({ where: { id: aiRunId }, data: runUpdate });
      return;
    }

    // 事务是必需的：否则可能出现「AiRun 记成 SUCCEEDED，但分数没写进去」，
    // 于是内容永远停在没分数的状态而 AiRun 说它成功了。
    await this.prisma.$transaction([
      this.prisma.aiRun.update({ where: { id: aiRunId }, data: runUpdate }),
      contentWrite,
    ]);
  }

  /**
   * 把产物翻译成一条 Prisma update。
   *
   * 返回 `null` 表示「这次没有内容可写」（失败、或 `kind: 'none'`）。
   */
  private contentWriteFor(input: FinishAiRunInput): Prisma.PrismaPromise<unknown> | null {
    const artifact: AiArtifact = input.artifact;
    if (artifact.kind === 'none') return null;

    // contentId 为 null 的 AiRun（例如将来不绑定内容的任务）没有可写目标。
    const contentId = input.contentId;
    if (contentId === null) return null;

    if (artifact.kind === 'score') {
      return this.prisma.content.update({
        where: { id: toBigIntId(contentId) },
        data: {
          ...toScoreColumns(artifact.scoreUpdate),
          recommendationReason: artifact.recommendationReason,
          aiAnalysis: toJson(artifact.aiAnalysis),
        },
        select: { id: true },
      });
    }

    return this.prisma.content.update({
      where: { id: toBigIntId(contentId) },
      data: {
        // 只写译文列。**绝不写 bodyOriginal**（docs/00：翻译不覆盖原文）。
        bodyTranslated: artifact.bodyTranslated,
        aiAnalysis: toJson(artifact.aiAnalysis),
      },
      select: { id: true },
    });
  }

  async sumCostUsdBetween(from: Date, to: Date): Promise<AiSpendSummary> {
    const window = { createdAt: { gte: from, lt: to } };

    const [aggregate, uncostedRuns] = await Promise.all([
      this.prisma.aiRun.aggregate({
        where: window,
        _sum: { estimatedCostUsd: true },
      }),
      // 成本为 null 的 run **不计入** 合计，但必须被计数暴露出来 ——
      // 否则预算统计会静默少算（见 budget.ts 的说明）。
      this.prisma.aiRun.count({ where: { ...window, estimatedCostUsd: null } }),
    ]);

    const total = aggregate._sum.estimatedCostUsd;
    return {
      // Prisma.Decimal → Number（BIGINT/DECIMAL 在 Prisma 里都是对象，不是原始值）
      totalUsd: total === null ? 0 : Number(total),
      uncostedRuns,
    };
  }
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

/**
 * BIGINT id 解析。
 *
 * 与 Agent 03 的 `toBigIntId` 同一取舍：只接受十进制数字串，
 * 非法输入抛错（对 worker 而言这是编程错误，不是用户输入）。
 */
export function toBigIntId(value: string): bigint {
  if (!/^\d{1,20}$/.test(value)) {
    throw new Error(`Not a valid BIGINT id: ${value}`);
  }
  return BigInt(value);
}

/**
 * 分数更新对象的白名单收敛。
 *
 * `scoring.ts` 的 `toContentScoreUpdate()` 已经只产出分数列，
 * 这里再挡一次：**任何非分数列都会被丢弃**。
 * 双重保险是刻意的 —— 这行代码守住的是「AI 不能改 Source Tier」
 * 这条契约在写路径上的最后一道门。
 */
const ALLOWED_SCORE_COLUMNS = new Set([
  'importanceScore',
  'relevanceScore',
  'credibilityScore',
  'noveltyScore',
  'densityScore',
  'readValueScore',
  'finalScore',
]);

function toScoreColumns(update: Record<string, number>): Record<string, number> {
  const safe: Record<string, number> = {};
  for (const [key, value] of Object.entries(update)) {
    if (ALLOWED_SCORE_COLUMNS.has(key)) safe[key] = value;
  }
  return safe;
}

/**
 * 转成 Prisma 的 `InputJsonValue`。
 *
 * 走一次 `JSON.parse(JSON.stringify(...))` 而不是 `as`：
 * 这样 `undefined`、函数、`BigInt` 这类**无法 JSON 序列化**的值会在
 * 边界处立刻暴露，而不是被 Prisma 静默丢掉一部分字段后写进库。
 */
function toJson(value: Record<string, unknown>): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}
