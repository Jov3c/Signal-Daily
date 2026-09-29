/**
 * 审核后端对外的请求 / 响应形状。
 *
 * 响应字段逐条对齐 `docs/09` 的「Review Detail 必须同时看到」那一节与
 * `docs/04` 的 Admin Review 段 —— **少一个字段就是管理员看不到他要做判断的依据**。
 */

import {
  DailySectionType,
  type ContentPipelineStatus,
  type EditorialReviewStatus,
  type EvidenceType,
  type SourceKind,
  type SourceTier,
  type SourceType,
} from '@signal/contracts';

/* ------------------------------------------------------------------ */
/* 查询                                                               */
/* ------------------------------------------------------------------ */

/**
 * 审核队列的筛选。
 *
 * `docs/09`：默认 `finalScore DESC, publishedAt DESC`。
 * 排序**不由客户端指定** —— 审核队列的顺序是产品行为，
 * 让前端任意指定排序会绕过「高分优先」这个设计。
 */
export type ReviewListQuery = {
  /** 页码，从 1 开始。 */
  page: number;
  pageSize: number;
  /** 只看向量状态，默认 `PENDING`。 */
  status?: EditorialReviewStatus;
  /** 分数下限（含）。用于「只看高优先」（`docs/08` 的 85 分档）。 */
  minScore?: number;
  sourceId?: string;
  /** 只看某个事件下的内容。 */
  eventId?: string;
};

export const REVIEW_LIST_DEFAULTS = {
  page: 1,
  pageSize: 20,
  /** 上限 —— 一次最多 100 条，防止后台一次拉全库。 */
  maxPageSize: 100,
} as const;

/* ------------------------------------------------------------------ */
/* 列表项                                                             */
/* ------------------------------------------------------------------ */

/**
 * 列表项（比 Detail 轻，只带决定「先看哪一条」需要的信息）。
 *
 * `docs/09`：「列表额外显示 Source Tier / Official 标记 / Independent Source Count」。
 * 前两个来自 `sources` 表，第三个要按证据链现算。
 */
export type ReviewListItem = {
  contentId: string;
  title: string;
  summary: string | null;
  /** `contents.final_score`；未评分时为 `null`。 */
  finalScore: number | null;
  /** 由 `finalScore` 现算的档位（`docs/08` 的 85/70/55）—— **不落库**。 */
  scoreBand: string | null;
  publishedAt: string | null;
  createdAt: string;
  pipelineStatus: ContentPipelineStatus;

  source: {
    id: string;
    name: string;
    slug: string;
    type: SourceType;
    kind: SourceKind;
    tier: SourceTier;
    official: boolean;
  };

  /** 该内容所属事件；未聚合时为 `null`。 */
  eventId: string | null;
  /** `distinct source_id`（`docs/06` 的口径）。 */
  independentSourceCount: number;
  /** 证据里是否已有官方确认（`docs/08` 的 credibility 输入之一）。 */
  hasOfficialConfirmation: boolean;

  review: {
    id: string;
    status: EditorialReviewStatus;
    publishFeatured: boolean;
    includeDailyCandidate: boolean;
    reviewedAt: string | null;
  };
};

export type ReviewListResponse = {
  data: ReviewListItem[];
  meta: { page: number; pageSize: number; total: number; totalPages: number };
};

/* ------------------------------------------------------------------ */
/* 详情                                                               */
/* ------------------------------------------------------------------ */

/** 一条证据（后台要看到它的类型、来源、URL 与是否 Primary）。 */
export type EvidenceDetail = {
  evidenceId: string;
  evidenceType: EvidenceType;
  title: string | null;
  url: string;
  publishedAt: string | null;
  isPrimary: boolean;
  /** 关联内容的 id；人工补的证据可能没有。 */
  contentId: string | null;
  source: { id: string; name: string; kind: SourceKind; tier: SourceTier; official: boolean } | null;
};

/** 相似/重复内容（`docs/09` 要求 Detail 能看到）。 */
export type SimilarContent = {
  contentId: string;
  title: string;
  sourceName: string;
  /** Jaccard 相似度 0–1，或 `null`（无法比较）。 */
  similarity: number | null;
  /** 是否来自同一个 Source（同源重复的意义与跨源不同）。 */
  sameSource: boolean;
  /** `true` 表示这条就是当前内容所属事件的正本。 */
  isEventPrimary: boolean;
};

export type ReviewDetail = {
  content: {
    id: string;
    type: string;
    title: string;
    summary: string | null;
    /** 原文 —— `docs/00`：翻译永远不覆盖原文，两列并存。 */
    bodyOriginal: string | null;
    bodyTranslated: string | null;
    language: string;
    originalUrl: string;
    imageUrl: string | null;
    publishedAt: string | null;
    createdAt: string;
    pipelineStatus: ContentPipelineStatus;
  };

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

  /** AI 六维分数（`docs/08` 的权重；未评分时为 `null`）。 */
  aiScore: {
    dimensions: {
      importance: number | null;
      relevance: number | null;
      credibility: number | null;
      novelty: number | null;
      density: number | null;
      readValue: number | null;
    };
    finalScore: number | null;
    band: string | null;
    /** 推荐理由 —— 管理员在审核页要读它。 */
    recommendationReason: string | null;
    /** 主题 slug（Agent 06 的分类结果）。 */
    topics: string[];
    /** 完整的分区结构（`aiAnalysis.score`），供后台展示更多细节。 */
    analysis: Record<string, unknown> | null;
  };

  /** 事件与证据链。 */
  event: {
    id: string;
    canonicalTitle: string;
    primaryContentId: string | null;
    isPrimaryContent: boolean;
    independentSourceCount: number;
    hasOfficialConfirmation: boolean;
    primaryEvidence: EvidenceDetail | null;
    supportingEvidence: EvidenceDetail[];
    relatedDiscussion: EvidenceDetail[];
    /** 事件下的全部内容（多来源覆盖）。 */
    contents: { contentId: string; title: string; sourceName: string; isPrimary: boolean }[];
  } | null;

  /** 相似 / 重复内容（`docs/09`）。 */
  similarContents: SimilarContent[];

  review: {
    id: string;
    status: EditorialReviewStatus;
    publishFeatured: boolean;
    includeDailyCandidate: boolean;
    adminNote: string | null;
    reviewedByUserId: string | null;
    reviewedAt: string | null;
    createdAt: string;
  };
};

/* ------------------------------------------------------------------ */
/* 审核决策                                                            */
/* ------------------------------------------------------------------ */

/**
 * 审核动作（`docs/09`：「Approve Featured / Approve Daily / Both / Defer / Reject」）。
 *
 * **不是**直接写 `EditorialReviewStatus` —— 那个枚举里没有「Both」，
 * 而产品上「同时进精选与日报候选」是一个动作而不是两个。
 * 由服务层把它翻译成 `status` + 两个布尔位。
 */
export const REVIEW_ACTIONS = ['APPROVE_FEATURED', 'APPROVE_DAILY', 'APPROVE_BOTH', 'DEFER', 'REJECT'] as const;
export type ReviewAction = (typeof REVIEW_ACTIONS)[number];

export type ReviewDecisionInput = {
  action: ReviewAction;
  /** 管理员备注（可选，落 `EditorialReview.adminNote`）。 */
  note?: string | null;
};

export type ReviewDecisionResponse = {
  contentId: string;
  reviewStatus: EditorialReviewStatus;
  pipelineStatus: ContentPipelineStatus;
  publishFeatured: boolean;
  includeDailyCandidate: boolean;
  reviewedAt: string;
};

/** 批量动作 —— `docs/09`：**只允许 Reject / Defer**。 */
export const BULK_REVIEW_ACTIONS = ['DEFER', 'REJECT'] as const;
export type BulkReviewAction = (typeof BULK_REVIEW_ACTIONS)[number];

export type BulkReviewInput = {
  contentIds: string[];
  action: BulkReviewAction;
  note?: string | null;
};

export type BulkReviewResponse = {
  /** 实际改动的条数。 */
  updated: number;
  /**
   * 被跳过的 id 与原因。
   *
   * ⚠ **不静默跳过**：某个 id 不存在、或不是待审状态时，
   * 管理员必须知道「我点的这 10 条里只有 7 条生效了」——
   * 否则他会以为全处理完了。
   */
  skipped: { contentId: string; reason: string }[];
};

/* ------------------------------------------------------------------ */
/* Evidence 人工操作                                                   */
/* ------------------------------------------------------------------ */

export type AddEvidenceInput = {
  url: string;
  evidenceType: EvidenceType;
  title?: string | null;
  publishedAt?: string | null;
  /** 可选：把这条证据关联到事件里的某条内容。 */
  contentId?: string | null;
};

export type UpdateEvidenceInput = {
  evidenceType?: EvidenceType;
  title?: string | null;
  /** `docs/09`：「修改 Evidence type」；URL 也允许改（改错了链接）。 */
  url?: string;
};

export type EvidenceMutationResponse = {
  eventId: string;
  evidence: EvidenceDetail;
  /** 该事件当前的 Primary（可能因本次操作而变化）。 */
  primaryEvidenceId: string | null;
  independentSourceCount: number;
};

/* ------------------------------------------------------------------ */
/* Dashboard（`docs/09`）                                              */
/* ------------------------------------------------------------------ */

export type DashboardResponse = {
  /** 今日抓取（按上海业务日）。 */
  todayFetched: number;
  /** 高分候选（`finalScore >= 85`，`docs/08` 的一级候选）。 */
  highScorePending: number;
  /** 待审核总数。 */
  pendingReview: number;
  /** 采集失败的来源（`sources.last_error_code` 非空）。 */
  failingSources: { id: string; name: string; lastErrorCode: string; lastErrorAt: string | null }[];
  /** AI 成本（今日，USD）。 */
  aiCostTodayUsd: number;
  /** 日报状态（最近一期的 `DailyEditionStatus`）。 */
  latestDailyEdition: { id: string; businessDate: string; status: string } | null;
};

/** 供 DTO 层复用的常量（避免魔法数字散落）。 */
export const HIGH_SCORE_THRESHOLD = 85;
export const DAILY_SECTION_TYPES_FOR_DISPLAY: readonly DailySectionType[] = Object.values(DailySectionType);
