/**
 * AI 模块的真库集成测试 —— **真实 MySQL 8.4**。
 *
 * 运行：`pnpm --filter @signal/worker test:integration`
 *
 * ── 为什么这几条必须打真库 ──────────────────────────────────────────
 * 单元测试里 Prisma 全被替身挡掉了，于是下面这些**一个都验不到**：
 *
 * 1. **契约枚举 → Prisma 枚举的桥接**（`contract-enum.ts`）。
 *    那是编译期的类型体操，`tsc` 通过不代表运行期写库成功 ——
 *    只有真的 `INSERT` 一次才知道值对不对。
 * 2. **`DECIMAL(4,1)` / `DECIMAL(5,2)` / `DECIMAL(12,6)` 的往返精度**。
 *    替身里分数是 JS number，写库时才会被量化/截断。
 * 3. **`Json` 列的写入**（`ai_analysis`）。
 * 4. **时间窗过滤用的是真实 UTC 时间戳**。预算按上海业务日聚合，
 *    而 `created_at` 存 UTC —— 这条边界只有在真库上才好验。
 * 5. **「AI 永不写 sources」** 在真实 SQL 层面的确认（前后快照对比）。
 *
 * 本文件**不静默跳过**：连不上库就直接失败（Agent 01 的同一原则）。
 * 测试数据带唯一后缀，`afterAll` 全部清理，不污染 Agent 01 的 seed 基线。
 */

import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import {
  AiRunStatus,
  AiTaskType,
  EvidenceType,
  isValidErrorCode,
  SourceKind,
  SourceTier,
} from '@signal/contracts';
import { PrismaAiRepository } from '../src/jobs/ai/prisma-ai-run.repository';
import { toContractEvidenceType } from '../src/jobs/ai/contract-enum';

/**
 * `event_evidence.url_hash` 是 `Char(64)`，约定存 SHA-256 十六进制小写
 * （Agent 01 的 Public Interfaces 第 5 条）。
 */
function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

const SUFFIX = randomBytes(4).toString('hex');
const SLUG = `ai-it-source-${SUFFIX}`;

/** 从仓库根 `.env` 读 `DATABASE_URL`（与 Agent 01 / 03 的集成测试一致）。 */
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
const repository = new PrismaAiRepository(prisma);

let sourceId: bigint;
let eventId: bigint;
let contentId: bigint;

beforeAll(async () => {
  const source = await prisma.source.create({
    data: {
      name: `AI IT Source ${SUFFIX}`,
      slug: SLUG,
      type: 'RSS',
      kind: SourceKind.OFFICIAL,
      tier: SourceTier.S,
      official: true,
      config: { seed: false, note: 'agent-06 integration test fixture' },
    },
    select: { id: true },
  });
  sourceId = source.id;

  const event = await prisma.event.create({
    data: {
      canonicalTitle: `AI IT Event ${SUFFIX}`,
      status: 'ACTIVE',
      firstSeenAt: new Date('2026-09-24T00:00:00.000Z'),
      lastSeenAt: new Date('2026-09-24T00:00:00.000Z'),
    },
    select: { id: true },
  });
  eventId = event.id;

  const content = await prisma.content.create({
    data: {
      sourceId,
      eventId,
      type: 'ARTICLE',
      title: 'Anthropic 发布新评测报告',
      bodyOriginal: 'Anthropic released a new evaluation report.',
      language: 'en',
      originalUrl: `https://example.com/${SUFFIX}/a`,
      pipelineStatus: 'INGESTED',
    },
    select: { id: true },
  });
  contentId = content.id;

  // 三条证据、两个来源（其中一个是本测试的 source）
  await prisma.eventEvidence.createMany({
    data: [
      {
        eventId,
        contentId,
        sourceId,
        evidenceType: EvidenceType.PRIMARY_SOURCE,
        url: `https://example.com/${SUFFIX}/a`,
        urlHash: hash(`https://example.com/${SUFFIX}/a`),
        isPrimary: true,
      },
      {
        eventId,
        sourceId,
        evidenceType: EvidenceType.SUPPORTING_SOURCE,
        url: `https://example.com/${SUFFIX}/b`,
        urlHash: hash(`https://example.com/${SUFFIX}/b`),
      },
      {
        eventId,
        sourceId,
        evidenceType: EvidenceType.SUPPORTING_SOURCE,
        url: `https://example.com/${SUFFIX}/c`,
        urlHash: hash(`https://example.com/${SUFFIX}/c`),
      },
    ],
  });
});

afterAll(async () => {
  // 逆着外键顺序清理，只删本测试造的数据。
  await prisma.aiRun.deleteMany({ where: { contentId } });
  await prisma.eventEvidence.deleteMany({ where: { eventId } });
  await prisma.editorialReview.deleteMany({ where: { contentId } });
  await prisma.content.deleteMany({ where: { id: contentId } });
  await prisma.event.deleteMany({ where: { id: eventId } });
  await prisma.source.deleteMany({ where: { id: sourceId } });
  await prisma.$disconnect();
});

describe('读内容（契约枚举桥接 + 投影）', () => {
  it('findContent 返回契约枚举而不是 Prisma 枚举', async () => {
    const content = await repository.findContent(String(contentId));

    expect(content).not.toBeNull();
    expect(content!.source.kind).toBe(SourceKind.OFFICIAL);
    expect(content!.source.tier).toBe(SourceTier.S);
    expect(content!.source.official).toBe(true);
    expect(content!.eventId).toBe(String(eventId));
  });

  it('findContent 对不存在的 id 返回 null', async () => {
    await expect(repository.findContent('999999999')).resolves.toBeNull();
  });

  it('findEventEvidences 把 Prisma EvidenceType 收敛成契约枚举', async () => {
    const evidences = await repository.findEventEvidences(String(eventId));

    expect(evidences).toHaveLength(3);
    expect(evidences.every((item) => Object.values(EvidenceType).includes(item.evidenceType))).toBe(
      true,
    );
    expect(evidences.filter((item) => item.isPrimary)).toHaveLength(1);
  });

  it('listTopics 读得到 Agent 01 seed 的主题', async () => {
    const topics = await repository.listTopics();
    expect(topics.length).toBeGreaterThan(0);
    expect(topics[0]).toHaveProperty('slug');
    expect(topics[0]).toHaveProperty('name');
  });
});

describe('AiRun 生命周期（真 SQL）', () => {
  it('startAiRun 写入 RUNNING（Prisma 枚举桥接在真实 INSERT 上成立）', async () => {
    const aiRunId = await repository.startAiRun({
      contentId: String(contentId),
      taskType: AiTaskType.SCORE,
      provider: 'openai-compatible',
      model: 'gpt-4o-mini',
      promptVersion: 'v1',
    });

    const row = await prisma.aiRun.findUniqueOrThrow({ where: { id: BigInt(aiRunId) } });
    expect(row.status).toBe(AiRunStatus.RUNNING);
    expect(row.taskType).toBe(AiTaskType.SCORE);
    expect(row.promptVersion).toBe('v1');
    expect(row.contentId).toBe(contentId);
  });

  it('finishAiRun(SUCCEEDED) 把分数写进 contents，且 DECIMAL 精度不丢', async () => {
    const aiRunId = await repository.startAiRun({
      contentId: String(contentId),
      taskType: AiTaskType.SCORE,
      provider: 'openai-compatible',
      model: 'gpt-4o-mini',
      promptVersion: 'v1',
    });

    await repository.finishAiRun({
      aiRunId,
      contentId: String(contentId),
      status: AiRunStatus.SUCCEEDED,
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      estimatedCostUsd: 0.75,
      durationMs: 1234,
      errorCode: null,
      artifact: {
        kind: 'score',
        scoreUpdate: {
          importanceScore: 87.4,
          relevanceScore: 70.6,
          credibilityScore: 91.9,
          noveltyScore: 60.5,
          densityScore: 50.1,
          readValueScore: 79.9,
          finalScore: 76.32,
        },
        recommendationReason: '官方一手发布，信息密度高。',
        aiAnalysis: { taskType: 'SCORE', band: 'RECOMMENDED', topics: ['ai-models'] },
      },
    });

    const content = await prisma.content.findUniqueOrThrow({ where: { id: contentId } });
    // Decimal(4,1) —— 一位小数往返不丢
    expect(Number(content.importanceScore)).toBeCloseTo(87.4, 1);
    // Decimal(5,2) —— 两位小数往返不丢
    expect(Number(content.finalScore)).toBeCloseTo(76.32, 2);
    expect(content.recommendationReason).toContain('官方一手');

    const run = await prisma.aiRun.findUniqueOrThrow({ where: { id: BigInt(aiRunId) } });
    expect(run.status).toBe(AiRunStatus.SUCCEEDED);
    // Decimal(12,6)
    expect(Number(run.estimatedCostUsd)).toBeCloseTo(0.75, 6);
    expect(run.inputTokens).toBe(1_000_000);
    expect(run.durationMs).toBe(1234);
  });

  it('ai_analysis 以 JSON 落库并可读回（按任务分区）', async () => {
    const content = await prisma.content.findUniqueOrThrow({ where: { id: contentId } });
    // 结构是 `{ score: {...}, translation: {...} }` —— 见 aiAnalysis 的分区说明。
    expect(content.aiAnalysis).toMatchObject({
      score: {
        taskType: 'SCORE',
        band: 'RECOMMENDED',
        topics: ['ai-models'],
      },
    });
  });

  it('finishAiRun(FAILED) 一个字都不写进 contents', async () => {
    const before = await prisma.content.findUniqueOrThrow({ where: { id: contentId } });

    const aiRunId = await repository.startAiRun({
      contentId: String(contentId),
      taskType: AiTaskType.SCORE,
      provider: 'openai-compatible',
      model: 'gpt-4o-mini',
      promptVersion: 'v1',
    });

    await repository.finishAiRun({
      aiRunId,
      contentId: String(contentId),
      status: AiRunStatus.FAILED,
      inputTokens: null,
      outputTokens: null,
      estimatedCostUsd: null,
      durationMs: 300,
      errorCode: 'AI_REQUEST_FAILED',
      artifact: { kind: 'none' },
    });

    const after = await prisma.content.findUniqueOrThrow({ where: { id: contentId } });
    expect(after.importanceScore?.toString()).toBe(before.importanceScore?.toString());
    expect(after.finalScore?.toString()).toBe(before.finalScore?.toString());

    const run = await prisma.aiRun.findUniqueOrThrow({ where: { id: BigInt(aiRunId) } });
    expect(run.status).toBe(AiRunStatus.FAILED);
    expect(run.errorCode).toBe('AI_REQUEST_FAILED');
  });

  it('翻译产物只写 body_translated，不动 body_original（docs/00）', async () => {
    const before = await prisma.content.findUniqueOrThrow({ where: { id: contentId } });

    const aiRunId = await repository.startAiRun({
      contentId: String(contentId),
      taskType: AiTaskType.TRANSLATE,
      provider: 'openai-compatible',
      model: 'gpt-4o-mini',
      promptVersion: 'v1',
    });

    await repository.finishAiRun({
      aiRunId,
      contentId: String(contentId),
      status: AiRunStatus.SUCCEEDED,
      inputTokens: 100,
      outputTokens: 50,
      estimatedCostUsd: 0.000045,
      durationMs: 900,
      errorCode: null,
      artifact: {
        kind: 'translation',
        bodyTranslated: 'Anthropic 发布了一份新的评测报告。',
        aiAnalysis: { taskType: 'TRANSLATE', detectedLanguage: 'en' },
      },
    });

    const after = await prisma.content.findUniqueOrThrow({ where: { id: contentId } });
    expect(after.bodyTranslated).toContain('新的评测报告');
    expect(after.bodyOriginal).toBe(before.bodyOriginal);

    // ⚠ 独立审查 P2 的**真库**回归守卫：翻译任务不得抹掉评分任务写进
    // `ai_analysis` 的东西。第一版两个分支都整列覆盖，于是
    // 「先评分再翻译」之后 `dimensions` / `band` / `topics` 全部消失 ——
    // 而 `ai-service.ts` 里恰好写着「管理员在审核页仍能看到模型当时选了什么」。
    // 这条在真库上验，是因为它取决于 Prisma 对 Json 列的写入语义。
    expect(after.aiAnalysis).toMatchObject({
      score: { band: 'RECOMMENDED', topics: ['ai-models'] },
      translation: { detectedLanguage: 'en' },
    });
  });
});

describe('预算统计（真实 UTC 时间戳 + 业务日窗口）', () => {
  it('sumCostUsdBetween 只统计窗口内的行，并把未计价的单独计数', async () => {
    const window = {
      from: new Date('2020-01-01T00:00:00.000Z'),
      to: new Date('2030-01-01T00:00:00.000Z'),
    };

    const summary = await repository.sumCostUsdBetween(window.from, window.to);

    // 本测试前面已经写过若干 run：有计价的也有未计价的
    expect(summary.totalUsd).toBeGreaterThan(0);
    expect(summary.uncostedRuns).toBeGreaterThan(0);
  });

  it('窗口之外的行不计入（真空窗口 → 0）', async () => {
    const summary = await repository.sumCostUsdBetween(
      new Date('1990-01-01T00:00:00.000Z'),
      new Date('1991-01-01T00:00:00.000Z'),
    );
    expect(summary.totalUsd).toBe(0);
    expect(summary.uncostedRuns).toBe(0);
  });

  it('区间是左闭右开（边界上的行只被算一次）', async () => {
    // ⚠ 刻意选一个**远离现在**的边界：前面的用例在 "now" 附近写了行，
    // 如果窗口开在今天，那些行会被一起算进来，这条断言就变成了
    // 「碰巧等于」而不是「边界正确」。用一个隔离的远期时刻才能真正验边界。
    const boundary = new Date('2099-06-15T00:00:00.000Z');
    await prisma.aiRun.create({
      data: {
        contentId,
        taskType: 'SCORE',
        provider: 'openai-compatible',
        model: 'gpt-4o-mini',
        promptVersion: 'v1',
        status: 'SUCCEEDED',
        estimatedCostUsd: 1.234567,
        createdAt: boundary,
      },
    });

    const before = await repository.sumCostUsdBetween(
      new Date('2099-01-01T00:00:00.000Z'),
      boundary,
    );
    const from = await repository.sumCostUsdBetween(boundary, new Date('2099-12-31T00:00:00.000Z'));

    // 右开：左区间的上界就是边界，不含它
    expect(before.totalUsd).toBe(0);
    // 左闭：右区间从边界开始，含它 —— 且只含它这一个
    expect(from.totalUsd).toBeCloseTo(1.234567, 6);
  });
});

describe('AI 永不写 sources（真实 SQL 层面确认）', () => {
  it('整个测试跑完后 source 行逐字段未变', async () => {
    const source = await prisma.source.findUniqueOrThrow({ where: { id: sourceId } });

    expect(source.kind).toBe(SourceKind.OFFICIAL);
    expect(source.tier).toBe(SourceTier.S);
    expect(source.official).toBe(true);
    expect(source.slug).toBe(SLUG);
    expect(source.name).toBe(`AI IT Source ${SUFFIX}`);
    expect(source.trustScore.toString()).toBe('7'); // 默认值未被 AI 改动
  });
});

/**
 * 独立审查 P2：`docs/08` 的三条硬约束与「收尾与产物同一事务」，
 * 在仓库自带测试里**只对着内存替身断言过** —— 替身自己实现了一遍
 * `applyArtifact`，不经过真实现的 `ALLOWED_SCORE_COLUMNS` 与事务。
 * 把真实现改坏（加 `pipelineStatus`、去掉白名单、去掉事务）时 886 项单测全绿。
 *
 * 下面这一组跑在真库上，是那几条不变式的**真实覆盖**。
 */
describe('写入范围与事务（真库不变式）', () => {
  it('一次成功的评分不改动 pipeline_status / body_original', async () => {
    const before = await prisma.content.findUniqueOrThrow({ where: { id: contentId } });

    const aiRunId = await repository.startAiRun({
      contentId: String(contentId),
      taskType: AiTaskType.SCORE,
      provider: 'openai-compatible',
      model: 'gpt-4o-mini',
      promptVersion: 'v1',
    });
    await repository.finishAiRun({
      aiRunId,
      contentId: String(contentId),
      status: AiRunStatus.SUCCEEDED,
      inputTokens: 10,
      outputTokens: 5,
      estimatedCostUsd: 0.000001,
      durationMs: 100,
      errorCode: null,
      artifact: {
        kind: 'score',
        scoreUpdate: { importanceScore: 80, finalScore: 80 },
        recommendationReason: '范围快照用例',
        aiAnalysis: { taskType: 'SCORE' },
      },
    });

    const after = await prisma.content.findUniqueOrThrow({ where: { id: contentId } });
    // 状态机归 Agent 05 —— AI 一行都不碰
    expect(after.pipelineStatus).toBe(before.pipelineStatus);
    // docs/00：翻译不覆盖原文；评分也不该碰原文
    expect(after.bodyOriginal).toBe(before.bodyOriginal);
  });

  it('内容被写坏（写路径抛错）时事务整体回滚，AiRun 停在 RUNNING', async () => {
    // 用超界 id 让 `contents` 的 UPDATE 注定失败 —— 此时同事务里的
    // AiRun 收尾也必须回滚，否则会出现「AiRun 说成功、分数没写」。
    const aiRunId = await repository.startAiRun({
      contentId: String(contentId),
      taskType: AiTaskType.SCORE,
      provider: 'openai-compatible',
      model: 'gpt-4o-mini',
      promptVersion: 'v1',
    });

    await expect(
      repository.finishAiRun({
        aiRunId,
        // 不存在的 contentId → content.update 抛 P2025
        contentId: '999999999999',
        status: AiRunStatus.SUCCEEDED,
        inputTokens: 10,
        outputTokens: 5,
        estimatedCostUsd: 0.000001,
        durationMs: 100,
        errorCode: null,
        artifact: {
          kind: 'score',
          scoreUpdate: { importanceScore: 80, finalScore: 80 },
          recommendationReason: '应当回滚',
          aiAnalysis: { taskType: 'SCORE' },
        },
      }),
    ).rejects.toThrow();

    const run = await prisma.aiRun.findUniqueOrThrow({ where: { id: BigInt(aiRunId) } });
    expect(run.status).toBe(AiRunStatus.RUNNING);
  });

  it('未知的 EvidenceType 在边界立刻抛错（脏数据不许进 credibility 判断）', async () => {
    // 事件的多条证据来自不同来源 —— 顺带覆盖 sourceOfficial 的真实 join。
    const evidences = await repository.findEventEvidences(String(eventId));
    expect(evidences.length).toBeGreaterThan(0);
    for (const item of evidences) {
      expect(item.sourceOfficial).toBe(true); // 三条证据都挂在本测试的官方来源上
    }

    // 直接验证收敛函数：库里出现契约没有的值时必须炸，而不是带进上下文。
    expect(() => toContractEvidenceType('BOGUS_TYPE' as never)).toThrow(/Unexpected EvidenceType/);
  });

  it('读库把 Prisma 枚举收敛成契约枚举（枚举桥接的读取方向）', async () => {
    const evidences = await repository.findEventEvidences(String(eventId));
    for (const item of evidences) {
      expect(Object.values(EvidenceType)).toContain(item.evidenceType);
      expect(isValidErrorCode('AI_REQUEST_FAILED')).toBe(true); // 顺带确认契约守卫可用
    }
  });
});
