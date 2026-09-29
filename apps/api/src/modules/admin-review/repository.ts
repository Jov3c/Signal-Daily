/**
 * `AdminReviewRepository` 端口 —— 审核后端与证据管理的持久化契约。
 *
 * 端口化的理由与 Agent 02/03 一致：单元测试可以用内存替身完整验证
 * 服务层行为（决策映射、批量跳过、Primary 切换、审计），不需要 MySQL；
 * 真实 SQL 语义再由 `admin-review-db.integration.spec.ts` 在真库上跑一遍。
 *
 * ⚠ 端口一律使用**契约枚举**，由 `prisma-admin-review.repository.ts`
 * 在边界做带校验的收敛（复用 `common/prisma/prisma-enums` 的 `toContractEnum`）。
 */

import type {
  ContentPipelineStatus,
  ContentType,
  DailyEditionStatus,
  EditorialReviewStatus,
  EvidenceType,
  SourceKind,
  SourceTier,
  SourceType,
} from '@signal/contracts';

/** 注入 token。 */
export const ADMIN_REVIEW_REPOSITORY = 'ADMIN_REVIEW_REPOSITORY';

/* ------------------------------------------------------------------ */
/* 审核队列                                                            */
/* ------------------------------------------------------------------ */

/** 列表查询的输入。 */
export type ListReviewInput = {
  page: number;
  pageSize: number;
  status?: EditorialReviewStatus;
  minScore?: number;
  sourceId?: string;
  eventId?: string;
};

/** 列表项的一行（含来源与事件 id）。 */
export type ReviewListRow = {
  contentId: string;
  title: string;
  summary: string | null;
  finalScore: number | null;
  publishedAt: string | null;
  createdAt: string;
  pipelineStatus: ContentPipelineStatus;
  eventId: string | null;
  source: {
    id: string;
    name: string;
    slug: string;
    type: SourceType;
    kind: SourceKind;
    tier: SourceTier;
    official: boolean;
  };
  review: {
    id: string;
    status: EditorialReviewStatus;
    publishFeatured: boolean;
    includeDailyCandidate: boolean;
    reviewedAt: string | null;
  };
};

/**
 * 一个事件的**证据口径**统计。
 *
 * ⚠ `docs/03`：`independentSourceCount` **不冗余存储**，查询时按
 * `distinct source_id` 算。这里一次算好整页事件的口径，
 * 避免「每行一次查询」的 N+1。
 */
export type EventEvidenceStats = {
  eventId: string;
  /** `distinct source_id`（`docs/06` 的口径：同源多条只算 1）。 */
  independentSourceCount: number;
  /** 证据里是否存在官方确认（`OFFICIAL_CONFIRMATION`，或官方来源的 `PRIMARY_SOURCE`）。 */
  hasOfficialConfirmation: boolean;
};

/* ------------------------------------------------------------------ */
/* 审核详情                                                            */
/* ------------------------------------------------------------------ */

/** 详情里的内容部分。 */
export type ReviewDetailContentRow = {
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
  createdAt: string;
  pipelineStatus: ContentPipelineStatus;
  /** 六维 + final（未评分时全为 `null`）。 */
  scores: {
    importance: number | null;
    relevance: number | null;
    credibility: number | null;
    novelty: number | null;
    density: number | null;
    readValue: number | null;
    finalScore: number | null;
  };
  recommendationReason: string | null;
  /** `aiAnalysis.score` 分区（原样返回给后台展示更多细节）。 */
  aiAnalysisScore: Record<string, unknown> | null;
  eventId: string | null;
  source: {
    id: string;
    name: string;
    slug: string;
    type: SourceType;
    kind: SourceKind;
    tier: SourceTier;
    official: boolean;
    baseUrl: string | null;
  };
};

/** 一条证据的原始行。 */
export type EvidenceRow = {
  evidenceId: string;
  eventId: string;
  evidenceType: EvidenceType;
  title: string | null;
  url: string;
  /** `Char(64)` 的 sha256 十六进制小写。 */
  urlHash: string;
  publishedAt: string | null;
  isPrimary: boolean;
  contentId: string | null;
  sourceId: string | null;
  source: {
    id: string;
    name: string;
    kind: SourceKind;
    tier: SourceTier;
    official: boolean;
  } | null;
};

/** 事件 + 它的内容与证据。 */
export type EventDetailRow = {
  eventId: string;
  canonicalTitle: string;
  primaryContentId: string | null;
  contents: {
    contentId: string;
    title: string;
    sourceName: string;
    isPrimary: boolean;
  }[];
  evidences: EvidenceRow[];
};

/* ------------------------------------------------------------------ */
/* 决策                                                                */
/* ------------------------------------------------------------------ */

/** 一次决策要写的东西（服务层算好，仓储只负责原子落库）。 */
export type ApplyDecisionInput = {
  contentId: string;
  reviewStatus: EditorialReviewStatus;
  pipelineStatus: ContentPipelineStatus;
  publishFeatured: boolean;
  includeDailyCandidate: boolean;
  adminNote: string | null;
  reviewedByUserId: string;
  reviewedAt: Date;
};

export type ApplyDecisionResult = {
  reviewId: string;
  reviewStatus: EditorialReviewStatus;
  pipelineStatus: ContentPipelineStatus;
  publishFeatured: boolean;
  includeDailyCandidate: boolean;
  reviewedAt: string;
};

/** 批量决策的结果。 */
export type ApplyBulkResult = {
  updated: number;
  skipped: { contentId: string; reason: string }[];
};

/* ------------------------------------------------------------------ */
/* Evidence 操作                                                       */
/* ------------------------------------------------------------------ */

export type AddEvidenceRecord = {
  eventId: string;
  evidenceType: EvidenceType;
  title: string | null;
  url: string;
  urlHash: string;
  publishedAt: Date | null;
  contentId: string | null;
  /** 从内容继承的 sourceId；人工补的 URL 没有归属内容时为 `null`。 */
  sourceId: string | null;
};

export type UpdateEvidenceRecord = {
  eventId: string;
  evidenceId: string;
  evidenceType?: EvidenceType;
  title?: string | null;
  url?: string;
  urlHash?: string;
};

/* ------------------------------------------------------------------ */
/* Dashboard                                                           */
/* ------------------------------------------------------------------ */

export type DashboardStats = {
  todayFetched: number;
  highScorePending: number;
  pendingReview: number;
  failingSources: { id: string; name: string; lastErrorCode: string; lastErrorAt: string | null }[];
  aiCostTodayUsd: number;
  latestDailyEdition: { id: string; businessDate: string; status: DailyEditionStatus } | null;
};

/* ------------------------------------------------------------------ */
/* 端口                                                                */
/* ------------------------------------------------------------------ */

export interface AdminReviewRepository {
  /* 审核队列 */
  listReviews(input: ListReviewInput): Promise<{ rows: ReviewListRow[]; total: number }>;

  /**
   * 一次算好一批事件的证据口径（避免 N+1）。
   *
   * 返回的 Map 只包含**查得到事件**的那些 id；没有事件的返回空 Map。
   */
  eventEvidenceStats(eventIds: readonly string[]): Promise<Map<string, EventEvidenceStats>>;

  /* 详情 */
  /** 读某条内容的审核行（不存在时返回 `null`）。 */
  findReviewByContentId(contentId: string): Promise<{
    id: string;
    status: EditorialReviewStatus;
    publishFeatured: boolean;
    includeDailyCandidate: boolean;
    adminNote: string | null;
    reviewedByUserId: string | null;
    reviewedAt: string | null;
    createdAt: string;
  } | null>;

  findReviewDetailContent(contentId: string): Promise<ReviewDetailContentRow | null>;
  findEventDetail(eventId: string): Promise<EventDetailRow | null>;

  /* 决策 */
  /**
   * 应用一次决策。**同一事务**里写 `EditorialReview` + `Content.pipelineStatus`。
   *
   * `EditorialReview` 不存在时返回 `null`（调用方转成 404）——
   * 审核行由 Agent 05 创建，本模块不代它创建（否则会出现「没有流水线来源的审核行」）。
   */
  applyDecision(input: ApplyDecisionInput): Promise<ApplyDecisionResult | null>;

  /** 批量决策：逐条走同一套逻辑，逐条记录跳过原因。 */
  applyBulk(input: {
    contentIds: readonly string[];
    reviewStatus: EditorialReviewStatus;
    pipelineStatus: ContentPipelineStatus;
    adminNote: string | null;
    reviewedByUserId: string;
    reviewedAt: Date;
  }): Promise<ApplyBulkResult>;

  /* Evidence */
  findEvidence(eventId: string, evidenceId: string): Promise<EvidenceRow | null>;
  addEvidence(record: AddEvidenceRecord): Promise<EvidenceRow>;
  updateEvidence(record: UpdateEvidenceRecord): Promise<EvidenceRow | null>;
  deleteEvidence(eventId: string, evidenceId: string): Promise<boolean>;

  /**
   * 把某条证据设为该事件的 Primary。
   *
   * ⚠ **必须在同一事务内**：先把该事件现有的 `isPrimary` 全部置 false，
   * 再设新的 —— `docs/03` 明确「一个事件最多一个 Primary」**DB 层不强制**，
   * 两件事分开做会出现两个 Primary 或一个都没有的中间态。
   */
  setPrimaryEvidence(eventId: string, evidenceId: string): Promise<{ primaryEvidenceId: string } | null>;

  /* 管理员通知（docs/09 的 Dashboard 与任务书的「管理员通知」） */

  /**
   * 已经通知过的去重键。
   *
   *  表**没有唯一约束**，所以「同一件事只通知一次」
   * 必须由业务层保证。去重键用  ——
   * targetUrl 指向被通知的对象（某条内容 / 某个来源）。
   */
  findNotifiedKeys(type: string): Promise<Set<string>>;

  /** 落一条通知。返回新行 id。 */
  createNotification(input: {
    type: string;
    title: string;
    body: string;
    targetUrl: string | null;
  }): Promise<string>;

  /** 高分且**仍在待审**的候选（通知扫描用）。 */
  listHighScoreCandidates(minScore: number): Promise<
    { contentId: string; title: string; finalScore: number; recommendationReason: string | null }[]
  >;

  /** 采集失败的来源（通知扫描用）。 */
  listFailingSources(): Promise<
    { id: string; name: string; lastErrorCode: string; lastErrorAt: string | null }[]
  >;

  /* Dashboard */
  dashboardStats(input: { businessDayStartUtc: Date; businessDayEndUtc: Date }): Promise<DashboardStats>;
}
