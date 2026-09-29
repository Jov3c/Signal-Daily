/**
 * worker 侧发布仓储的真库集成测试 —— **真实 MySQL 8.4**。
 *
 * 运行：`REDIS_URL=redis://127.0.0.1:6390 pnpm --filter @signal/worker test:integration`
 *
 * ── ⚠ 这个文件是 §23 独立审查的 P1 修复（起因值得写下来）──────────────
 *
 * 审查指出：`prisma-publishing.repository.ts`（297 行）在**整个测试目录树里**
 * **grep 0 命中**。本仓库对**其它每一个持久化层**都有真库集成测试
 *（collectors-db / content-db / ai-db / daily-db），**唯独 worker publishing 没有**。
 *
 * 最尖锐的一条证据不是「少了一个测试」，而是**替身把这个洞藏起来了**：
 * `test/support/publishing-fakes.ts` 里 `snapshot()` 的内容状态**写死成
 * `APPROVED`**，所以
 *
 * ```text
 * 任务书「必测」项「REJECTED 阻断」在 08:00 自动发布这条路径上永远测不出来。
 * ```
 *
 * 它只被 `preflightEdition` 纯函数与 api 手动路径覆盖。而 worker 路径的
 * `contentStatus` 来自**零覆盖**的 `snapshot()` —— **漏一个 select，
 * worker 会照发一篇已被撤回的内容，而 1600+ 项测试全绿**。
 * 这正是 Agent 06 的 P0 的形状（「集成测试自己拼字面量、从没调用过 builder」）。
 *
 * 所以本文件的核心是：**用真库把 worker 真正会读到的那些字段钉住**，
 * 尤其是内容状态。
 *
 * 不静默跳过：连不上库就直接失败。测试数据带唯一后缀，`afterAll` 全部清理。
 */

import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { ContentPipelineStatus, DailyEditionStatus } from '@signal/contracts';
import { PrismaPublishingRepository } from '../src/jobs/publishing/prisma-publishing.repository';
import { candidateWindow } from '../src/jobs/publishing/publishing.service';
import type { PublishingSectionInput } from '../src/jobs/publishing/publishing.repository';

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
const repository = new PrismaPublishingRepository(prisma as never);

/** 一个固定的业务日（不会与其它测试或 Agent 01 的 seed 撞车）。 */
const BUSINESS_DATE = '2019-05-10';
/** `candidateWindow('2019-05-10')` = UTC `[2019-05-09T00:00, 2019-05-10T00:00)`。 */
const WINDOW = candidateWindow(BUSINESS_DATE);

let sourceId: bigint;
let otherSourceId: bigint;

/** 造一条内容（或一条 `raw_items`/`editorial_reviews` 的组合）。 */
async function makeContent(input: {
  label: string;
  pipelineStatus: ContentPipelineStatus;
  publishedAt: Date | null;
  createdAt?: Date;
  includeDailyCandidate?: boolean;
  reviewStatus?: string;
  sourceId?: bigint;
  eventId?: bigint | null;
  contentType?: 'ARTICLE' | 'X_POST';
  finalScore?: number | null;
}): Promise<bigint> {
  const row = await prisma.content.create({
    data: {
      sourceId: input.sourceId ?? sourceId,
      type: input.contentType ?? 'ARTICLE',
      title: `发布 IT ${input.label} ${SUFFIX}`,
      language: 'zh',
      originalUrl: `https://example.com/pub-it-${SUFFIX}/${input.label}`,
      publishedAt: input.publishedAt,
      ...(input.createdAt === undefined ? {} : { createdAt: input.createdAt }),
      ...(input.finalScore === undefined ? {} : { finalScore: input.finalScore }),
      pipelineStatus: input.pipelineStatus,
      eventId: input.eventId ?? null,
      review: {
        create: {
          status: input.reviewStatus ?? 'APPROVED',
          // `docs/10` 的候选口径之一
          includeDailyCandidate: input.includeDailyCandidate ?? true,
          publishFeatured: false,
        },
      },
    },
    select: { id: true },
  });
  return row.id;
}

beforeAll(async () => {
  const source = await prisma.source.create({
    data: {
      name: `Publishing IT ${SUFFIX}`,
      slug: `publishing-it-${SUFFIX}`,
      type: 'RSS',
      kind: 'OFFICIAL',
      tier: 'S',
      official: true,
      config: { seed: false },
    },
    select: { id: true },
  });
  sourceId = source.id;

  const other = await prisma.source.create({
    data: {
      name: `Publishing IT B ${SUFFIX}`,
      slug: `publishing-it-b-${SUFFIX}`,
      type: 'RSS',
      kind: 'MEDIA',
      tier: 'B',
      official: false,
      config: { seed: false },
    },
    select: { id: true },
  });
  otherSourceId = other.id;
});

afterAll(async () => {
  await prisma.dailyEdition.deleteMany({
    where: { businessDate: new Date(`${BUSINESS_DATE}T00:00:00.000Z`) },
  });
  await prisma.content.deleteMany({ where: { sourceId: { in: [sourceId, otherSourceId] } } });
  await prisma.source.deleteMany({ where: { id: { in: [sourceId, otherSourceId] } } });
  await prisma.$disconnect();
});

/* ------------------------------------------------------------------ */
/* findCandidates —— 「每天上什么」就是这一条 SQL                       */
/* ------------------------------------------------------------------ */

describe('findCandidates 的候选口径（docs/10）', () => {
  it('只返回 APPROVED + includeDailyCandidate + review 已通过的', async () => {
    const good = await makeContent({
      label: 'good',
      pipelineStatus: ContentPipelineStatus.APPROVED,
      publishedAt: new Date('2019-05-09T12:00:00.000Z'),
    });
    // 三种**不该**进候选的：
    const pending = await makeContent({
      label: 'pending',
      pipelineStatus: ContentPipelineStatus.REVIEW_PENDING,
      publishedAt: new Date('2019-05-09T12:00:00.000Z'),
    });
    const notChosen = await makeContent({
      label: 'not-chosen',
      pipelineStatus: ContentPipelineStatus.APPROVED,
      publishedAt: new Date('2019-05-09T12:00:00.000Z'),
      includeDailyCandidate: false,
    });
    const reviewRejected = await makeContent({
      label: 'review-rejected',
      pipelineStatus: ContentPipelineStatus.APPROVED,
      publishedAt: new Date('2019-05-09T12:00:00.000Z'),
      reviewStatus: 'REJECTED',
    });

    const candidates = await repository.findCandidates({
      startUtc: WINDOW.startUtc,
      endUtc: WINDOW.endUtc,
      limit: 500,
    });
    const ids = candidates.map((candidate) => candidate.contentId);

    expect(ids).toContain(String(good));
    for (const [label, id] of [
      ['REVIEW_PENDING', pending],
      ['includeDailyCandidate=false', notChosen],
      ['review REJECTED', reviewRejected],
    ] as const) {
      expect(ids, `${label} 不该进候选`).not.toContain(String(id));
    }
  });

  it('业务窗口是半开区间 `[start, end)`（边界上的那条不该进）', async () => {
    const atStart = await makeContent({
      label: 'at-start',
      pipelineStatus: ContentPipelineStatus.APPROVED,
      publishedAt: WINDOW.startUtc,
    });
    const justBeforeStart = await makeContent({
      label: 'before-start',
      pipelineStatus: ContentPipelineStatus.APPROVED,
      publishedAt: new Date(WINDOW.startUtc.getTime() - 1),
    });
    const atEnd = await makeContent({
      label: 'at-end',
      pipelineStatus: ContentPipelineStatus.APPROVED,
      publishedAt: WINDOW.endUtc,
    });

    const ids = (
      await repository.findCandidates({
        startUtc: WINDOW.startUtc,
        endUtc: WINDOW.endUtc,
        limit: 500,
      })
    ).map((candidate) => candidate.contentId);

    expect(ids, 'start 是闭端').toContain(String(atStart));
    expect(ids, 'end 是开端').not.toContain(String(atEnd));
    expect(ids, 'start 之前不该进').not.toContain(String(justBeforeStart));
  });

  it('⚠ `published_at` 为空的用 `created_at` 兜底（否则这些内容**永远进不了日报**）', async () => {
    const inside = await makeContent({
      label: 'null-pub-inside',
      pipelineStatus: ContentPipelineStatus.APPROVED,
      publishedAt: null,
      createdAt: new Date('2019-05-09T12:00:00.000Z'),
    });
    const outside = await makeContent({
      label: 'null-pub-outside',
      pipelineStatus: ContentPipelineStatus.APPROVED,
      publishedAt: null,
      createdAt: new Date('2019-05-01T12:00:00.000Z'),
    });

    const ids = (
      await repository.findCandidates({
        startUtc: WINDOW.startUtc,
        endUtc: WINDOW.endUtc,
        limit: 500,
      })
    ).map((candidate) => candidate.contentId);

    expect(ids, 'created_at 在窗口内应当入选').toContain(String(inside));
    expect(ids, 'created_at 在窗口外不该入选').not.toContain(String(outside));
  });

  it('读物字段都读对了（来源 id/名/等级/官方、类型、分数、发布时间）', async () => {
    const id = await makeContent({
      label: 'fields',
      pipelineStatus: ContentPipelineStatus.APPROVED,
      publishedAt: new Date('2019-05-09T12:34:56.000Z'),
      finalScore: 87.65,
      sourceId: otherSourceId,
      contentType: 'X_POST',
    });

    const candidate = (
      await repository.findCandidates({
        startUtc: WINDOW.startUtc,
        endUtc: WINDOW.endUtc,
        limit: 500,
      })
    ).find((entry) => entry.contentId === String(id));

    expect(candidate).toMatchObject({
      sourceId: String(otherSourceId),
      sourceName: `Publishing IT B ${SUFFIX}`,
      sourceKind: 'MEDIA',
      sourceTier: 'B',
      official: false,
      contentType: 'X_POST',
      finalScore: 87.65,
      // ⚠ 保留 3 位毫秒 —— 截断会让同分内容的排序决胜键失去精度
      publishedAt: '2019-05-09T12:34:56.000Z',
    });
  });

  it('`published_at` 为空时 `publishedAt` 用 `created_at` 顶上（排序要有决胜键）', async () => {
    const id = await makeContent({
      label: 'null-pub-date',
      pipelineStatus: ContentPipelineStatus.APPROVED,
      publishedAt: null,
      createdAt: new Date('2019-05-09T08:00:00.000Z'),
    });

    const candidate = (
      await repository.findCandidates({
        startUtc: WINDOW.startUtc,
        endUtc: WINDOW.endUtc,
        limit: 500,
      })
    ).find((entry) => entry.contentId === String(id));

    expect(candidate?.publishedAt).toBe('2019-05-09T08:00:00.000Z');
  });

  it('`isEventPrimary` 读的是事件的 `primary_content_id`（docs/10 的「同 Event 1 条 Primary」）', async () => {
    const event = await prisma.event.create({
      data: {
        canonicalTitle: `Publishing IT Event ${SUFFIX}`,
        status: 'ACTIVE',
        firstSeenAt: new Date('2019-05-09T00:00:00.000Z'),
        lastSeenAt: new Date('2019-05-09T00:00:00.000Z'),
      },
      select: { id: true },
    });

    const primary = await makeContent({
      label: 'event-primary',
      pipelineStatus: ContentPipelineStatus.APPROVED,
      publishedAt: new Date('2019-05-09T10:00:00.000Z'),
      eventId: event.id,
    });
    const supporting = await makeContent({
      label: 'event-supporting',
      pipelineStatus: ContentPipelineStatus.APPROVED,
      publishedAt: new Date('2019-05-09T11:00:00.000Z'),
      eventId: event.id,
    });

    await prisma.event.update({
      where: { id: event.id },
      data: { primaryContentId: primary },
    });

    const candidates = await repository.findCandidates({
      startUtc: WINDOW.startUtc,
      endUtc: WINDOW.endUtc,
      limit: 500,
    });
    const byId = new Map(candidates.map((candidate) => [candidate.contentId, candidate]));

    expect(byId.get(String(primary))?.isEventPrimary).toBe(true);
    expect(byId.get(String(supporting))?.isEventPrimary).toBe(false);
    expect(byId.get(String(primary))?.eventId).toBe(String(event.id));
  });

  it('**没有任何事件主稿时 `isEventPrimary` 为 `true`**（否则会把它误判成 supporting 丢掉）', async () => {
    const event = await prisma.event.create({
      data: {
        canonicalTitle: `Publishing IT Event2 ${SUFFIX}`,
        status: 'ACTIVE',
        firstSeenAt: new Date('2019-05-09T00:00:00.000Z'),
        lastSeenAt: new Date('2019-05-09T00:00:00.000Z'),
      },
      select: { id: true },
    });

    const orphan = await makeContent({
      label: 'event-no-primary',
      pipelineStatus: ContentPipelineStatus.APPROVED,
      publishedAt: new Date('2019-05-09T10:00:00.000Z'),
      eventId: event.id,
    });

    const candidate = (
      await repository.findCandidates({
        startUtc: WINDOW.startUtc,
        endUtc: WINDOW.endUtc,
        limit: 500,
      })
    ).find((entry) => entry.contentId === String(orphan));

    expect(candidate?.isEventPrimary).toBe(true);
  });

  it('`limit` 真的生效（防止一次把整库读进内存）', async () => {
    const candidates = await repository.findCandidates({
      startUtc: WINDOW.startUtc,
      endUtc: WINDOW.endUtc,
      limit: 2,
    });
    expect(candidates.length).toBeLessThanOrEqual(2);
  });
});

/* ------------------------------------------------------------------ */
/* snapshot —— 发布前校验的唯一输入                                    */
/* ------------------------------------------------------------------ */

describe('snapshot 的内容状态是**真读出来的**（P1 的核心）', () => {
  it('⚠ **REJECTED 的内容在快照里就是 REJECTED**（否则 worker 会照发被撤回的内容）', async () => {
    const approved = await makeContent({
      label: 'snap-approved',
      pipelineStatus: ContentPipelineStatus.APPROVED,
      publishedAt: new Date('2019-05-09T12:00:00.000Z'),
    });
    const rejected = await makeContent({
      label: 'snap-rejected',
      pipelineStatus: ContentPipelineStatus.REJECTED,
      publishedAt: new Date('2019-05-09T12:00:00.000Z'),
    });
    const archived = await makeContent({
      label: 'snap-archived',
      pipelineStatus: ContentPipelineStatus.ARCHIVED,
      publishedAt: new Date('2019-05-09T12:00:00.000Z'),
    });

    const edition = await repository.ensureDraft(BUSINESS_DATE);
    const sections: PublishingSectionInput[] = [
      {
        type: 'FRONT_PAGE',
        title: '首页',
        sortOrder: 0,
        items: [
          { contentId: String(approved), displayStyle: 'LEAD', sortOrder: 0 },
          { contentId: String(rejected), displayStyle: 'STANDARD', sortOrder: 1 },
          { contentId: String(archived), displayStyle: 'STANDARD', sortOrder: 2 },
        ],
      },
    ];
    await repository.replaceSections(edition.editionId, sections);

    const snapshot = await repository.snapshot(edition.editionId);
    const byContentId = new Map(
      snapshot?.sections[0]?.items.map((item) => [item.contentId, item]) ?? [],
    );

    // 这三条断言就是「漏一个 select 会静默发错内容」的守门人：
    // 替身把状态写死成 APPROVED，所以**只有真库**能发现这里的错。
    expect(byContentId.get(String(approved))?.contentStatus).toBe('APPROVED');
    expect(byContentId.get(String(rejected))?.contentStatus).toBe('REJECTED');
    expect(byContentId.get(String(archived))?.contentStatus).toBe('ARCHIVED');
  });

  it('`source` 与 `originalUrl` 从内容里带出来（preflight 靠它们判完整性）', async () => {
    const id = await makeContent({
      label: 'snap-source',
      pipelineStatus: ContentPipelineStatus.APPROVED,
      publishedAt: new Date('2019-05-09T12:00:00.000Z'),
      sourceId: otherSourceId,
    });

    const edition = await repository.ensureDraft(BUSINESS_DATE);
    await repository.replaceSections(edition.editionId, [
      {
        type: 'FRONT_PAGE',
        title: '首页',
        sortOrder: 0,
        items: [{ contentId: String(id), displayStyle: 'LEAD', sortOrder: 0 }],
      },
    ]);

    const snapshot = await repository.snapshot(edition.editionId);
    expect(snapshot?.sections[0]?.items[0]).toMatchObject({
      contentExists: true,
      sourceName: `Publishing IT B ${SUFFIX}`,
      originalUrl: `https://example.com/pub-it-${SUFFIX}/snap-source`,
    });
  });

  it('版块与条目按 `sortOrder` 升序返回（不是插入顺序）', async () => {
    const a = await makeContent({
      label: 'order-a',
      pipelineStatus: ContentPipelineStatus.APPROVED,
      publishedAt: new Date('2019-05-09T12:00:00.000Z'),
    });
    const b = await makeContent({
      label: 'order-b',
      pipelineStatus: ContentPipelineStatus.APPROVED,
      publishedAt: new Date('2019-05-09T12:00:00.000Z'),
    });

    const edition = await repository.ensureDraft(BUSINESS_DATE);
    await repository.replaceSections(edition.editionId, [
      {
        type: 'AI',
        title: 'AI',
        sortOrder: 1,
        items: [{ contentId: String(b), displayStyle: 'MAJOR', sortOrder: 1 }],
      },
      {
        type: 'FRONT_PAGE',
        title: '首页',
        sortOrder: 0,
        items: [
          // 故意倒着给
          { contentId: String(b), displayStyle: 'STANDARD', sortOrder: 1 },
          { contentId: String(a), displayStyle: 'LEAD', sortOrder: 0 },
        ],
      },
    ]);

    const snapshot = await repository.snapshot(edition.editionId);
    expect(snapshot?.sections.map((section) => section.type)).toEqual(['FRONT_PAGE', 'AI']);
    expect(snapshot?.sections[0]?.items.map((item) => item.contentId)).toEqual([
      String(a),
      String(b),
    ]);
  });
});

/* ------------------------------------------------------------------ */
/* 草稿的建/替换/发布                                                   */
/* ------------------------------------------------------------------ */

describe('ensureDraft / replaceSections / markPublished 的真库行为', () => {
  it('`ensureDraft` 幂等：重复调用只建一行', async () => {
    await repository.ensureDraft(BUSINESS_DATE);
    await repository.ensureDraft(BUSINESS_DATE);

    const count = await prisma.dailyEdition.count({
      where: { businessDate: new Date(`${BUSINESS_DATE}T00:00:00.000Z`) },
    });
    expect(count).toBe(1);
    expect((await repository.findEdition(BUSINESS_DATE))?.businessDate).toBe(BUSINESS_DATE);
  });

  it('`replaceSections` 整体替换（旧条目被级联删掉，不是累加）', async () => {
    const a = await makeContent({
      label: 'replace-a',
      pipelineStatus: ContentPipelineStatus.APPROVED,
      publishedAt: new Date('2019-05-09T12:00:00.000Z'),
    });
    const b = await makeContent({
      label: 'replace-b',
      pipelineStatus: ContentPipelineStatus.APPROVED,
      publishedAt: new Date('2019-05-09T12:00:00.000Z'),
    });

    const edition = await repository.ensureDraft(BUSINESS_DATE);
    await repository.replaceSections(edition.editionId, [
      {
        type: 'FRONT_PAGE',
        title: '首页',
        sortOrder: 0,
        items: [{ contentId: String(a), displayStyle: 'LEAD', sortOrder: 0 }],
      },
    ]);
    await repository.replaceSections(edition.editionId, [
      {
        type: 'FRONT_PAGE',
        title: '首页',
        sortOrder: 0,
        items: [{ contentId: String(b), displayStyle: 'LEAD', sortOrder: 0 }],
      },
    ]);

    const items = await prisma.dailyItem.findMany({
      where: { section: { editionId: BigInt(edition.editionId) } },
      select: { contentId: true },
    });
    expect(items.map((item) => String(item.contentId))).toEqual([String(b)]);
  });

  it('`markPublished` 写状态 / 期号 / 时间，第二次返回 `null`（幂等）', async () => {
    await prisma.dailyEdition.deleteMany({
      where: { businessDate: new Date(`${BUSINESS_DATE}T00:00:00.000Z`) },
    });
    const edition = await repository.ensureDraft(BUSINESS_DATE);

    const published = await repository.markPublished(edition.editionId, {
      editionNo: 9101,
      publishedAt: new Date('2019-05-10T00:00:00.000Z'),
    });
    expect(published).toMatchObject({
      status: DailyEditionStatus.PUBLISHED,
      editionNo: 9101,
      publishedAt: '2019-05-10T00:00:00.000Z',
    });

    const again = await repository.markPublished(edition.editionId, {
      editionNo: 9102,
      publishedAt: new Date('2019-05-11T00:00:00.000Z'),
    });
    expect(again).toBeNull();

    const current = await repository.findEdition(BUSINESS_DATE);
    expect(current?.editionNo).toBe(9101);
  });

  it('`snapshot` 对不存在的期次返回 `null`（不是抛异常）', async () => {
    expect(await repository.snapshot('999999999')).toBeNull();
  });

  it('`findEdition` 对不存在的业务日返回 `null`', async () => {
    expect(await repository.findEdition('1999-01-01')).toBeNull();
  });
});
