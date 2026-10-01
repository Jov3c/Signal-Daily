/**
 * 公开读 / 搜索的真库集成测试 —— **真实 MySQL 8.4**。
 *
 * 运行：`REDIS_URL=redis://127.0.0.1:6390 pnpm --filter @signal/api test:integration`
 *
 * ── 这个文件覆盖任务书的「必测」清单 ─────────────────────────────────
 *
 * ```text
 * Public-only          可见性过滤真的在 SQL 里（APPROVED 之外的都读不到）
 * X whitelist          /x 只取 type=X_USER 且 enabled=true 的来源
 * disabled X excluded  停用的 X 来源，其内容从 /x 消失
 * search internal exclusion  搜索不返回未审核内容
 * evidence summary     独立来源数 / 主来源 / 官方确认
 * original source 必有 每条结果都带 source 与 originalUrl
 * cache invalidation   失效函数真的删掉键（另有单测）
 * ```
 *
 * ⚠ **搜索探针必须是中文**。Agent 01 的 P0 就是「用纯 ASCII 探针测中文搜索，
 * 一直是绿的」—— 默认 parser 会把整句中文当成一个 token，中文子串恒查不到。
 * 所以下面每一条搜索断言都用中文查询词。
 *
 * 不静默跳过：连不上库就直接失败。测试数据带唯一后缀，`afterAll` 全部清理。
 */

import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { ContentPipelineStatus, EvidenceType, SourceKind, SourceTier } from '@signal/contracts';
import { PrismaPublicReadRepository } from '../src/modules/public-read/prisma-public-read.repository';

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
const repository = new PrismaPublicReadRepository(prisma as never);

/** 一个独特的搜索词（保证只命中本文件造的内容）。 */
const UNIQUE_WORD = `信号探针${SUFFIX}`;

let rssSourceId: bigint;
let officialSourceId: bigint;
let xEnabledSourceId: bigint;
let xDisabledSourceId: bigint;

/** 造一条内容。 */
async function makeContent(input: {
  label: string;
  sourceId: bigint;
  status: ContentPipelineStatus;
  title?: string;
  publishedAt?: Date;
  finalScore?: number;
}): Promise<bigint> {
  const row = await prisma.content.create({
    data: {
      sourceId: input.sourceId,
      type: 'ARTICLE',
      title: input.title ?? `${UNIQUE_WORD} ${input.label}`,
      summary: `摘要 ${input.label}`,
      language: 'zh',
      originalUrl: `https://example.com/pubread-${SUFFIX}/${input.label}`,
      publishedAt: input.publishedAt ?? new Date(),
      pipelineStatus: input.status,
      ...(input.finalScore === undefined ? {} : { finalScore: input.finalScore }),
    },
    select: { id: true },
  });
  return row.id;
}

beforeAll(async () => {
  const makeSource = async (label: string, overrides: Record<string, unknown>): Promise<bigint> => {
    const row = await prisma.source.create({
      data: {
        name: `PublicRead IT ${label} ${SUFFIX}`,
        slug: `publicread-it-${label}-${SUFFIX}`,
        type: 'RSS',
        kind: SourceKind.MEDIA,
        tier: SourceTier.B,
        official: false,
        enabled: true,
        config: { seed: false },
        ...overrides,
      },
      select: { id: true },
    });
    return row.id;
  };

  rssSourceId = await makeSource('rss', {});
  // 官方一手源（用于 `primarySource` / 官方确认的断言）
  officialSourceId = await makeSource('official', {
    kind: SourceKind.OFFICIAL,
    tier: SourceTier.S,
    official: true,
  });
  xEnabledSourceId = await makeSource('x-on', { type: 'X_USER', kind: SourceKind.PERSON });
  xDisabledSourceId = await makeSource('x-off', {
    type: 'X_USER',
    kind: SourceKind.PERSON,
    enabled: false,
  });
});

afterAll(async () => {
  const sourceIds = [rssSourceId, officialSourceId, xEnabledSourceId, xDisabledSourceId];
  await prisma.content.deleteMany({ where: { sourceId: { in: sourceIds } } });
  await prisma.source.deleteMany({ where: { id: { in: sourceIds } } });
  await prisma.$disconnect();
});

/* ------------------------------------------------------------------ */
/* Public-only                                                         */
/* ------------------------------------------------------------------ */

describe('可见性：Public-only（docs/12）', () => {
  it('APPROVED 读得到；REVIEW_PENDING / REJECTED / ARCHIVED / INGESTED 一律读不到', async () => {
    const approved = await makeContent({
      label: 'vis-approved',
      sourceId: rssSourceId,
      status: ContentPipelineStatus.APPROVED,
    });

    const hidden = await Promise.all(
      [
        ContentPipelineStatus.REVIEW_PENDING,
        ContentPipelineStatus.REJECTED,
        ContentPipelineStatus.ARCHIVED,
        ContentPipelineStatus.INGESTED,
        ContentPipelineStatus.ANALYZING,
      ].map((status, index) =>
        makeContent({ label: `vis-hidden-${String(index)}`, sourceId: rssSourceId, status }),
      ),
    );

    expect(await repository.findContent(approved)).not.toBeNull();
    for (const id of hidden) {
      expect(await repository.findContent(id), `id=${String(id)} 不该可见`).toBeNull();
    }
  });

  it('⚠ 每条可见内容都带 source 与 originalUrl（`docs/04` 的硬要求）', async () => {
    const row = await repository.findContent(
      await makeContent({
        label: 'vis-source',
        sourceId: rssSourceId,
        status: ContentPipelineStatus.APPROVED,
      }),
    );

    expect(row?.source.name).toBe(`PublicRead IT rss ${SUFFIX}`);
    expect(row?.source.slug).toBe(`publicread-it-rss-${SUFFIX}`);
    expect(row?.originalUrl).toContain(`pubread-${SUFFIX}`);
    expect(row?.source.tier).toBe(SourceTier.B);
  });

  it('`findContent` 对**不可见**的内容返回 `null`（调用方转 404）', async () => {
    const rejected = await makeContent({
      label: 'vis-rejected',
      sourceId: rssSourceId,
      status: ContentPipelineStatus.REJECTED,
    });
    expect(await repository.findContent(rejected)).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* X 白名单                                                            */
/* ------------------------------------------------------------------ */

describe('X 动态：只由后台白名单决定（docs/04 / 规则 §12）', () => {
  it('只返回 `type = X_USER` 且 `enabled = true` 的来源下的内容', async () => {
    const fromX = await makeContent({
      label: 'x-on',
      sourceId: xEnabledSourceId,
      status: ContentPipelineStatus.APPROVED,
      publishedAt: new Date('2026-09-29T10:00:00.000Z'),
    });
    // 停用的 X 来源 —— 必须**不出现**
    const fromDisabledX = await makeContent({
      label: 'x-off',
      sourceId: xDisabledSourceId,
      status: ContentPipelineStatus.APPROVED,
      publishedAt: new Date('2026-09-29T11:00:00.000Z'),
    });
    // RSS 来源 —— 不是 X，也不该出现在 /x 里
    const fromRss = await makeContent({
      label: 'x-rss',
      sourceId: rssSourceId,
      status: ContentPipelineStatus.APPROVED,
      publishedAt: new Date('2026-09-29T12:00:00.000Z'),
    });

    const { rows } = await repository.listX({ limit: 50 });
    const ids = rows.map((row) => row.id);

    expect(ids, '启用的 X 来源应当入选').toContain(String(fromX));
    expect(ids, '⚠ 停用的 X 来源必须被排除').not.toContain(String(fromDisabledX));
    expect(ids, '非 X 来源不该出现在 /x').not.toContain(String(fromRss));
  });

  it('⚠ **停用** X 来源后，它已有的内容立刻从 /x 消失（不需要删内容）', async () => {
    const contentId = await makeContent({
      label: 'x-toggle',
      sourceId: xEnabledSourceId,
      status: ContentPipelineStatus.APPROVED,
      publishedAt: new Date('2026-09-29T13:00:00.000Z'),
    });

    let ids = (await repository.listX({ limit: 50 })).rows.map((row) => row.id);
    expect(ids).toContain(String(contentId));

    await prisma.source.update({ where: { id: xEnabledSourceId }, data: { enabled: false } });
    ids = (await repository.listX({ limit: 50 })).rows.map((row) => row.id);
    expect(ids, '停用后必须立刻消失').not.toContain(String(contentId));

    // 还原，避免影响其它用例
    await prisma.source.update({ where: { id: xEnabledSourceId }, data: { enabled: true } });
  });

  it('X 里也**只**返回 APPROVED 的内容', async () => {
    const pending = await makeContent({
      label: 'x-pending',
      sourceId: xEnabledSourceId,
      status: ContentPipelineStatus.REVIEW_PENDING,
    });
    const ids = (await repository.listX({ limit: 50 })).rows.map((row) => row.id);
    expect(ids).not.toContain(String(pending));
  });
});

/* ------------------------------------------------------------------ */
/* 搜索 + 中文（Agent 01 的 P0 形状）                                   */
/* ------------------------------------------------------------------ */

describe('搜索：FULLTEXT（`WITH PARSER ngram`）+ internal exclusion', () => {
  it('⚠ **中文查询词能命中**（用 ngram 索引；默认 parser 会恒返回 0 条）', async () => {
    const contentId = await makeContent({
      label: 'search-cn',
      sourceId: rssSourceId,
      status: ContentPipelineStatus.APPROVED,
      title: `${UNIQUE_WORD} 基础模型的能力评测与推理成本`,
    });

    const result = await repository.search({ query: UNIQUE_WORD, limit: 20, offset: 0 });
    expect(result.rows.map((row) => row.id)).toContain(String(contentId));

    // 中文子串（不是整句）也要能命中 —— 这正是 ngram 与默认 parser 的分水岭
    const substring = await repository.search({ query: '推理成本', limit: 20, offset: 0 });
    expect(
      substring.rows.map((row) => row.id),
      '⚠ 只命中整句、命中不了子串 → 说明索引不是 ngram（Agent 01 的 P0 复现）',
    ).toContain(String(contentId));
  });

  it('⚠ **搜索不返回未审核内容**（「search internal exclusion」）', async () => {
    const hidden = await Promise.all(
      [
        ContentPipelineStatus.REJECTED,
        ContentPipelineStatus.REVIEW_PENDING,
        ContentPipelineStatus.ARCHIVED,
      ].map((status, index) =>
        makeContent({
          label: `search-hidden-${String(index)}`,
          sourceId: rssSourceId,
          status,
          title: `${UNIQUE_WORD} 不该被搜到的 ${String(index)}`,
        }),
      ),
    );

    const result = await repository.search({ query: UNIQUE_WORD, limit: 50, offset: 0 });
    const ids = result.rows.map((row) => row.id);

    for (const id of hidden) {
      expect(ids, `id=${String(id)} 不该出现在搜索结果里`).not.toContain(String(id));
    }
    // 而可见的那条在
    expect(result.total).toBeGreaterThan(0);
  });

  it('搜索结果的每一条都带 source 与 originalUrl', async () => {
    const result = await repository.search({ query: UNIQUE_WORD, limit: 5, offset: 0 });
    for (const row of result.rows) {
      expect(row.source.name).toBeTruthy();
      expect(row.originalUrl).toContain('https://');
    }
  });

  it('`limit` / `offset` 真的生效，`total` 是命中总数', async () => {
    const first = await repository.search({ query: UNIQUE_WORD, limit: 1, offset: 0 });
    const second = await repository.search({ query: UNIQUE_WORD, limit: 1, offset: 1 });

    expect(first.rows).toHaveLength(1);
    expect(first.total).toBe(second.total);
    expect(first.rows[0]?.id).not.toBe(second.rows[0]?.id);
  });

  it('⚠ **SQL 注入防护**：查询词里的引号不会破坏语句（`Prisma.sql` 参数化）', async () => {
    // ⚠ **这条断言的是「不报错、不毁数据」，不是「返回 0 条」。**
    //
    // 走过两次弯路，都值得记下来：
    //   1. 第一版用 `${UNIQUE_WORD}' OR '1'='1` 并断言 0 条 —— 错的：
    //      `IN NATURAL LANGUAGE MODE` 会把查询串切词，其中**中文那半照样命中**，
    //      所以「返回若干条」是正确行为，不是注入成功。
    //   2. 换成纯拉丁 token 后仍然命中了行 —— ngram parser 会把注入串切成
    //      2-gram（`'1`、`1'`、`='` …），命中库里别的内容。
    //      也就是说「命中几条」在 ngram 下**与注入是否成功无关**。
    //
    // 所以判据换成真正能区分的两件事：
    //   · **不抛异常**（拼接字符串会直接把 SQL 语法搞坏 → 报错）
    //   · **表没被毁**（拼接执行的 `DROP TABLE` 才是注入的杀伤力）
    const survivor = await makeContent({
      label: 'injection-survivor',
      sourceId: rssSourceId,
      status: ContentPipelineStatus.APPROVED,
    });

    await expect(
      repository.search({ query: `zzz${SUFFIX}' OR '1'='1`, limit: 20, offset: 0 }),
    ).resolves.toBeDefined();

    await expect(
      repository.search({ query: `zzz${SUFFIX}'; DROP TABLE contents; --`, limit: 20, offset: 0 }),
    ).resolves.toBeDefined();

    expect(await prisma.content.findUnique({ where: { id: survivor } })).not.toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* 证据口径                                                            */
/* ------------------------------------------------------------------ */

describe('Evidence Summary（docs/04 / docs/06 / docs/22）', () => {
  it('独立来源数按 **distinct `source_id`** 算（同源多条只算 1）', async () => {
    const event = await prisma.event.create({
      data: {
        canonicalTitle: `PublicRead IT Event ${SUFFIX}`,
        status: 'ACTIVE',
        firstSeenAt: new Date('2026-09-29T00:00:00.000Z'),
        lastSeenAt: new Date('2026-09-29T00:00:00.000Z'),
      },
      select: { id: true },
    });

    const contentId = await makeContent({
      label: 'ev-content',
      sourceId: rssSourceId,
      status: ContentPipelineStatus.APPROVED,
    });
    await prisma.content.update({ where: { id: contentId }, data: { eventId: event.id } });

    // 同一个来源的两条证据（同源 → 只算 1 个独立来源）
    await prisma.eventEvidence.createMany({
      data: [
        {
          eventId: event.id,
          sourceId: officialSourceId,
          evidenceType: EvidenceType.PRIMARY_SOURCE,
          url: `https://example.com/ev-${SUFFIX}/1`,
          urlHash: `a${SUFFIX}1`.padEnd(64, '0'),
          isPrimary: true,
          title: '官方公告',
        },
        {
          eventId: event.id,
          sourceId: officialSourceId,
          evidenceType: EvidenceType.SUPPORTING_SOURCE,
          url: `https://example.com/ev-${SUFFIX}/2`,
          urlHash: `a${SUFFIX}2`.padEnd(64, '0'),
          isPrimary: false,
          title: '同一来源的第二条',
        },
        // 另一个独立来源
        {
          eventId: event.id,
          sourceId: rssSourceId,
          evidenceType: EvidenceType.RELATED_DISCUSSION,
          url: `https://example.com/ev-${SUFFIX}/3`,
          urlHash: `a${SUFFIX}3`.padEnd(64, '0'),
          isPrimary: false,
          title: '另一家的报道',
        },
      ],
    });

    const row = await repository.findContent(contentId);

    // 三条证据、但只有 2 个 distinct source
    expect(row?.evidenceSummary.independentSourceCount).toBe(2);
    // 主来源是那条官方一手
    expect(row?.evidenceSummary.primarySource?.slug).toBe(`publicread-it-official-${SUFFIX}`);
    // 官方来源的 PRIMARY_SOURCE → 有官方确认
    expect(row?.evidenceSummary.hasOfficialConfirmation).toBe(true);
  });

  it('没有事件、或事件没有证据时是**零值**（不是 null）', async () => {
    const contentId = await makeContent({
      label: 'ev-none',
      sourceId: rssSourceId,
      status: ContentPipelineStatus.APPROVED,
    });

    const row = await repository.findContent(contentId);
    expect(row?.evidenceSummary).toEqual({
      independentSourceCount: 0,
      primarySource: null,
      hasOfficialConfirmation: false,
    });
  });

  it('公开证据链**不含**内部字段（urlHash / confidence / contentId）', async () => {
    const event = await prisma.event.create({
      data: {
        canonicalTitle: `PublicRead IT Chain ${SUFFIX}`,
        status: 'ACTIVE',
        firstSeenAt: new Date('2026-09-29T00:00:00.000Z'),
        lastSeenAt: new Date('2026-09-29T00:00:00.000Z'),
      },
      select: { id: true },
    });
    const contentId = await makeContent({
      label: 'ev-chain',
      sourceId: rssSourceId,
      status: ContentPipelineStatus.APPROVED,
    });
    await prisma.content.update({ where: { id: contentId }, data: { eventId: event.id } });
    await prisma.eventEvidence.create({
      data: {
        eventId: event.id,
        sourceId: rssSourceId,
        evidenceType: EvidenceType.SUPPORTING_SOURCE,
        url: `https://example.com/chain-${SUFFIX}`,
        urlHash: `b${SUFFIX}`.padEnd(64, '0'),
        title: '一条证据',
      },
    });

    const evidence = await repository.findEventEvidence(event.id);
    expect(evidence).toHaveLength(1);
    const first = evidence?.[0] as unknown as Record<string, unknown>;

    for (const leaked of ['urlHash', 'confidence', 'contentId', 'eventId']) {
      expect(Object.hasOwn(first, leaked), `${leaked} 不该出现在公开证据链里`).toBe(false);
    }
    expect(evidence?.[0]?.url).toContain('example.com');
  });

  it('事件不存在 → `null`（与「事件存在但没有证据」的 `[]` 区分开）', async () => {
    expect(await repository.findEventEvidence(999_999_999n)).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* featured vs latest：排序口径必须不同（2026-10-01 修）                */
/* ------------------------------------------------------------------ */

/**
 * ⚠ 这个 `describe` 守的是一个**真实缺陷**：
 *
 * `listByWindow()` 此前把 `orderBy` 写死成 `[finalScore DESC, publishedAt DESC]`，
 * 而 `/today` 的 `featured` 与 `latest` **都走它** —— 于是「当日最新」实际是按
 * **分数**排的，与 `TodayView.latest` 自己的文档（「按发布时间倒序」）直接矛盾。
 *
 * 修法是把排序抽成**必填**参数 `sort: 'score' | 'latest'`（不设默认值 ——
 * 有默认值的话，调用方不写就会悄悄退回旧的错误语义）。
 *
 * **旧实现下 `latest` 那条必红**：它会拿到 95 分的旧文章而不是新的那条。
 */
describe('/today：featured 按分数、latest 按时间（口径必须不同）', () => {
  // ⚠ 用一个**固定的过去时间窗**，与文件里其它用例的 `publishedAt: new Date()`
  // 完全隔开 —— 否则那些内容会混进结果里，让断言依赖执行顺序。
  const START = new Date('2020-01-01T00:00:00.000Z');
  const END = new Date('2020-01-03T00:00:00.000Z');

  // 清单指定的构造：「旧文章 95 分，新文章 60 分」。
  let oldHighId: bigint;
  let newLowId: bigint;

  beforeAll(async () => {
    oldHighId = await makeContent({
      label: 'order-old-high',
      sourceId: rssSourceId,
      status: ContentPipelineStatus.APPROVED,
      publishedAt: new Date('2020-01-01T10:00:00.000Z'),
      finalScore: 95,
    });
    newLowId = await makeContent({
      label: 'order-new-low',
      sourceId: rssSourceId,
      status: ContentPipelineStatus.APPROVED,
      publishedAt: new Date('2020-01-02T10:00:00.000Z'),
      finalScore: 60,
    });
  });

  it('featured（sort=score）：旧的高分文章排在新的低分文章前面', async () => {
    const rows = await repository.listByWindow({
      startUtc: START,
      endUtc: END,
      limit: 10,
      sort: 'score',
    });
    expect(rows.map((row) => row.id)).toEqual([String(oldHighId), String(newLowId)]);
  });

  it('⚠ latest（sort=latest）：新的低分文章必须排前面（旧实现下这条必红）', async () => {
    const rows = await repository.listByWindow({
      startUtc: START,
      endUtc: END,
      limit: 10,
      sort: 'latest',
    });
    // 旧实现把 orderBy 写死成分数优先 —— 这里拿到的会是 95 分那条旧文章。
    expect(rows.map((row) => row.id)).toEqual([String(newLowId), String(oldHighId)]);
  });

  it('latest 的口径是「时间」而不是「分数」：把分数反过来也不改变顺序', async () => {
    // 把新的那条降成更低分、旧的那条升到更高分，顺序仍应只看时间。
    await prisma.content.update({ where: { id: newLowId }, data: { finalScore: 1 } });
    await prisma.content.update({ where: { id: oldHighId }, data: { finalScore: 99 } });

    const rows = await repository.listByWindow({
      startUtc: START,
      endUtc: END,
      limit: 10,
      sort: 'latest',
    });
    expect(rows.map((row) => row.id)).toEqual([String(newLowId), String(oldHighId)]);
  });

  it('latest 把「没有发布时间」的条目排在最后（MySQL DESC 下 NULL 本就在最后）', async () => {
    const noDateId = await makeContent({
      label: 'order-no-date',
      sourceId: rssSourceId,
      status: ContentPipelineStatus.APPROVED,
      publishedAt: undefined, // 见下：makeContent 会落成 `new Date()`
      finalScore: 100, // 分数最高，若排序看分数它就会跑到最前
    });
    // ⚠ `makeContent` 的 `publishedAt` 默认是 `new Date()`，所以上面那条其实**有时间**。
    // 这里显式改成 null，才是这条用例要验的形状。
    await prisma.content.update({ where: { id: noDateId }, data: { publishedAt: null } });

    const rows = await repository.listByWindow({
      startUtc: START,
      endUtc: END,
      limit: 10,
      sort: 'latest',
    });
    // 它是 `publishedAt: null` 且 `createdAt` 不在窗口内 —— 所以**根本不进结果**，
    // 而不是「排在最后」。这条断言把那个边界说清楚。
    expect(rows.map((row) => row.id)).not.toContain(String(noDateId));
  });
});

/* ------------------------------------------------------------------ */
/* Topic 计数：只算已公开（2026-10-01 修）                              */
/* ------------------------------------------------------------------ */

/**
 * ⚠ 这个 `describe` 守的是一个**信息泄露**，不只是显示 bug：
 *
 * `listTopics()` 与 `findTopicBySlug()` 的 `_count` 此前**不带任何状态过滤**，
 * 而同一文件里的 `listTopicContents()` 明确只取 `APPROVED`。于是：
 *
 * ```text
 *   主题列表说「有 N 篇」
 *   点进去只列出 M 篇（M < N）
 * ```
 *
 * 用户能从 N - M 反推出**还有多少内容在审核队列里 / 被驳回了多少** ——
 * `docs/12` 的 Public-only 要求前台只反映已发布的部分。
 */
describe('Topic 计数：只算 APPROVED（与 listTopicContents 同一口径）', () => {
  const TOPIC_SLUG = `topic-count-${SUFFIX}`;
  let topicId: bigint;
  let approvedA: bigint;
  let approvedB: bigint;

  beforeAll(async () => {
    const topic = await prisma.topic.create({
      data: { name: `TopicCount ${SUFFIX}`, slug: TOPIC_SLUG },
      select: { id: true },
    });
    topicId = topic.id;

    // 两条已公开 + 四种未公开状态各一条 —— 只应数到那两条。
    const statuses: [string, ContentPipelineStatus][] = [
      ['approved-a', ContentPipelineStatus.APPROVED],
      ['approved-b', ContentPipelineStatus.APPROVED],
      ['pending', ContentPipelineStatus.REVIEW_PENDING],
      ['rejected', ContentPipelineStatus.REJECTED],
      ['archived', ContentPipelineStatus.ARCHIVED],
      ['analyzing', ContentPipelineStatus.ANALYZING],
      ['ingested', ContentPipelineStatus.INGESTED],
    ];

    const ids: Record<string, bigint> = {};
    for (const [label, status] of statuses) {
      ids[label] = await makeContent({
        label: `topic-${label}`,
        sourceId: rssSourceId,
        status,
        finalScore: 80,
      });
    }
    approvedA = ids['approved-a'] ?? 0n;
    approvedB = ids['approved-b'] ?? 0n;

    await prisma.contentTopic.createMany({
      data: Object.values(ids).map((contentId) => ({ contentId, topicId, confidence: 1 })),
    });
  });

  afterAll(async () => {
    // `contentTopics` 随 content 级联删除（见 schema 的 onDelete: Cascade），
    // 但 topic 本身不在文件末尾那个 afterAll 的清理范围里，这里自己收。
    await prisma.topic.deleteMany({ where: { id: topicId } });
  });

  it('⚠ listTopics 的计数只算 APPROVED（旧实现下这条必红）', async () => {
    const topics = await repository.listTopics();
    const mine = topics.find((topic) => topic.slug === TOPIC_SLUG);
    expect(mine).toBeDefined();
    // 旧实现会数到 7（全部状态），泄露 5 条内部候选。
    expect(mine?.contentCount, '未公开的内容不该被计数').toBe(2);
  });

  it('⚠ findTopicBySlug 的计数与 listTopics 一致', async () => {
    const topic = await repository.findTopicBySlug(TOPIC_SLUG);
    expect(topic?.contentCount).toBe(2);
  });

  it('计数的口径与「详情实际列出的条数」一致', async () => {
    const topic = await repository.findTopicBySlug(TOPIC_SLUG);
    const contents = await repository.listTopicContents({ topicId, limit: 50 });

    expect(contents.map((row) => row.id).sort()).toEqual(
      [String(approvedA), String(approvedB)].sort(),
    );
    // 这条才是清单要的「两个口径一致」：计数 === 列出的条数。
    expect(topic?.contentCount).toBe(contents.length);
  });
});
