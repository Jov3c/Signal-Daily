/**
 * `PublicReadRepository` 的 Prisma 实现。
 *
 * ⚠ **本文件只读。** 它不写任何表 —— 公开读是纯投影层。
 *
 * 两条贯穿全文件的规矩：
 *
 * 1. **可见性过滤在 SQL 里**（`pipeline_status = APPROVED`），
 *    不是取回来再在 JS 里过滤 —— 后者只要有一个方法忘了就会泄漏
 *    （`docs/12`：不得返回 REJECTED / internal candidate）。
 * 2. **`evidenceSummary` 批量算**，不逐条查（`/today` 一页 20 条 =
 *    20 次事件查询 + 20 次证据查询）。Agent 07 的审核列表踩过同一个坑。
 */

import { Inject, Injectable } from '@nestjs/common';
import {
  ContentPipelineStatus,
  type ContentType,
  type SourceKind,
  type SourceTier,
  type SourceType,
} from '@signal/contracts';
import { PrismaService } from '../../common/prisma/prisma.service';
import type {
  EvidenceSummaryRow,
  PublicContentRow,
  PublicEvidenceRow,
  PublicPersonRow,
  PublicReadRepository,
  PublicSourceRow,
  PublicTopicRow,
} from './repository';

/** 内容的公共选择器（含来源、作者、主题）。 */
const CONTENT_SELECT = {
  id: true,
  type: true,
  title: true,
  summary: true,
  bodyOriginal: true,
  bodyTranslated: true,
  language: true,
  originalUrl: true,
  imageUrl: true,
  publishedAt: true,
  recommendationReason: true,
  eventId: true,
  source: {
    select: {
      id: true,
      name: true,
      slug: true,
      type: true,
      kind: true,
      tier: true,
      official: true,
    },
  },
  authorPerson: { select: { id: true, name: true, slug: true, xHandle: true, avatarUrl: true } },
  topics: { select: { topic: { select: { id: true, name: true, slug: true } } } },
} as const;

type ContentPrismaRow = {
  id: bigint;
  type: string;
  title: string;
  summary: string | null;
  bodyOriginal: string | null;
  bodyTranslated: string | null;
  language: string;
  originalUrl: string;
  imageUrl: string | null;
  publishedAt: Date | null;
  recommendationReason: string | null;
  eventId: bigint | null;
  source: {
    id: bigint;
    name: string;
    slug: string;
    type: string;
    kind: string;
    tier: string;
    official: boolean;
  };
  authorPerson: {
    id: bigint;
    name: string;
    slug: string;
    xHandle: string | null;
    avatarUrl: string | null;
  } | null;
  topics: { topic: { id: bigint; name: string; slug: string } }[];
};

const iso = (value: Date | null): string | null => (value === null ? null : value.toISOString());

function toSource(row: ContentPrismaRow['source']): PublicSourceRow {
  return {
    id: String(row.id),
    name: row.name,
    slug: row.slug,
    type: row.type as SourceType,
    kind: row.kind as SourceKind,
    tier: row.tier as SourceTier,
    official: row.official,
  };
}

@Injectable()
export class PrismaPublicReadRepository implements PublicReadRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /* ---------------------------------------------------------------- */
  /* 内容与证据口径                                                     */
  /* ---------------------------------------------------------------- */

  async findContent(contentId: bigint): Promise<PublicContentRow | null> {
    const row = await this.prisma.content.findFirst({
      where: { id: contentId, pipelineStatus: ContentPipelineStatus.APPROVED },
      select: CONTENT_SELECT,
    });
    if (row === null) return null;

    // ⚠ 单条时也算一次摘要（而不是返回空壳）——
    // 内容页必须显示「3 个独立来源 · 已有官方确认」（`docs/22`）。
    const summaries = await this.evidenceSummariesFor([row as ContentPrismaRow]);
    return this.toContent(row as ContentPrismaRow, summaries);
  }

  async findContentsByIds(ids: readonly bigint[]): Promise<PublicContentRow[]> {
    if (ids.length === 0) return [];
    const rows = await this.prisma.content.findMany({
      where: { id: { in: [...ids] }, pipelineStatus: ContentPipelineStatus.APPROVED },
      select: CONTENT_SELECT,
    });
    const summaries = await this.evidenceSummariesFor(rows as ContentPrismaRow[]);
    return rows.map((row) => this.toContent(row as ContentPrismaRow, summaries));
  }

  async listByWindow(input: {
    startUtc: Date;
    endUtc: Date;
    limit: number;
    sort: 'score' | 'latest';
    minScore?: number;
  }): Promise<PublicContentRow[]> {
    /**
     * ⚠ **排序按 `sort` 分岔 —— 2026-10-01 修。**
     *
     * 此前只有一条写死的 `[finalScore DESC, publishedAt DESC]`，`/today` 的
     * `latest` 也走它 —— 于是「当日最新」其实是**按分数**排的，与
     * `TodayView.latest` 自己的文档（「按发布时间倒序」）矛盾。
     *
     * ⚠ `publishedAt` 可空（部分来源不给）。**MySQL 在 `DESC` 下把 NULL 排在最后**
     *（它把 NULL 当作最小值），这正好是我们要的 —— 「没有发布时间的条目」不该
     * 占据「最新」的第一屏。这里仍显式写出 `nulls: 'last'`：默认行为会随数据库
     * 而变（Postgres 在 DESC 下恰好相反），写出来才不会被一次迁移静默改掉。
     *
     * ⚠ 两种排序都补了 `id DESC` 兜底：`finalScore` / `publishedAt` 都可能并列，
     * 没有唯一列参与排序时翻页会**漏条或重复**（Agent 12 的 admin 列表里
     * 记过同一个坑）。
     */
    const orderBy =
      input.sort === 'latest'
        ? [
            { publishedAt: { sort: 'desc' as const, nulls: 'last' as const } },
            { createdAt: 'desc' as const },
            { id: 'desc' as const },
          ]
        : [
            { finalScore: 'desc' as const },
            { publishedAt: { sort: 'desc' as const, nulls: 'last' as const } },
            { id: 'desc' as const },
          ];

    const rows = await this.prisma.content.findMany({
      where: {
        pipelineStatus: ContentPipelineStatus.APPROVED,
        // `publishedAt` 可空（部分来源不给）—— 用 `createdAt` 兜底，
        // 否则这些内容**永远进不了前台**（与 Agent 08 的候选窗口同一处理）。
        OR: [
          { publishedAt: { gte: input.startUtc, lt: input.endUtc } },
          { publishedAt: null, createdAt: { gte: input.startUtc, lt: input.endUtc } },
        ],
        ...(input.minScore === undefined ? {} : { finalScore: { gte: input.minScore } }),
      },
      select: CONTENT_SELECT,
      orderBy,
      take: input.limit,
    });
    const summaries = await this.evidenceSummariesFor(rows as ContentPrismaRow[]);
    return rows.map((row) => this.toContent(row as ContentPrismaRow, summaries));
  }

  /**
   * 批量算证据口径。
   *
   * ⚠ 口径与 Agent 06 / 07 **必须一致**，否则同一篇内容在审核页与前台
   * 会显示不同的独立来源数：
   *
   * - `independentSourceCount` = `distinct source_id`（`docs/06`：同源多条算 1，
   *   转载不算独立来源）；
   * - `hasOfficialConfirmation` 看的是**证据那条来源**的 `official`
   *   （Agent 06 的 P2 修复：判内容自己的来源会产生假阳性/假阴性）；
   * - `primarySource` 取 `isPrimary` 的那条证据的来源。
   */
  private async evidenceSummariesFor(
    rows: readonly ContentPrismaRow[],
  ): Promise<Map<string, EvidenceSummaryRow>> {
    const result = new Map<string, EvidenceSummaryRow>();
    const eventIds = [
      ...new Set(rows.map((row) => row.eventId).filter((id): id is bigint => id !== null)),
    ];

    if (eventIds.length === 0) {
      for (const row of rows) result.set(String(row.id), emptySummary());
      return result;
    }

    const evidences = await this.prisma.eventEvidence.findMany({
      where: { eventId: { in: eventIds } },
      select: {
        eventId: true,
        evidenceType: true,
        isPrimary: true,
        source: {
          select: {
            id: true,
            name: true,
            slug: true,
            type: true,
            kind: true,
            tier: true,
            official: true,
          },
        },
      },
    });

    const byEvent = new Map<string, typeof evidences>();
    for (const evidence of evidences) {
      const key = String(evidence.eventId);
      const list = byEvent.get(key);
      if (list === undefined) byEvent.set(key, [evidence]);
      else list.push(evidence);
    }

    for (const row of rows) {
      if (row.eventId === null) {
        result.set(String(row.id), emptySummary());
        continue;
      }
      const list = byEvent.get(String(row.eventId)) ?? [];

      const distinctSources = new Set<string>();
      let primarySource: PublicSourceRow | null = null;
      let official = false;

      for (const evidence of list) {
        if (evidence.source !== null) distinctSources.add(String(evidence.source.id));

        if (
          evidence.evidenceType === 'OFFICIAL_CONFIRMATION' ||
          (evidence.isPrimary && evidence.source?.official === true)
        ) {
          official = true;
        }

        // `isPrimary` 优先；没有显式 primary 时退回 `PRIMARY_SOURCE` 类型。
        if (evidence.isPrimary || evidence.evidenceType === 'PRIMARY_SOURCE') {
          if (primarySource === null && evidence.source !== null) {
            primarySource = toSource(evidence.source);
          }
        }
      }

      result.set(String(row.id), {
        independentSourceCount: distinctSources.size,
        primarySource,
        hasOfficialConfirmation: official,
      });
    }

    return result;
  }

  private toContent(
    row: ContentPrismaRow,
    summaries: Map<string, EvidenceSummaryRow>,
  ): PublicContentRow {
    return {
      id: String(row.id),
      type: row.type as ContentType,
      title: row.title,
      summary: row.summary,
      // ⚠ `bodyOriginal` 存的是**已清洗的 HTML**（Agent 05 的 `docs/14` 清洗点）。
      // 前台**不要再清洗一遍**，但也不要当作纯文本。
      bodyOriginal: row.bodyOriginal,
      bodyTranslated: row.bodyTranslated,
      language: row.language,
      originalUrl: row.originalUrl,
      imageUrl: row.imageUrl,
      publishedAt: iso(row.publishedAt),
      source: toSource(row.source),
      author:
        row.authorPerson === null
          ? null
          : {
              id: String(row.authorPerson.id),
              name: row.authorPerson.name,
              slug: row.authorPerson.slug,
              xHandle: row.authorPerson.xHandle,
              avatarUrl: row.authorPerson.avatarUrl,
            },
      topics: row.topics.map((entry) => ({
        id: String(entry.topic.id),
        name: entry.topic.name,
        slug: entry.topic.slug,
      })),
      recommendationReason: row.recommendationReason,
      // ⚠ 找不到摘要时给**零值而不是 null**：`docs/04` 说
      // `GET /contents/:id` **必须**返回 `evidenceSummary`，
      // 而「这个事件没有证据」的正确答案是 0 个独立来源 + 无官方确认。
      evidenceSummary: summaries.get(String(row.id)) ?? emptySummary(),
    };
  }

  /* ---------------------------------------------------------------- */
  /* X Feed                                                            */
  /* ---------------------------------------------------------------- */

  async listX(input: {
    limit: number;
    cursor?: string;
    personId?: bigint;
    category?: string;
  }): Promise<{ rows: PublicContentRow[]; nextCursor: string | null }> {
    const rows = await this.prisma.content.findMany({
      where: {
        pipelineStatus: ContentPipelineStatus.APPROVED,
        // ⚠ 来源集合**完全**由后台白名单决定（`docs/04`）：
        // `type = X_USER` + `enabled = true`。这里**没有**任何用户维度入参。
        source: { type: 'X_USER', enabled: true },
        ...(input.personId === undefined ? {} : { authorPersonId: input.personId }),
        ...(input.category === undefined
          ? {}
          : { authorPerson: { is: { category: input.category } } }),
      },
      select: CONTENT_SELECT,
      orderBy: [{ publishedAt: 'desc' }, { id: 'desc' }],
      take: input.limit + 1,
      ...(input.cursor === undefined ? {} : { cursor: { id: BigInt(input.cursor) }, skip: 1 }),
    });

    const hasMore = rows.length > input.limit;
    const page = hasMore ? rows.slice(0, input.limit) : rows;
    const summaries = await this.evidenceSummariesFor(page as ContentPrismaRow[]);
    const last = page.at(-1);

    return {
      rows: page.map((row) => this.toContent(row as ContentPrismaRow, summaries)),
      nextCursor: hasMore && last !== undefined ? String((last as ContentPrismaRow).id) : null,
    };
  }

  /* ---------------------------------------------------------------- */
  /* 人物 / 主题 / 来源                                                 */
  /* ---------------------------------------------------------------- */

  async listPeople(): Promise<(PublicPersonRow & { contentCount: number })[]> {
    const rows = await this.prisma.person.findMany({
      select: {
        id: true,
        name: true,
        slug: true,
        xHandle: true,
        avatarUrl: true,
        _count: {
          select: {
            contents: { where: { pipelineStatus: ContentPipelineStatus.APPROVED } },
          },
        },
      },
      orderBy: { name: 'asc' },
    });
    return rows.map((row) => ({
      id: String(row.id),
      name: row.name,
      slug: row.slug,
      xHandle: row.xHandle,
      avatarUrl: row.avatarUrl,
      contentCount: row._count.contents,
    }));
  }

  async findPersonBySlug(
    slug: string,
  ): Promise<(PublicPersonRow & { contentCount: number }) | null> {
    const row = await this.prisma.person.findUnique({
      where: { slug },
      select: {
        id: true,
        name: true,
        slug: true,
        xHandle: true,
        avatarUrl: true,
        _count: {
          select: {
            contents: { where: { pipelineStatus: ContentPipelineStatus.APPROVED } },
          },
        },
      },
    });
    if (row === null) return null;
    return {
      id: String(row.id),
      name: row.name,
      slug: row.slug,
      xHandle: row.xHandle,
      avatarUrl: row.avatarUrl,
      contentCount: row._count.contents,
    };
  }

  async listPersonContents(input: {
    personId: bigint;
    limit: number;
  }): Promise<PublicContentRow[]> {
    const rows = await this.prisma.content.findMany({
      where: {
        authorPersonId: input.personId,
        pipelineStatus: ContentPipelineStatus.APPROVED,
      },
      select: CONTENT_SELECT,
      orderBy: [{ publishedAt: 'desc' }, { id: 'desc' }],
      take: input.limit,
    });
    const summaries = await this.evidenceSummariesFor(rows as ContentPrismaRow[]);
    return rows.map((row) => this.toContent(row as ContentPrismaRow, summaries));
  }

  async listTopics(): Promise<(PublicTopicRow & { contentCount: number })[]> {
    const rows = await this.prisma.topic.findMany({
      select: { id: true, name: true, slug: true, _count: { select: { contentTopics: true } } },
      orderBy: { name: 'asc' },
    });
    return rows.map((row) => ({
      id: String(row.id),
      name: row.name,
      slug: row.slug,
      contentCount: row._count.contentTopics,
    }));
  }

  async findTopicBySlug(slug: string): Promise<(PublicTopicRow & { contentCount: number }) | null> {
    const row = await this.prisma.topic.findUnique({
      where: { slug },
      select: { id: true, name: true, slug: true, _count: { select: { contentTopics: true } } },
    });
    if (row === null) return null;
    return {
      id: String(row.id),
      name: row.name,
      slug: row.slug,
      contentCount: row._count.contentTopics,
    };
  }

  async listTopicContents(input: { topicId: bigint; limit: number }): Promise<PublicContentRow[]> {
    const rows = await this.prisma.content.findMany({
      where: {
        pipelineStatus: ContentPipelineStatus.APPROVED,
        topics: { some: { topicId: input.topicId } },
      },
      select: CONTENT_SELECT,
      orderBy: [{ finalScore: 'desc' }, { publishedAt: 'desc' }],
      take: input.limit,
    });
    const summaries = await this.evidenceSummariesFor(rows as ContentPrismaRow[]);
    return rows.map((row) => this.toContent(row as ContentPrismaRow, summaries));
  }

  async findSourceBySlug(slug: string) {
    const row = await this.prisma.source.findUnique({
      where: { slug },
      select: {
        id: true,
        name: true,
        slug: true,
        type: true,
        kind: true,
        tier: true,
        official: true,
        baseUrl: true,
        _count: {
          select: {
            contents: { where: { pipelineStatus: ContentPipelineStatus.APPROVED } },
          },
        },
      },
    });
    if (row === null) return null;
    return {
      id: String(row.id),
      name: row.name,
      slug: row.slug,
      type: row.type as SourceType,
      kind: row.kind as SourceKind,
      tier: row.tier as SourceTier,
      official: row.official,
      description: null,
      baseUrl: row.baseUrl,
      contentCount: row._count.contents,
    };
  }

  async listSourceContents(input: {
    sourceId: bigint;
    limit: number;
  }): Promise<PublicContentRow[]> {
    const rows = await this.prisma.content.findMany({
      where: {
        sourceId: input.sourceId,
        pipelineStatus: ContentPipelineStatus.APPROVED,
      },
      select: CONTENT_SELECT,
      orderBy: [{ publishedAt: 'desc' }, { id: 'desc' }],
      take: input.limit,
    });
    const summaries = await this.evidenceSummariesFor(rows as ContentPrismaRow[]);
    return rows.map((row) => this.toContent(row as ContentPrismaRow, summaries));
  }

  /* ---------------------------------------------------------------- */
  /* 证据链                                                            */
  /* ---------------------------------------------------------------- */

  async findEventEvidence(eventId: bigint): Promise<PublicEvidenceRow[] | null> {
    const event = await this.prisma.event.findUnique({
      where: { id: eventId },
      select: { id: true },
    });
    // 事件不存在 → `null`（与「事件存在但没有证据」的 `[]` 区分开）
    if (event === null) return null;

    const rows = await this.prisma.eventEvidence.findMany({
      where: { eventId },
      select: {
        id: true,
        evidenceType: true,
        title: true,
        url: true,
        publishedAt: true,
        isPrimary: true,
        source: {
          select: {
            id: true,
            name: true,
            slug: true,
            type: true,
            kind: true,
            tier: true,
            official: true,
          },
        },
      },
      // Primary 在最前，其余按时间倒序
      orderBy: [{ isPrimary: 'desc' }, { publishedAt: 'desc' }],
    });

    // ⚠ 公开版本**只**返回下面这些字段：
    //   id / evidenceType / title / url / publishedAt / isPrimary / source
    // 刻意**不返回** `urlHash`（内部去重键）、`confidence`（AI 置信度，
    // 内部指标）、`contentId`（内部主键关联）——
    // `docs/04`：「公开版本只返回允许公开的 Evidence 字段，
    // 不暴露内部 debug metadata」。
    return rows.map((row) => ({
      id: String(row.id),
      evidenceType: String(row.evidenceType),
      title: row.title,
      url: row.url,
      publishedAt: iso(row.publishedAt),
      isPrimary: row.isPrimary,
      source: row.source === null ? null : toSource(row.source),
    }));
  }

  async findContentEventId(contentId: bigint): Promise<bigint | null> {
    const row = await this.prisma.content.findFirst({
      where: { id: contentId, pipelineStatus: ContentPipelineStatus.APPROVED },
      select: { eventId: true },
    });
    return row?.eventId ?? null;
  }

  /* ---------------------------------------------------------------- */
  /* 搜索                                                              */
  /* ---------------------------------------------------------------- */

  async search(input: { query: string; limit: number; offset: number }) {
    // ⚠ 用 `$queryRaw` 而不是 Prisma 的查询构造器：`MATCH ... AGAINST` 是
    // MySQL 专有语法，而本仓库**必须**用 `WITH PARSER ngram` 的那个索引
    //（Agent 01 的第二个迁移 —— 默认 parser 对中文恒返回 0 条）。
    //
    // ⚠ 参数用 `Prisma.sql` 的占位符（`${}`）而不是字符串拼接 ——
    // 搜索词是**用户输入**，拼接就是 SQL 注入。
    const { Prisma } = await import('@prisma/client');

    const matched = await this.prisma.$queryRaw<{ id: bigint }[]>(Prisma.sql`
      SELECT id FROM contents
      WHERE pipeline_status = ${ContentPipelineStatus.APPROVED}
        AND MATCH(title, summary, body_translated) AGAINST (${input.query} IN NATURAL LANGUAGE MODE)
      ORDER BY MATCH(title, summary, body_translated) AGAINST (${input.query} IN NATURAL LANGUAGE MODE) DESC
      LIMIT ${input.limit} OFFSET ${input.offset}
    `);

    const totalRows = await this.prisma.$queryRaw<{ total: bigint }[]>(Prisma.sql`
      SELECT COUNT(*) AS total FROM contents
      WHERE pipeline_status = ${ContentPipelineStatus.APPROVED}
        AND MATCH(title, summary, body_translated) AGAINST (${input.query} IN NATURAL LANGUAGE MODE)
    `);

    const ids = matched.map((row) => row.id);
    // 用 `findContentsByIds` 回表取完整形状 —— 它**也会重新过滤可见性**，
    // 所以即使 FULLTEXT 命中了一条刚被撤下的内容，也不会出现在结果里。
    const rows = await this.findContentsByIds(ids);
    // 保持 FULLTEXT 的相关度顺序（`findContentsByIds` 不保证顺序）
    const byId = new Map(rows.map((row) => [row.id, row]));
    const ordered = ids
      .map((id) => byId.get(String(id)))
      .filter((row): row is PublicContentRow => row !== undefined);

    return { rows: ordered, total: Number(totalRows[0]?.total ?? 0) };
  }
}

/** 零值摘要（没有事件、或事件没有证据）。 */
function emptySummary(): EvidenceSummaryRow {
  return { independentSourceCount: 0, primarySource: null, hasOfficialConfirmation: false };
}
