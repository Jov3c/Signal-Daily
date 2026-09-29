/**
 * `ReviewService` —— 审核队列、详情与决策编排。
 *
 * ── 本模块**只做决策**，不做发布 ────────────────────────────────────
 * `docs/09` 的审核动作是「Approve Featured / Approve Daily / Both / Defer / Reject」，
 * 而 `FeaturedItem` / `DailyItem` 属 **Agent 08（Publishing）**。
 * 因此本模块只写：
 *
 * ```text
 * EditorialReview.status / publishFeatured / includeDailyCandidate
 * Content.pipelineStatus
 * ```
 * 「什么时候真的上线」由 08 决定 —— 决策与发布分开，才能让 08 有自己的节奏
 *（例如日报要等到次日 08:00）。已记入 HANDOFF。
 *
 * ── 相似内容的口径：**不重算相似度** ────────────────────────────────
 * `docs/09` 要求 Detail 能看到「相似/重复内容」。相似度算法在 Agent 05 的
 * worker 模块里（中文 bigram + Jaccard），**跨 app 不能 import**。
 * 本模块用**事件成员**作为「相似内容」：那是相似度判定的**结论**
 *（它们就是因为相似才被聚到一起的），语义正确且不需要第三份实现。
 *
 * 需要单独说明的两点：
 * - **精确重复不会出现在这里** —— 它们在建 Content 之前就被 Agent 05 挡掉了
 *   （`raw_items.status = DUPLICATE`），库里没有第二行 Content 可展示；
 * - `similarity` 字段返回 `null`（不谎报一个没算过的数字）。
 */

import { Inject, Injectable } from '@nestjs/common';
import {
  AppError,
  ContentPipelineStatus,
  EditorialReviewStatus,
  PlatformErrorCode,
} from '@signal/contracts';
import { businessDateOf, businessDayRangeUtc } from '@signal/config';
import type {
  DashboardResponse,
  EvidenceDetail,
  ReviewAction,
  ReviewDecisionResponse,
  ReviewDetail,
  ReviewListItem,
  ReviewListQuery,
  ReviewListResponse,
  SimilarContent,
} from './dto/review.dto';
import { REVIEW_LIST_DEFAULTS } from './dto/review.dto';
import {
  ADMIN_REVIEW_REPOSITORY,
  type AdminReviewRepository,
  type EventEvidenceStats,
  type EvidenceRow,
} from './repository';
import { scoreBand } from './scoring';

/** 注入 token。 */
export const REVIEW_LOGGER = 'REVIEW_LOGGER';

/** 审核动作 → 落库时的三件套。 */
type DecisionMapping = {
  reviewStatus: EditorialReviewStatus;
  pipelineStatus: ContentPipelineStatus;
  publishFeatured: boolean;
  includeDailyCandidate: boolean;
};

/**
 * `docs/09` 的五个审核动作 → 状态与两个布尔位。
 *
 * 用 `Record<ReviewAction, …>` 而不是 `switch`：契约新增动作时这里会**编译不过**，
 * 而不是在运行期落进某个 default 分支（那意味着一个没人处理的审核动作被静默吞掉）。
 */
export const DECISION_MAPPINGS: Readonly<Record<ReviewAction, DecisionMapping>> = {
  APPROVE_FEATURED: {
    reviewStatus: EditorialReviewStatus.APPROVED,
    pipelineStatus: ContentPipelineStatus.APPROVED,
    publishFeatured: true,
    includeDailyCandidate: false,
  },
  APPROVE_DAILY: {
    reviewStatus: EditorialReviewStatus.APPROVED,
    pipelineStatus: ContentPipelineStatus.APPROVED,
    publishFeatured: false,
    includeDailyCandidate: true,
  },
  APPROVE_BOTH: {
    reviewStatus: EditorialReviewStatus.APPROVED,
    pipelineStatus: ContentPipelineStatus.APPROVED,
    publishFeatured: true,
    includeDailyCandidate: true,
  },
  DEFER: {
    reviewStatus: EditorialReviewStatus.DEFERRED,
    // ⚠ **暂缓不改内容状态**：它还在候选池里等着被重新审，
    // 置成 ARCHIVED 会让它从队列里消失（那才是「拒绝」的语义）。
    pipelineStatus: ContentPipelineStatus.REVIEW_PENDING,
    publishFeatured: false,
    includeDailyCandidate: false,
  },
  REJECT: {
    reviewStatus: EditorialReviewStatus.REJECTED,
    pipelineStatus: ContentPipelineStatus.REJECTED,
    publishFeatured: false,
    includeDailyCandidate: false,
  },
};

/** 内容/审核行不存在。 */
function notFound(contentId: string): AppError {
  return new AppError({
    code: PlatformErrorCode.NOT_FOUND,
    httpStatus: 404,
    safeMessage: `Content not found in the review queue: ${contentId}`,
    details: { contentId },
  });
}

@Injectable()
export class ReviewService {
  constructor(@Inject(ADMIN_REVIEW_REPOSITORY) private readonly repository: AdminReviewRepository) {}

  /** 审核队列（`docs/09` 的默认排序与额外列）。 */
  async list(query: ReviewListQuery): Promise<ReviewListResponse> {
    const { rows, total } = await this.repository.listReviews(query);

    // 一次算好整页事件的证据口径，避免每行一次查询。
    const eventIds = rows.map((row) => row.eventId).filter((id): id is string => id !== null);
    const stats = await this.repository.eventEvidenceStats(eventIds);

    const items: ReviewListItem[] = rows.map((row) => {
      const evidence = row.eventId === null ? undefined : stats.get(row.eventId);
      return {
        contentId: row.contentId,
        title: row.title,
        summary: row.summary,
        finalScore: row.finalScore,
        // 档位是**派生值、不落库** —— 与 Agent 06 的取舍一致。
        scoreBand: row.finalScore === null ? null : scoreBand(row.finalScore),
        publishedAt: row.publishedAt,
        createdAt: row.createdAt,
        pipelineStatus: row.pipelineStatus,
        source: row.source,
        eventId: row.eventId,
        independentSourceCount: evidence?.independentSourceCount ?? 0,
        hasOfficialConfirmation: evidence?.hasOfficialConfirmation ?? false,
        review: row.review,
      };
    });

    return {
      data: items,
      meta: {
        page: query.page,
        pageSize: query.pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
      },
    };
  }

  /** 审核详情（`docs/09` 的「必须同时看到」清单）。 */
  async detail(contentId: string): Promise<ReviewDetail> {
    const content = await this.repository.findReviewDetailContent(contentId);
    if (content === null) throw notFound(contentId);

    const event = content.eventId === null ? null : await this.repository.findEventDetail(content.eventId);

    const evidences = event?.evidences ?? [];
    const primary = evidences.find((evidence) => evidence.isPrimary) ?? null;
    const supporting = evidences.filter(
      (evidence) => !evidence.isPrimary && isSupporting(evidence.evidenceType),
    );
    const related = evidences.filter(
      (evidence) => !evidence.isPrimary && !isSupporting(evidence.evidenceType),
    );

    const stats = await this.repository.eventEvidenceStats(
      event === null ? [] : [event.eventId],
    );
    const eventStats: EventEvidenceStats | undefined =
      event === null ? undefined : stats.get(event.eventId);

    const similarContents: SimilarContent[] = (event?.contents ?? [])
      .filter((member) => member.contentId !== contentId)
      .map((member) => ({
        contentId: member.contentId,
        title: member.title,
        sourceName: member.sourceName,
        // **不重算相似度**（算法在 worker 侧，跨 app 不能 import）——
        // 事件成员本身就是相似度判定的结论。返回 null 而不是编一个数字。
        similarity: null,
        // `sameSource` 无法从事件成员表里直接得到（没有 sourceId 字段）；
        // 不谎报 —— 需要它的下游应当查事件的证据链。
        sameSource: false,
        isEventPrimary: member.isPrimary,
      }));

    return {
      content: {
        id: content.id,
        type: content.type,
        title: content.title,
        summary: content.summary,
        bodyOriginal: content.bodyOriginal,
        bodyTranslated: content.bodyTranslated,
        language: content.language,
        originalUrl: content.originalUrl,
        imageUrl: content.imageUrl,
        publishedAt: content.publishedAt,
        createdAt: content.createdAt,
        pipelineStatus: content.pipelineStatus,
      },
      source: content.source,
      aiScore: {
        dimensions: {
          importance: content.scores.importance,
          relevance: content.scores.relevance,
          credibility: content.scores.credibility,
          novelty: content.scores.novelty,
          density: content.scores.density,
          readValue: content.scores.readValue,
        },
        finalScore: content.scores.finalScore,
        band: content.scores.finalScore === null ? null : scoreBand(content.scores.finalScore),
        recommendationReason: content.recommendationReason,
        topics: extractTopics(content.aiAnalysisScore),
        analysis: content.aiAnalysisScore,
      },
      event:
        event === null
          ? null
          : {
              id: event.eventId,
              canonicalTitle: event.canonicalTitle,
              primaryContentId: event.primaryContentId,
              isPrimaryContent: event.primaryContentId === contentId,
              independentSourceCount: eventStats?.independentSourceCount ?? 0,
              hasOfficialConfirmation: eventStats?.hasOfficialConfirmation ?? false,
              primaryEvidence: primary === null ? null : toEvidenceDetail(primary),
              supportingEvidence: supporting.map(toEvidenceDetail),
              relatedDiscussion: related.map(toEvidenceDetail),
              contents: event.contents,
            },
      similarContents,
      review: await this.reviewOf(contentId),
    };
  }

  /** 单条决策（`docs/09` 的五个动作）。 */
  async decide(
    contentId: string,
    action: ReviewAction,
    note: string | null,
    adminUserId: string,
    now: Date,
  ): Promise<ReviewDecisionResponse> {
    const mapping = DECISION_MAPPINGS[action];

    const result = await this.repository.applyDecision({
      contentId,
      reviewStatus: mapping.reviewStatus,
      pipelineStatus: mapping.pipelineStatus,
      publishFeatured: mapping.publishFeatured,
      includeDailyCandidate: mapping.includeDailyCandidate,
      adminNote: note,
      reviewedByUserId: adminUserId,
      reviewedAt: now,
    });

    // 审核行由 Agent 05 创建；本模块不代它创建（否则会出现没有流水线来源的审核行）。
    if (result === null) throw notFound(contentId);

    return {
      contentId,
      reviewStatus: result.reviewStatus,
      pipelineStatus: result.pipelineStatus,
      publishFeatured: result.publishFeatured,
      includeDailyCandidate: result.includeDailyCandidate,
      reviewedAt: result.reviewedAt,
    };
  }

  /** 批量决策（`docs/09`：**只允许 Reject / Defer**）。 */
  async bulk(
    contentIds: readonly string[],
    action: 'DEFER' | 'REJECT',
    note: string | null,
    adminUserId: string,
    now: Date,
  ): Promise<{ updated: number; skipped: { contentId: string; reason: string }[] }> {
    const mapping = DECISION_MAPPINGS[action];

    return this.repository.applyBulk({
      contentIds,
      reviewStatus: mapping.reviewStatus,
      pipelineStatus: mapping.pipelineStatus,
      adminNote: note,
      reviewedByUserId: adminUserId,
      reviewedAt: now,
    });
  }

  /**
   * Dashboard 的数字（）。
   *
   * 「今日」按**上海业务日**统计 ——  的
   *  /  是唯一权威，
   * 不自己算 UTC+8（那是 Agent 03 踩过的坑：本机 MySQL 的  是
   * Asia/Shanghai，手算偏移会和它差 8 小时）。
   */
  async dashboard(now: Date): Promise<DashboardResponse> {
    const businessDate = businessDateOf(now);
    const { startUtc, endUtc } = businessDayRangeUtc(businessDate);

    const stats = await this.repository.dashboardStats({
      businessDayStartUtc: startUtc,
      businessDayEndUtc: endUtc,
    });

    return {
      todayFetched: stats.todayFetched,
      highScorePending: stats.highScorePending,
      pendingReview: stats.pendingReview,
      failingSources: stats.failingSources,
      aiCostTodayUsd: stats.aiCostTodayUsd,
      latestDailyEdition: stats.latestDailyEdition,
    };
  }

  /** 读审核行；不存在时抛 404（审核行由 Agent 05 创建）。 */
  private async reviewOf(contentId: string): Promise<ReviewDetail['review']> {
    const row = await this.repository.findReviewByContentId(contentId);
    if (row === null) throw notFound(contentId);
    return row;
  }
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

/** 支持性证据（媒体/开发者来源）—— 与 `relatedDiscussion` 分开给后台看。 */
function isSupporting(type: EvidenceRow['evidenceType']): boolean {
  return type === 'SUPPORTING_SOURCE' || type === 'SOCIAL_CONFIRMATION';
}

/** 把仓储行转成对外的证据形状。 */
function toEvidenceDetail(row: EvidenceRow): EvidenceDetail {
  return {
    evidenceId: row.evidenceId,
    evidenceType: row.evidenceType,
    title: row.title,
    url: row.url,
    publishedAt: row.publishedAt,
    isPrimary: row.isPrimary,
    contentId: row.contentId,
    source: row.source,
  };
}

/** 从 `ai_analysis.score.topics` 取主题 slug（Agent 06 定义的结构）。 */
function extractTopics(score: Record<string, unknown> | null): string[] {
  if (score === null) return [];
  const topics = score['topics'];
  if (!Array.isArray(topics)) return [];
  return topics.filter((topic): topic is string => typeof topic === 'string' && topic !== '');
}

/** 供模块与测试使用：默认分页参数。 */
export { REVIEW_LIST_DEFAULTS };
