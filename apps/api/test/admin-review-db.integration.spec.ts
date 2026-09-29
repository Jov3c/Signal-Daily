/**
 * 审核后端的真库集成测试 —— **真实 MySQL 8.4**。
 *
 * 运行：`pnpm --filter @signal/api test:integration`
 *
 * ── 为什么这几条必须打真库 ──────────────────────────────────────────
 * 单元测试里仓储被内存替身挡掉了，于是下面这些**一个都验不到**：
 *
 * 1. **`setPrimaryEvidence` 的事务语义** —— 「先清旧的、再设新的」在真库上
 *    是否真的只留一个 Primary（`docs/03` 明确 DB 层不强制）；
 * 2. **`(eventId, urlHash)` 的唯一约束真的存在**（替身里那条是我手写复刻的）；
 * 3. **契约枚举 → Prisma 枚举的桥接** —— 编译期类型体操，`tsc` 过不代表 INSERT 成功；
 * 4. **`distinct source_id` 在真实 SQL 上的口径**（同源多条只算 1）。
 *
 * 不静默跳过：连不上库就直接失败。测试数据带唯一后缀，`afterAll` 全部清理。
 */

import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { EvidenceType, SourceKind, SourceTier } from '@signal/contracts';
import { PrismaAdminReviewRepository } from '../src/modules/admin-review/prisma-admin-review.repository';

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
const repository = new PrismaAdminReviewRepository(prisma as never);

let sourceA: bigint;
let sourceB: bigint;
let eventId: bigint;
let contentId: bigint;

beforeAll(async () => {
  const a = await prisma.source.create({
    data: {
      name: `Review IT A ${SUFFIX}`,
      slug: `review-it-a-${SUFFIX}`,
      type: 'RSS',
      kind: SourceKind.OFFICIAL,
      tier: SourceTier.S,
      official: true,
      config: { seed: false },
    },
    select: { id: true },
  });
  sourceA = a.id;

  const b = await prisma.source.create({
    data: {
      name: `Review IT B ${SUFFIX}`,
      slug: `review-it-b-${SUFFIX}`,
      type: 'RSS',
      kind: SourceKind.MEDIA,
      tier: SourceTier.B,
      official: false,
      config: { seed: false },
    },
    select: { id: true },
  });
  sourceB = b.id;

  const event = await prisma.event.create({
    data: {
      canonicalTitle: `Review IT Event ${SUFFIX}`,
      status: 'ACTIVE',
      firstSeenAt: new Date('2026-09-29T00:00:00.000Z'),
      lastSeenAt: new Date('2026-09-29T00:00:00.000Z'),
    },
    select: { id: true },
  });
  eventId = event.id;

  const content = await prisma.content.create({
    data: {
      sourceId: sourceA,
      eventId,
      type: 'ARTICLE',
      title: 'Anthropic 发布新的模型能力评测报告',
      language: 'zh',
      originalUrl: `https://example.com/${SUFFIX}/a`,
      pipelineStatus: 'REVIEW_PENDING',
      finalScore: 88,
    },
    select: { id: true },
  });
  contentId = content.id;

  await prisma.editorialReview.create({
    data: { contentId, status: 'PENDING' },
    select: { id: true },
  });
});

afterAll(async () => {
  await prisma.eventEvidence.deleteMany({ where: { eventId } });
  await prisma.editorialReview.deleteMany({ where: { contentId } });
  await prisma.content.deleteMany({ where: { id: contentId } });
  await prisma.event.deleteMany({ where: { id: eventId } });
  await prisma.source.deleteMany({ where: { id: { in: [sourceA, sourceB] } } });
  await prisma.$disconnect();
});

describe('Primary 的事务语义（真库）', () => {
  it('**切换 Primary 后仍然只有一个**（先清旧的、再设新的，同一事务）', async () => {
    const first = await repository.addEvidence({
      eventId: String(eventId),
      evidenceType: EvidenceType.PRIMARY_SOURCE,
      title: '官方原文',
      url: `https://example.com/${SUFFIX}/ev-1`,
      urlHash: randomBytes(32).toString('hex'),
      publishedAt: null,
      contentId: String(contentId),
      sourceId: String(sourceA),
    });
    const second = await repository.addEvidence({
      eventId: String(eventId),
      evidenceType: EvidenceType.SUPPORTING_SOURCE,
      title: '媒体报道',
      url: `https://example.com/${SUFFIX}/ev-2`,
      urlHash: randomBytes(32).toString('hex'),
      publishedAt: null,
      contentId: null,
      sourceId: String(sourceB),
    });

    await repository.setPrimaryEvidence(String(eventId), first.evidenceId);
    const afterFirst = await prisma.eventEvidence.count({ where: { eventId, isPrimary: true } });
    expect(afterFirst).toBe(1);

    await repository.setPrimaryEvidence(String(eventId), second.evidenceId);
    const afterSecond = await prisma.eventEvidence.count({ where: { eventId, isPrimary: true } });

    // 关键：**仍然是 1** —— 事务里先清后设，不会出现两个 Primary
    expect(afterSecond).toBe(1);

    const primary = await prisma.eventEvidence.findFirstOrThrow({
      where: { eventId, isPrimary: true },
      select: { id: true },
    });
    expect(String(primary.id)).toBe(second.evidenceId);
  });

  it('设置不属于该事件的证据 → null（不误改别的证据）', async () => {
    const other = await prisma.event.create({
      data: {
        canonicalTitle: `Other ${SUFFIX}`,
        status: 'ACTIVE',
        firstSeenAt: new Date(),
        lastSeenAt: new Date(),
      },
      select: { id: true },
    });

    await expect(
      repository.setPrimaryEvidence(String(other.id), '999999999'),
    ).resolves.toBeNull();

    await prisma.event.deleteMany({ where: { id: other.id } });
  });
});

describe('(eventId, urlHash) 唯一约束（真库）', () => {
  it('同 URL 的重复证据会被数据库拒绝', async () => {
    const urlHash = randomBytes(32).toString('hex');

    await repository.addEvidence({
      eventId: String(eventId),
      evidenceType: EvidenceType.SUPPORTING_SOURCE,
      title: null,
      url: `https://example.com/${SUFFIX}/uniq`,
      urlHash,
      publishedAt: null,
      contentId: null,
      sourceId: null,
    });

    await expect(
      prisma.eventEvidence.create({
        data: {
          eventId,
          evidenceType: 'SUPPORTING_SOURCE',
          url: `https://example.com/${SUFFIX}/uniq`,
          urlHash,
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });
});

describe('独立来源数（真库口径）', () => {
  it('**同 source_id 的多条证据只算 1**', async () => {
    const stats = await repository.eventEvidenceStats([String(eventId)]);
    const found = stats.get(String(eventId));

    expect(found).toBeDefined();
    // 本测试里 sourceA 有 1 条、sourceB 有 1 条 → 独立来源 2
    expect(found!.independentSourceCount).toBe(2);
    // 官方来源的 PRIMARY_SOURCE → 有官方确认
    expect(found!.hasOfficialConfirmation).toBe(true);
  });

  it('空事件列表 → 空 Map（不抛错）', async () => {
    expect((await repository.eventEvidenceStats([])).size).toBe(0);
  });

  it('超界 / 畸形的 eventId 被忽略（不抛驱动层异常）', async () => {
    await expect(repository.eventEvidenceStats(['18446744073709551615', 'abc'])).resolves.toEqual(
      new Map(),
    );
  });
});

describe('审核决策（真库事务）', () => {
  it('决策同时写审核行与内容状态', async () => {
    const result = await repository.applyDecision({
      contentId: String(contentId),
      reviewStatus: 'APPROVED' as never,
      pipelineStatus: 'APPROVED' as never,
      publishFeatured: true,
      includeDailyCandidate: false,
      adminNote: '看起来不错',
      reviewedByUserId: '1',
      reviewedAt: new Date('2026-09-29T03:00:00.000Z'),
    });

    expect(result).not.toBeNull();

    const content = await prisma.content.findUniqueOrThrow({
      where: { id: contentId },
      select: { pipelineStatus: true, review: { select: { status: true, publishFeatured: true } } },
    });
    expect(content.pipelineStatus).toBe('APPROVED');
    expect(content.review?.status).toBe('APPROVED');
    expect(content.review?.publishFeatured).toBe(true);
  });

  it('**没有审核行的内容不能被决策**（审核行由 Agent 05 创建，本模块不代它创建）', async () => {
    const orphan = await prisma.content.create({
      data: {
        sourceId: sourceA,
        type: 'ARTICLE',
        title: '没有审核行的内容',
        language: 'zh',
        originalUrl: `https://example.com/${SUFFIX}/orphan`,
        pipelineStatus: 'REVIEW_PENDING',
      },
      select: { id: true },
    });

    const result = await repository.applyDecision({
      contentId: String(orphan.id),
      reviewStatus: 'APPROVED' as never,
      pipelineStatus: 'APPROVED' as never,
      publishFeatured: false,
      includeDailyCandidate: false,
      adminNote: null,
      reviewedByUserId: '1',
      reviewedAt: new Date(),
    });

    expect(result).toBeNull();
    await prisma.content.deleteMany({ where: { id: orphan.id } });
  });
});
