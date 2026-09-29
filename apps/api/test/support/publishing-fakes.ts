/**
 * 精选 / 日报的内存替身（单元测试用，不需要 MySQL）。
 *
 * ⚠ 这些替身**必须与真实仓储同语义**，否则「测试全绿」只是一种自证。
 * 每条与真实实现有关键差异的地方都在下面显式标注 —— Agent 05 的自查记录里
 * 有两条假绿正是替身与真实实现不一致造成的
 *（`??` 吃掉显式 `null`、计数器当 `createdAt`）。
 */

import {
  ContentPipelineStatus,
  DailyEditionStatus,
  type ContentType,
  type SourceKind,
  type SourceTier,
} from '@signal/contracts';
import type {
  DailyItemContent,
  DailyRepository,
  DailySectionRow,
  EditionDetail,
  EditionRow,
  SectionInput,
} from '../../src/modules/daily/repository';
import type { EditionSnapshot } from '../../src/modules/daily/preflight';
import type {
  CreateFeaturedInput,
  FeaturedRepository,
  FeaturedRow,
  UpdateFeaturedInput,
} from '../../src/modules/featured/repository';

const iso = (value: Date | null): string | null => (value === null ? null : value.toISOString());
const toBusinessDate = (value: Date): string => value.toISOString().slice(0, 10);
const fromBusinessDate = (value: string): Date => new Date(`${value}T00:00:00.000Z`);

/* ------------------------------------------------------------------ */
/* 日报                                                                */
/* ------------------------------------------------------------------ */

type FakeEdition = EditionRow & { sections: SectionInput[] };

export class InMemoryDailyRepository implements DailyRepository {
  readonly editions = new Map<string, FakeEdition>();

  private nextEditionId = 1;

  /** 内容状态表（`findContentStatuses` 用）。不在表里 = 不存在。 */
  readonly contentStatuses = new Map<string, ContentPipelineStatus>();

  /** 每次 `markPublished` 被调用时递增，供「并发发布」用例断言调用次数。 */
  markPublishedCalls = 0;

  /**
   * 强制 `markPublished` 返回 `null`（模拟「别人抢先发布了」）。
   *
   * 真实实现里那是条件更新 `count = 0` 的结果。替身直接翻一个开关 ——
   * 它测的是**服务层对 `null` 的反应**，不是 SQL 的原子性
   *（后者由 `daily-db.integration.spec.ts` 在真库上验）。
   */
  simulateConcurrentPublish = false;

  seedEdition(input: {
    businessDate: string;
    status?: DailyEditionStatus;
    editionNo?: number | null;
    headline?: string | null;
    scheduledAt?: Date | null;
    publishedAt?: Date | null;
    sections?: SectionInput[];
  }): EditionRow {
    const edition: FakeEdition = {
      editionId: String(this.nextEditionId++),
      businessDate: input.businessDate,
      editionNo: input.editionNo ?? null,
      status: input.status ?? DailyEditionStatus.DRAFT,
      headline: input.headline ?? null,
      scheduledAt: iso(input.scheduledAt ?? null),
      publishedAt: iso(input.publishedAt ?? null),
      sections: input.sections ?? [],
    };
    this.editions.set(input.businessDate, edition);
    return edition;
  }

  seedContent(contentId: string, status: ContentPipelineStatus): void {
    this.contentStatuses.set(contentId, status);
  }

  private toRow(edition: FakeEdition): EditionRow {
    const { sections: _sections, ...row } = edition;
    return { ...row };
  }

  async findByBusinessDate(businessDate: string): Promise<EditionRow | null> {
    const edition = this.editions.get(businessDate);
    return edition === undefined ? null : this.toRow(edition);
  }

  async ensureDraft(businessDate: string): Promise<EditionRow> {
    const existing = this.editions.get(businessDate);
    if (existing !== undefined) return this.toRow(existing);
    return this.seedEdition({ businessDate });
  }

  async detail(editionId: string): Promise<EditionDetail | null> {
    const edition = [...this.editions.values()].find((e) => e.editionId === editionId);
    if (edition === undefined) return null;

    return {
      edition: this.toRow(edition),
      sections: edition.sections.map((section, sectionIndex): DailySectionRow => ({
        sectionId: `${editionId}-s${String(sectionIndex)}`,
        type: section.type,
        title: section.title,
        sortOrder: section.sortOrder,
        items: section.items.map((item) => ({
          contentId: item.contentId,
          displayStyle: item.displayStyle,
          sortOrder: item.sortOrder,
          customHeadline: item.customHeadline,
          customExcerpt: item.customExcerpt,
          content: this.contentOf(item.contentId),
        })),
      })),
    };
  }

  /** 条目预览的内容 —— 用一个固定形状，字段值与真实来源无关。 */
  private contentOf(contentId: string): DailyItemContent | null {
    if (!this.contentStatuses.has(contentId)) return null;
    return {
      title: `内容 ${contentId}`,
      summary: `摘要 ${contentId}`,
      originalUrl: `https://example.com/${contentId}`,
      imageUrl: null,
      publishedAt: '2026-09-29T01:00:00.000Z',
      type: 'ARTICLE' as ContentType,
      pipelineStatus: this.contentStatuses.get(contentId) as ContentPipelineStatus,
      source: {
        name: '某来源',
        slug: 'some-source',
        kind: 'MEDIA' as SourceKind,
        tier: 'B' as SourceTier,
        official: false,
      },
    };
  }

  async replaceSections(editionId: string, sections: readonly SectionInput[]): Promise<void> {
    const edition = [...this.editions.values()].find((e) => e.editionId === editionId);
    if (edition === undefined) throw new Error(`Unknown editionId: ${editionId}`);
    edition.sections = sections.map((section) => ({
      ...section,
      items: section.items.map((item) => ({ ...item })),
    }));
  }

  async updateEdition(
    editionId: string,
    patch: {
      headline?: string | null;
      status?: DailyEditionStatus;
      scheduledAt?: Date | null;
      publishedAt?: Date | null;
    },
  ): Promise<EditionRow | null> {
    const edition = [...this.editions.values()].find((e) => e.editionId === editionId);
    if (edition === undefined) return null;

    // ⚠ 用 `Object.hasOwn` 而不是 `!== undefined` 判断「这个键给了没有」：
    // 两者对本模块**语义不同** —— `headline: null` 是「清空标题」，
    // 必须被写入。Agent 05 的替身正是在这里用 `??` 吃掉了显式 `null`。
    if (Object.hasOwn(patch, 'headline')) edition.headline = patch.headline ?? null;
    if (Object.hasOwn(patch, 'status')) edition.status = patch.status as DailyEditionStatus;
    if (Object.hasOwn(patch, 'scheduledAt')) edition.scheduledAt = iso(patch.scheduledAt ?? null);
    if (Object.hasOwn(patch, 'publishedAt')) edition.publishedAt = iso(patch.publishedAt ?? null);

    return this.toRow(edition);
  }

  async countPublished(): Promise<number> {
    return [...this.editions.values()].filter((e) => e.status === DailyEditionStatus.PUBLISHED)
      .length;
  }

  async markPublished(
    editionId: string,
    input: { editionNo: number; publishedAt: Date },
  ): Promise<EditionRow | null> {
    this.markPublishedCalls += 1;
    if (this.simulateConcurrentPublish) return null;

    const edition = [...this.editions.values()].find((e) => e.editionId === editionId);
    if (edition === undefined) return null;
    // 与真实实现一致：**已经发布过的不会被再占一次**。
    if (edition.status === DailyEditionStatus.PUBLISHED) return null;

    edition.status = DailyEditionStatus.PUBLISHED;
    edition.editionNo = input.editionNo;
    edition.publishedAt = input.publishedAt.toISOString();
    return this.toRow(edition);
  }

  async snapshot(editionId: string): Promise<EditionSnapshot | null> {
    const edition = [...this.editions.values()].find((e) => e.editionId === editionId);
    if (edition === undefined) return null;

    return {
      businessDate: edition.businessDate,
      status: edition.status,
      sections: edition.sections.map((section, sectionIndex) => ({
        sectionId: `${editionId}-s${String(sectionIndex)}`,
        type: section.type,
        title: section.title,
        sortOrder: section.sortOrder,
        items: section.items.map((item, itemIndex) => {
          const content = this.contentOf(item.contentId);
          return {
            itemId: `${editionId}-i${String(itemIndex)}`,
            contentId: item.contentId,
            displayStyle: item.displayStyle,
            sortOrder: item.sortOrder,
            contentExists: content !== null,
            contentStatus: content === null ? null : content.pipelineStatus,
            sourceName: content === null ? null : content.source.name,
            originalUrl: content === null ? null : content.originalUrl,
          };
        }),
      })),
    };
  }

  async listByDateRange(input: {
    from: string;
    to: string;
    status?: DailyEditionStatus;
  }): Promise<EditionRow[]> {
    return [...this.editions.values()]
      .filter((e) => e.businessDate >= input.from && e.businessDate < input.to)
      .filter((e) => input.status === undefined || e.status === input.status)
      .sort((a, b) => (a.businessDate < b.businessDate ? 1 : -1))
      .map((e) => this.toRow(e));
  }

  async listArchive(input: { from: string; to: string }): Promise<EditionRow[]> {
    return this.listByDateRange({
      from: input.from,
      to: input.to,
      status: DailyEditionStatus.PUBLISHED,
    });
  }

  async findPublishedDetail(businessDate: string): Promise<EditionDetail | null> {
    const edition = this.editions.get(businessDate);
    // ⚠ 与真实实现一致：**未发布对外不存在**（`docs/10`）。
    if (edition === undefined || edition.status !== DailyEditionStatus.PUBLISHED) return null;
    return this.detail(edition.editionId);
  }

  async findContentStatuses(
    contentIds: readonly string[],
  ): Promise<Map<string, ContentPipelineStatus>> {
    const result = new Map<string, ContentPipelineStatus>();
    for (const contentId of contentIds) {
      const status = this.contentStatuses.get(contentId);
      if (status !== undefined) result.set(contentId, status);
    }
    return result;
  }
}

/* ------------------------------------------------------------------ */
/* 精选                                                                */
/* ------------------------------------------------------------------ */

type FakeGate = {
  contentId: string;
  pipelineStatus: ContentPipelineStatus;
  reviewStatus: string | null;
  publishFeatured: boolean;
};

/**
 * 精选项本体（**不含** `content` 预览）。
 *
 * ⚠ 为什么把 `content` 拆出去、每次读的时候现拼：
 * 真实仓储的 `content` 是**join 出来的当前值**，不是创建时的快照。
 * 第一版替身把 gate 快照进了行里，于是「内容在加入精选之后被撤下」
 * 这条路径永远走不到 —— 那正是**公开面必须过滤掉 REJECTED 内容**的场景
 *（`docs/10` 的实现注释里专门写了这一点）。
 * 这个 bug 是被 `公开面过滤掉下架的、以及内容已被撤下的` 用例抓出来的：
 * 它报了假红，但如果方向反过来就会是假绿。
 * Agent 05 的自查记录里有两条假绿同源（替身与真实实现语义不一致）。
 */
type FakeFeaturedItem = {
  contentId: string;
  customTitle: string | null;
  customSummary: string | null;
  sortWeight: number;
  publishedAt: string;
  active: boolean;
};

export class InMemoryFeaturedRepository implements FeaturedRepository {
  /** 精选项（内部形状）。 */
  private readonly items = new Map<string, FakeFeaturedItem>();

  readonly gates = new Map<string, FakeGate>();

  seedGate(input: {
    contentId: string;
    pipelineStatus?: ContentPipelineStatus;
    reviewStatus?: string | null;
    publishFeatured?: boolean;
  }): void {
    this.gates.set(input.contentId, {
      contentId: input.contentId,
      pipelineStatus: input.pipelineStatus ?? ContentPipelineStatus.APPROVED,
      reviewStatus: input.reviewStatus ?? 'APPROVED',
      publishFeatured: input.publishFeatured ?? true,
    });
  }

  /** 内部项 + **当前**的内容 gate → 端口形状（模拟 join）。 */
  private toRow(item: FakeFeaturedItem): FeaturedRow {
    const gate = this.gates.get(item.contentId);
    return {
      contentId: item.contentId,
      customTitle: item.customTitle,
      customSummary: item.customSummary,
      sortWeight: item.sortWeight,
      publishedAt: item.publishedAt,
      active: item.active,
      content: {
        title: `内容 ${item.contentId}`,
        summary: null,
        originalUrl: `https://example.com/${item.contentId}`,
        imageUrl: null,
        publishedAt: '2026-09-29T01:00:00.000Z',
        // ⚠ 这里读的是**当前**状态，不是创建时的快照。
        pipelineStatus: gate?.pipelineStatus ?? ContentPipelineStatus.APPROVED,
        reviewStatus: gate?.reviewStatus ?? null,
        publishFeatured: gate?.publishFeatured ?? false,
        sourceName: '某来源',
      },
    };
  }

  /** 便于测试直接断言「库里有没有这一行」。 */
  has(contentId: string): boolean {
    return this.items.has(contentId);
  }

  async findContentGate(contentId: string) {
    const gate = this.gates.get(contentId);
    return gate === undefined ? null : { ...gate };
  }

  async findFeatured(contentId: string): Promise<FeaturedRow | null> {
    const item = this.items.get(contentId);
    return item === undefined ? null : this.toRow(item);
  }

  async create(input: CreateFeaturedInput): Promise<FeaturedRow | null> {
    // 与真实实现一致：**唯一约束撞车返回 `null`**（不是先查后写）。
    if (this.items.has(input.contentId)) return null;

    const item: FakeFeaturedItem = {
      contentId: input.contentId,
      customTitle: input.customTitle,
      customSummary: input.customSummary,
      sortWeight: input.sortWeight,
      publishedAt: input.publishedAt.toISOString(),
      active: true,
    };
    this.items.set(input.contentId, item);
    return this.toRow(item);
  }

  async update(input: UpdateFeaturedInput): Promise<FeaturedRow | null> {
    const item = this.items.get(input.contentId);
    if (item === undefined) return null;

    // ⚠ `Object.hasOwn` 而不是 `!== undefined`：`customTitle: null` 是
    // 「清空标题」，必须写进去（Agent 05 的替身在这里被 `??` 吃过一次）。
    if (Object.hasOwn(input, 'customTitle')) item.customTitle = input.customTitle ?? null;
    if (Object.hasOwn(input, 'customSummary')) item.customSummary = input.customSummary ?? null;
    if (Object.hasOwn(input, 'sortWeight')) item.sortWeight = input.sortWeight as number;
    if (Object.hasOwn(input, 'active')) item.active = input.active as boolean;

    return this.toRow(item);
  }

  async list(input: {
    publicOnly: boolean;
    topicSlug?: string;
    contentType?: string;
    limit: number;
    cursor?: string;
  }): Promise<{ rows: FeaturedRow[]; nextCursor: string | null }> {
    const all = [...this.items.values()]
      .map((item) => this.toRow(item))
      // 公开面：上架的 **且内容当前仍是 APPROVED 的**。
      .filter(
        (row) =>
          !input.publicOnly ||
          (row.active && row.content.pipelineStatus === ContentPipelineStatus.APPROVED),
      )
      .sort((a, b) => {
        if (a.sortWeight !== b.sortWeight) return b.sortWeight - a.sortWeight;
        if (a.publishedAt !== b.publishedAt) return a.publishedAt < b.publishedAt ? 1 : -1;
        return Number(b.contentId) - Number(a.contentId);
      });

    const start =
      input.cursor === undefined ? 0 : all.findIndex((r) => r.contentId === input.cursor) + 1;
    const page = all.slice(start, start + input.limit);
    const hasMore = start + input.limit < all.length;
    return {
      rows: page,
      nextCursor: hasMore ? (page.at(-1)?.contentId ?? null) : null,
    };
  }
}

/** 一个可控时钟。 */
export function fixedClock(instant: Date): { now(): Date } {
  return { now: () => instant };
}

export { fromBusinessDate, toBusinessDate };
