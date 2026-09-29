/**
 * 日报 / 精选仓储的真库集成测试 —— **真实 MySQL 8.4**。
 *
 * 运行：`pnpm --filter @signal/api test:integration`
 *
 * ── 为什么这几条必须打真库 ──────────────────────────────────────────
 * 单元测试里仓储被内存替身挡掉了，于是下面这些**一个都验不到**：
 *
 * 1. **`businessDate` 是 `@db.Date`** —— 它是「业务日」这个概念的落地点。
 *    替身里 `businessDate` 就是个字符串，而真库里是 `Date`，
 *    读写之间任何时区偏移都会让业务日整体偏一天。
 *    这是**最容易写错、也最难发现**的一类 bug（东八区 +8 小时写出来的
 *    日期仍是「对的那天」，只有跨月/跨年边界才露馅）。
 * 2. **`replaceSections` 的级联删除**真的会带走 `daily_items`
 *    （`onDelete: Cascade` 写在 schema 里，但只有真库会执行它）。
 * 3. **`@@unique([sectionId, sortOrder])` / `@@unique([editionId, sortOrder])`
 *    真的存在** —— `preflight.ts` 明确说「DB 层有唯一约束兜底」，
 *    那句注释必须是真的。
 * 4. **`markPublished` 的条件更新真的只发布一次**（`updateMany` + WHERE
 *    在 MySQL 里是原子的，但那要靠真库验证）。
 * 5. **`edition_no` 的唯一约束真的挡得住重复期号**。
 *
 * 不静默跳过：连不上库就直接失败。测试数据带唯一后缀，`afterAll` 全部清理。
 */

import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import {
  ContentPipelineStatus,
  DailyDisplayStyle,
  DailyEditionStatus,
  DailySectionType,
} from '@signal/contracts';
import { PrismaDailyRepository } from '../src/modules/daily/prisma-daily.repository';
import { PrismaFeaturedRepository } from '../src/modules/featured/prisma-featured.repository';
import type { SectionInput } from '../src/modules/daily/repository';

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
const daily = new PrismaDailyRepository(prisma as never);
const featured = new PrismaFeaturedRepository(prisma as never);

let sourceId: bigint;
let contentA: bigint;
let contentB: bigint;

/** 一个固定的业务日（不会与 Agent 01 的 seed 或其它测试撞车）。 */
const BUSINESS_DATE = '2019-03-07';

/** 另一期（用来验期号分配与唯一约束）。 */
const OTHER_DATE = '2019-03-08';

function sectionsWith(items: { contentId: bigint; style: DailyDisplayStyle }[]): SectionInput[] {
  return [
    {
      type: DailySectionType.FRONT_PAGE,
      title: '首页',
      sortOrder: 0,
      items: items.map((item, index) => ({
        contentId: String(item.contentId),
        displayStyle: item.style,
        sortOrder: index,
        customHeadline: null,
        customExcerpt: null,
      })),
    },
  ];
}

beforeAll(async () => {
  const source = await prisma.source.create({
    data: {
      name: `Daily IT ${SUFFIX}`,
      slug: `daily-it-${SUFFIX}`,
      type: 'RSS',
      kind: 'OFFICIAL',
      tier: 'S',
      official: true,
      config: { seed: false },
    },
    select: { id: true },
  });
  sourceId = source.id;

  const a = await prisma.content.create({
    data: {
      sourceId,
      type: 'ARTICLE',
      title: '日报集成测试：某模型发布新版本',
      language: 'zh',
      originalUrl: `https://example.com/daily-it-${SUFFIX}/a`,
      pipelineStatus: ContentPipelineStatus.APPROVED,
      review: {
        create: { status: 'APPROVED', publishFeatured: true, includeDailyCandidate: true },
      },
    },
    select: { id: true },
  });
  contentA = a.id;

  const b = await prisma.content.create({
    data: {
      sourceId,
      type: 'ARTICLE',
      title: '日报集成测试：另一条内容',
      language: 'zh',
      originalUrl: `https://example.com/daily-it-${SUFFIX}/b`,
      pipelineStatus: ContentPipelineStatus.REVIEW_PENDING,
      review: {
        create: { status: 'PENDING', publishFeatured: false, includeDailyCandidate: false },
      },
    },
    select: { id: true },
  });
  contentB = b.id;
});

afterAll(async () => {
  // 顺序：先删引用的，再删被引用的（外键约束）。
  await prisma.dailyEdition.deleteMany({
    where: {
      businessDate: {
        in: [new Date(`${BUSINESS_DATE}T00:00:00.000Z`), new Date(`${OTHER_DATE}T00:00:00.000Z`)],
      },
    },
  });
  await prisma.featuredItem.deleteMany({ where: { contentId: { in: [contentA, contentB] } } });
  await prisma.editorialReview.deleteMany({ where: { contentId: { in: [contentA, contentB] } } });
  await prisma.content.deleteMany({ where: { id: { in: [contentA, contentB] } } });
  await prisma.source.deleteMany({ where: { id: sourceId } });
  await prisma.$disconnect();
});

describe('业务日（@db.Date）的往返', () => {
  it('写进去 `2019-03-07`，读出来还是 `2019-03-07`（不偏一天）', async () => {
    await prisma.dailyEdition.deleteMany({
      where: { businessDate: new Date(`${BUSINESS_DATE}T00:00:00.000Z`) },
    });

    const created = await daily.ensureDraft(BUSINESS_DATE);
    expect(created.businessDate).toBe(BUSINESS_DATE);

    const read = await daily.findByBusinessDate(BUSINESS_DATE);
    expect(read?.businessDate).toBe(BUSINESS_DATE);
  });

  it('跨年边界的业务日也不偏（`2019-01-01` 与 `2019-12-31`）', async () => {
    for (const date of ['2019-01-01', '2019-12-31']) {
      await prisma.dailyEdition.deleteMany({
        where: { businessDate: new Date(`${date}T00:00:00.000Z`) },
      });
      const created = await daily.ensureDraft(date);
      expect(created.businessDate, date).toBe(date);
      await prisma.dailyEdition.deleteMany({
        where: { businessDate: new Date(`${date}T00:00:00.000Z`) },
      });
    }
  });

  it('日期范围查询用的是业务日，不受时区影响', async () => {
    const rows = await daily.listByDateRange({ from: '2019-03-01', to: '2019-04-01' });
    expect(rows.map((row) => row.businessDate)).toContain(BUSINESS_DATE);
  });
});

describe('ensureDraft 的幂等', () => {
  it('重复调用只建一行（靠 business_date 唯一约束 + 撞车读回）', async () => {
    await daily.ensureDraft(BUSINESS_DATE);
    await daily.ensureDraft(BUSINESS_DATE);

    const count = await prisma.dailyEdition.count({
      where: { businessDate: new Date(`${BUSINESS_DATE}T00:00:00.000Z`) },
    });
    expect(count).toBe(1);
  });
});

describe('replaceSections 的原子性与级联', () => {
  it('整体替换会**删掉旧条目**（级联删除真的生效），不是累加', async () => {
    const edition = await daily.ensureDraft(BUSINESS_DATE);

    await daily.replaceSections(
      edition.editionId,
      sectionsWith([{ contentId: contentA, style: DailyDisplayStyle.LEAD }]),
    );
    const first = await daily.detail(edition.editionId);
    expect(first?.sections[0]?.items).toHaveLength(1);

    // 换成另一条 —— 旧的必须消失
    await daily.replaceSections(
      edition.editionId,
      sectionsWith([{ contentId: contentB, style: DailyDisplayStyle.LEAD }]),
    );
    const second = await daily.detail(edition.editionId);
    expect(second?.sections[0]?.items.map((item) => item.contentId)).toEqual([String(contentB)]);
  });

  it('替换之后**旧条目行真的没了**（不是只是查不到）', async () => {
    const edition = await daily.ensureDraft(BUSINESS_DATE);
    await daily.replaceSections(
      edition.editionId,
      sectionsWith([{ contentId: contentA, style: DailyDisplayStyle.LEAD }]),
    );
    await daily.replaceSections(
      edition.editionId,
      sectionsWith([{ contentId: contentB, style: DailyDisplayStyle.LEAD }]),
    );

    const items = await prisma.dailyItem.findMany({
      where: { section: { editionId: BigInt(edition.editionId) } },
      select: { contentId: true },
    });
    expect(items.map((item) => String(item.contentId))).toEqual([String(contentB)]);
  });

  it('条目能带出内容预览（join 到 contents / sources）', async () => {
    const edition = await daily.ensureDraft(BUSINESS_DATE);
    await daily.replaceSections(
      edition.editionId,
      sectionsWith([{ contentId: contentA, style: DailyDisplayStyle.LEAD }]),
    );

    const detail = await daily.detail(edition.editionId);
    const content = detail?.sections[0]?.items[0]?.content;
    expect(content?.title).toBe('日报集成测试：某模型发布新版本');
    expect(content?.source.name).toBe(`Daily IT ${SUFFIX}`);
    expect(content?.pipelineStatus).toBe(ContentPipelineStatus.APPROVED);
  });

  it('`@@unique([sectionId, sortOrder])` 真的存在（preflight 靠它兜底）', async () => {
    const edition = await daily.ensureDraft(BUSINESS_DATE);
    await daily.replaceSections(
      edition.editionId,
      sectionsWith([{ contentId: contentA, style: DailyDisplayStyle.LEAD }]),
    );

    const section = await prisma.dailySection.findFirst({
      where: { editionId: BigInt(edition.editionId) },
      select: { id: true },
    });

    // 绕过服务层直接写一条同 sortOrder 的条目 —— 必须被约束挡住
    await expect(
      prisma.dailyItem.create({
        data: {
          sectionId: section!.id,
          contentId: contentB,
          displayStyle: DailyDisplayStyle.STANDARD,
          sortOrder: 0, // 与已有那条同号
        },
        select: { id: true },
      }),
    ).rejects.toThrow();
  });

  it('`@@unique([editionId, sortOrder])` 真的存在', async () => {
    const edition = await daily.ensureDraft(BUSINESS_DATE);

    await expect(
      prisma.dailySection.create({
        data: {
          editionId: BigInt(edition.editionId),
          type: DailySectionType.AI,
          title: 'AI',
          sortOrder: 0, // 与 replaceSections 建的那个同号
        },
        select: { id: true },
      }),
    ).rejects.toThrow();
  });
});

describe('markPublished 的原子性', () => {
  it('第一次真的发布，并写入期号', async () => {
    const edition = await daily.ensureDraft(OTHER_DATE);
    const published = await daily.markPublished(edition.editionId, {
      editionNo: 9001,
      publishedAt: new Date('2019-03-08T00:00:00.000Z'),
    });

    expect(published?.status).toBe(DailyEditionStatus.PUBLISHED);
    expect(published?.editionNo).toBe(9001);
  });

  it('第二次（同一期）返回 `null` —— **不会**覆盖期号或时间', async () => {
    const edition = await daily.findByBusinessDate(OTHER_DATE);
    const again = await daily.markPublished(edition!.editionId, {
      editionNo: 9002,
      publishedAt: new Date('2019-03-09T00:00:00.000Z'),
    });

    expect(again).toBeNull();
    const current = await daily.findByBusinessDate(OTHER_DATE);
    expect(current?.editionNo).toBe(9001);
  });

  it('`edition_no` 的唯一约束真的存在（绕过服务层直接写同号会被拒）', async () => {
    const edition = await daily.findByBusinessDate(BUSINESS_DATE);

    await expect(
      prisma.dailyEdition.update({
        where: { id: BigInt(edition!.editionId) },
        data: { editionNo: 9001 }, // 已被 OTHER_DATE 占用
        select: { id: true },
      }),
    ).rejects.toThrow();
  });

  it('⚠ 期号撞车时 `markPublished` 会**重新数一次**并成功（这是并发下的正确行为）', async () => {
    // 真实里唯一会让期号撞车的场景是「手动发布与定时发布同时发生」——
    // 两个调用各自算出同一个号。此时正确反应是重算，而不是把整个发布失败掉。
    //
    // 这条**断言的是恢复后的成功**，而不是抛错：
    // 第一版写成 `rejects.toThrow()`，结果它「失败」了 —— 但那不是 bug，
    // 是重试逻辑在正常工作。把它拆成两条之后，
    // 上面那条验约束、这条验恢复，各自说清一件事。
    await prisma.dailyEdition.deleteMany({
      where: { businessDate: new Date('2019-03-10T00:00:00.000Z') },
    });
    const edition = await daily.ensureDraft('2019-03-10');
    await prisma.dailyEdition.update({
      where: { id: BigInt(edition.editionId) },
      data: { status: DailyEditionStatus.SCHEDULED },
    });

    const published = await daily.markPublished(edition.editionId, {
      editionNo: 9001, // 已被占用 → 撞车
      publishedAt: new Date('2019-03-10T00:00:00.000Z'),
    });

    expect(published?.status).toBe(DailyEditionStatus.PUBLISHED);
    // 被重新分配到一个当前空闲的号，而不是复用了别人那个
    expect(published?.editionNo).not.toBe(9001);
    expect(published?.editionNo).toBeGreaterThan(0);

    await prisma.dailyEdition.deleteMany({
      where: { businessDate: new Date('2019-03-10T00:00:00.000Z') },
    });
  });
});

describe('对外可见性', () => {
  it('未发布的期次 `findPublishedDetail` 返回 `null`（docs/10）', async () => {
    const edition = await daily.ensureDraft(BUSINESS_DATE);
    await prisma.dailyEdition.update({
      where: { id: BigInt(edition.editionId) },
      data: { status: DailyEditionStatus.DRAFT },
    });
    expect(await daily.findPublishedDetail(BUSINESS_DATE)).toBeNull();
  });

  it('发布之后能读到（且带版块）', async () => {
    await prisma.dailyEdition.update({
      where: { businessDate: new Date(`${BUSINESS_DATE}T00:00:00.000Z`) },
      data: { status: DailyEditionStatus.PUBLISHED },
    });

    const detail = await daily.findPublishedDetail(BUSINESS_DATE);
    expect(detail?.edition.status).toBe(DailyEditionStatus.PUBLISHED);
    expect(detail?.sections.length).toBeGreaterThan(0);
  });

  it('归档**只返回 PUBLISHED**', async () => {
    // OTHER_DATE 是 PUBLISHED，BUSINESS_DATE 也是 —— 造一个 DRAFT 的
    await prisma.dailyEdition.deleteMany({
      where: { businessDate: new Date('2019-03-09T00:00:00.000Z') },
    });
    await daily.ensureDraft('2019-03-09');

    const archive = await daily.listArchive({ from: '2019-03-01', to: '2019-04-01' });
    expect(archive.map((row) => row.businessDate)).not.toContain('2019-03-09');
    expect(archive.every((row) => row.status === DailyEditionStatus.PUBLISHED)).toBe(true);

    await prisma.dailyEdition.deleteMany({
      where: { businessDate: new Date('2019-03-09T00:00:00.000Z') },
    });
  });
});

describe('内容的准入校验', () => {
  it('批量读内容状态（APPROVED 与 REVIEW_PENDING 各自读对）', async () => {
    const statuses = await daily.findContentStatuses([String(contentA), String(contentB)]);
    expect(statuses.get(String(contentA))).toBe(ContentPipelineStatus.APPROVED);
    expect(statuses.get(String(contentB))).toBe(ContentPipelineStatus.REVIEW_PENDING);
  });

  it('不存在的 id **不在返回值里**（用「查不到」表达「不存在」）', async () => {
    const statuses = await daily.findContentStatuses(['999999999999']);
    expect(statuses.size).toBe(0);
  });

  it('超界 id 被忽略而不是抛驱动层异常（BIGINT 有符号绑定）', async () => {
    // 18446744073709551615 是 BIGINT UNSIGNED 的合法上限，
    // 但 Prisma 按**有符号** 64 位绑定 —— 它会抛 UnknownRequestError。
    // 本模块在边界上收敛成「忽略」。
    const statuses = await daily.findContentStatuses(['18446744073709551615', String(contentA)]);
    expect(statuses.get(String(contentA))).toBe(ContentPipelineStatus.APPROVED);
    expect(statuses.has('18446744073709551615')).toBe(false);
  });
});

describe('精选的真库语义', () => {
  it('已 APPROVED + 勾选 Featured 的内容能进，且唯一约束挡住重复', async () => {
    await prisma.featuredItem.deleteMany({ where: { contentId: contentA } });

    const first = await featured.create({
      contentId: String(contentA),
      customTitle: '编辑写的标题',
      customSummary: null,
      sortWeight: 5,
      publishedAt: new Date('2019-03-07T00:00:00.000Z'),
    });
    expect(first?.contentId).toBe(String(contentA));

    // 撞唯一约束 → `null`（不是抛异常，也不是先查后写）
    const second = await featured.create({
      contentId: String(contentA),
      customTitle: null,
      customSummary: null,
      sortWeight: 0,
      publishedAt: new Date('2019-03-07T00:00:00.000Z'),
    });
    expect(second).toBeNull();
  });

  it('`findContentGate` 读出两道门的真实状态', async () => {
    const gate = await featured.findContentGate(String(contentA));
    expect(gate).toMatchObject({
      pipelineStatus: ContentPipelineStatus.APPROVED,
      publishFeatured: true,
    });

    const other = await featured.findContentGate(String(contentB));
    expect(other).toMatchObject({
      pipelineStatus: ContentPipelineStatus.REVIEW_PENDING,
      publishFeatured: false,
    });
  });

  it('公开列表过滤掉「内容已被撤下」的精选项', async () => {
    // 把 contentA 撤下，精选项仍在
    await prisma.content.update({
      where: { id: contentA },
      data: { pipelineStatus: ContentPipelineStatus.REJECTED },
    });

    const publicList = await featured.list({ publicOnly: true, limit: 50 });
    expect(publicList.rows.map((row) => row.contentId)).not.toContain(String(contentA));

    const adminList = await featured.list({ publicOnly: false, limit: 50 });
    expect(adminList.rows.map((row) => row.contentId)).toContain(String(contentA));

    // 还原，避免影响后续
    await prisma.content.update({
      where: { id: contentA },
      data: { pipelineStatus: ContentPipelineStatus.APPROVED },
    });
  });

  it('改自定义标题/摘要/权重/上下架会真的落库', async () => {
    const updated = await featured.update({
      contentId: String(contentA),
      customTitle: '改过的标题',
      sortWeight: 42,
      active: false,
    });
    expect(updated).toMatchObject({ customTitle: '改过的标题', sortWeight: 42, active: false });

    const readBack = await featured.findFeatured(String(contentA));
    expect(readBack?.active).toBe(false);
  });
});
