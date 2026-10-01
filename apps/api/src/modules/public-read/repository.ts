/**
 * `PublicReadRepository` 端口 —— 公开读的持久化契约。
 *
 * ⚠ **本端口只返回「对外可见」的东西**（`docs/12`：
 * Public API 不得返回 REJECTED / internal candidate）。
 * 过滤发生在**这一层**，而不是在服务层 —— 那样任何一个忘记过滤的
 * 新方法都会静默泄漏，而这里的方法是「要么已经过滤、要么不存在」。
 *
 * 可见性口径（全模块统一，一处定义）：
 *
 * ```text
 * contents.pipeline_status = APPROVED
 * ```
 *
 * ⚠ 与 Agent 08 的 `FeaturedItem` 公开面、Agent 09 的收藏列表**同一口径**。
 * 三处口径不一致会让同一篇内容在「精选」里出现、在「收藏」里消失。
 */

import type { ContentType, SourceKind, SourceTier, SourceType } from '@signal/contracts';

/** 注入 token。 */
export const PUBLIC_READ_REPOSITORY = 'PUBLIC_READ_REPOSITORY';

/* ------------------------------------------------------------------ */
/* 形状                                                                */
/* ------------------------------------------------------------------ */

export type PublicSourceRow = {
  id: string;
  name: string;
  slug: string;
  type: SourceType;
  kind: SourceKind;
  tier: SourceTier;
  official: boolean;
};

export type PublicPersonRow = {
  id: string;
  name: string;
  slug: string;
  xHandle: string | null;
  avatarUrl: string | null;
};

export type PublicTopicRow = {
  id: string;
  name: string;
  slug: string;
};

/** 一条内容 + 它所属事件的证据口径（`docs/04` 的 `evidenceSummary`）。 */
export type EvidenceSummaryRow = {
  /** `distinct source_id`（`docs/06`：同源多条只算 1）。 */
  independentSourceCount: number;
  primarySource: PublicSourceRow | null;
  hasOfficialConfirmation: boolean;
};

/** 对外的一条内容（`PublicContent` 的字段 + 证据口径）。 */
export type PublicContentRow = {
  id: string;
  type: ContentType;
  title: string;
  summary: string | null;
  bodyOriginal: string | null;
  bodyTranslated: string | null;
  language: string;
  originalUrl: string;
  imageUrl: string | null;
  publishedAt: string | null;
  source: PublicSourceRow;
  author: PublicPersonRow | null;
  topics: PublicTopicRow[];
  recommendationReason: string | null;
  evidenceSummary: EvidenceSummaryRow;
};

/** 公开证据链里的一条。 */
export type PublicEvidenceRow = {
  id: string;
  evidenceType: string;
  title: string | null;
  url: string;
  publishedAt: string | null;
  isPrimary: boolean;
  /** 证据所属来源（可能没有）。 */
  source: PublicSourceRow | null;
};

/** 列表查询的公共形状。 */
export type ListWindow = {
  limit: number;
  cursor?: string;
};

/* ------------------------------------------------------------------ */
/* 端口                                                                */
/* ------------------------------------------------------------------ */

export interface PublicReadRepository {
  /** 按 id 取一条**可见**内容；不可见或不存在都返回 `null`。 */
  findContent(contentId: bigint): Promise<PublicContentRow | null>;

  /** 批量取（`/today` 用，避免 N+1）。顺序不保证。 */
  findContentsByIds(ids: readonly bigint[]): Promise<PublicContentRow[]>;

  /**
   * 某个时间窗内的可见内容。排序由 `sort` **显式指定**。
   *
   * ```text
   * sort: 'score'    按 finalScore DESC（`/today` 的 featured：当日高分）
   * sort: 'latest'   按 publishedAt DESC（`/today` 的 latest：当日最新）
   * ```
   *
   * ⚠ **`sort` 是必填的，故意不设默认值。** 2026-10-01 修一个真实缺陷时加的：
   * 此前这里只有一个写死的 `finalScore DESC, publishedAt DESC`，而
   * `/today` 的 `latest` 也走它 —— 于是「当日最新」实际是**按分数**排的，
   * 与它自己的文档（`TodayView.latest` 写着「按发布时间倒序」）矛盾。
   *
   * 设默认值会让这个错误重新变得可能（调用方不写就悄悄退化成旧的错误语义）；
   * 必填则**每个调用点都必须表态**自己按什么排。
   */
  listByWindow(input: {
    startUtc: Date;
    endUtc: Date;
    limit: number;
    /** 见上。**必填**，不要给它默认值。 */
    sort: 'score' | 'latest';
    minScore?: number;
  }): Promise<PublicContentRow[]>;

  /**
   * `/x`：**只**取 `type = X_USER` 且 `enabled = true` 的来源下的可见内容。
   *
   * `docs/04`：「不存在用户 follow/subscription 参数」——
   * 这个方法**不接受任何用户维度**的入参，来源集合完全由后台白名单决定。
   */
  listX(input: {
    limit: number;
    cursor?: string;
    personId?: bigint;
    category?: string;
  }): Promise<{ rows: PublicContentRow[]; nextCursor: string | null }>;

  /** 人物列表（带内容数 —— 前端要按数量排序/展示）。 */
  listPeople(): Promise<(PublicPersonRow & { contentCount: number })[]>;

  findPersonBySlug(slug: string): Promise<(PublicPersonRow & { contentCount: number }) | null>;

  /** 某个人的可见内容。 */
  listPersonContents(input: { personId: bigint; limit: number }): Promise<PublicContentRow[]>;

  listTopics(): Promise<(PublicTopicRow & { contentCount: number })[]>;

  findTopicBySlug(slug: string): Promise<(PublicTopicRow & { contentCount: number }) | null>;

  listTopicContents(input: { topicId: bigint; limit: number }): Promise<PublicContentRow[]>;

  findSourceBySlug(slug: string): Promise<
    | (PublicSourceRow & {
        description: string | null;
        baseUrl: string | null;
        contentCount: number;
      })
    | null
  >;

  listSourceContents(input: { sourceId: bigint; limit: number }): Promise<PublicContentRow[]>;

  /** 一个事件的**公开**证据链。事件不存在返回 `null`（与「没有证据」区分开）。 */
  findEventEvidence(eventId: bigint): Promise<PublicEvidenceRow[] | null>;

  /**
   * 全文搜索（`docs/12`：MySQL FULLTEXT，覆盖 title / summary / body_translated）。
   *
   * ⚠ 索引用 **`WITH PARSER ngram`**（Agent 01 的第二个迁移）。
   * 默认 parser 会把一整句中文当成**一个 token**，于是中文子串恒查不到 ——
   * 那是一个「所有测试都绿但功能整体不可用」的缺陷（Agent 01 的 P0）。
   */
  search(input: { query: string; limit: number; offset: number }): Promise<{
    rows: PublicContentRow[];
    total: number;
  }>;

  /** 某个内容所属的事件 id（证据链要按事件取）。 */
  findContentEventId(contentId: bigint): Promise<bigint | null>;
}
