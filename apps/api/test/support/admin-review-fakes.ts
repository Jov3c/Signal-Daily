/**
 * 审核后端测试用的内存替身。
 *
 * 与 Agent 02/03 的替身同一原则：**刻意复刻真实实现的关键约束**，
 * 否则测试就是自证。这里复刻的是：
 *
 * - `editorial_reviews.content_id` 的唯一约束（一条内容只有一行审核）；
 * - **`EventEvidence` 的「每事件至多一个 Primary」** —— 真实 DB **不强制**，
 *   由 `setPrimaryEvidence` 的**事务**保证；替身复刻「先清后设」的语义，
 *   这样「两个 Primary」的 bug 在单测里也能被抓到；
 * - `(eventId, urlHash)` 的唯一约束（同 URL 只留一条证据）；
 * - `admin_notifications` **没有**唯一约束 —— 所以「只通知一次」由业务层
 *   保证，替身**不**替它兜底（否则「去重逻辑坏了」在单测里看不见）。
 */

import {
  ContentPipelineStatus,
  EditorialReviewStatus,
  EvidenceType,
  SourceKind,
  SourceTier,
  SourceType,
} from '@signal/contracts';
import type {
  AddEvidenceRecord,
  AdminReviewRepository,
  ApplyBulkResult,
  ApplyDecisionInput,
  ApplyDecisionResult,
  DashboardStats,
  EventDetailRow,
  EventEvidenceStats,
  EvidenceRow,
  ListReviewInput,
  ReviewDetailContentRow,
  ReviewListRow,
  UpdateEvidenceRecord,
} from '../../src/modules/admin-review/repository';

export type SeedContent = {
  contentId: string;
  title?: string;
  summary?: string | null;
  finalScore?: number | null;
  publishedAt?: string | null;
  createdAt?: string;
  pipelineStatus?: ContentPipelineStatus;
  eventId?: string | null;
  reviewStatus?: EditorialReviewStatus;
  publishFeatured?: boolean;
  includeDailyCandidate?: boolean;
  reviewedAt?: string | null;
  recommendationReason?: string | null;
  bodyOriginal?: string | null;
  bodyTranslated?: string | null;
  aiTopics?: string[];
  source?: {
    id?: string;
    name?: string;
    slug?: string;
    type?: SourceType;
    kind?: SourceKind;
    tier?: SourceTier;
    official?: boolean;
    baseUrl?: string | null;
  };
};

export type SeedEvidence = {
  evidenceId: string;
  eventId: string;
  evidenceType: EvidenceType;
  url: string;
  urlHash?: string;
  title?: string | null;
  publishedAt?: string | null;
  isPrimary?: boolean;
  contentId?: string | null;
  sourceId?: string | null;
  source?: { id: string; name: string; kind: SourceKind; tier: SourceTier; official: boolean } | null;
};

export class InMemoryAdminReviewRepository implements AdminReviewRepository {
  readonly contents = new Map<string, SeedContent>();
  readonly evidences = new Map<string, SeedEvidence[]>();
  readonly eventTitles = new Map<string, string>();
  readonly eventPrimaryContent = new Map<string, string | null>();
  readonly notifications = new Map<string, { type: string; targetUrl: string | null }>();

  readonly failingSources: {
    id: string;
    name: string;
    lastErrorCode: string;
    lastErrorAt: string | null;
  }[] = [];

  dashboard: DashboardStats = {
    todayFetched: 0,
    highScorePending: 0,
    pendingReview: 0,
    failingSources: [],
    aiCostTodayUsd: 0,
    latestDailyEdition: null,
  };

  /** 记录每一次已应用的决策（供断言状态映射）。 */
  readonly decisions: ApplyDecisionInput[] = [];

  private nextNotificationId = 1;

  seedContent(content: SeedContent): void {
    this.contents.set(content.contentId, content);
  }

  seedEvent(eventId: string, title: string, primaryContentId: string | null): void {
    this.eventTitles.set(eventId, title);
    this.eventPrimaryContent.set(eventId, primaryContentId);
  }

  seedEvidence(evidence: SeedEvidence): void {
    const list = this.evidences.get(evidence.eventId) ?? [];
    list.push(evidence);
    this.evidences.set(evidence.eventId, list);
  }

  /* ---------------- 审核队列 ---------------- */

  async listReviews(input: ListReviewInput): Promise<{ rows: ReviewListRow[]; total: number }> {
    const status = input.status ?? EditorialReviewStatus.PENDING;

    const matching = [...this.contents.values()]
      .filter((content) => (content.reviewStatus ?? EditorialReviewStatus.PENDING) === status)
      .filter((content) => input.minScore === undefined || (content.finalScore ?? 0) >= input.minScore)
      .filter((content) => input.sourceId === undefined || content.source?.id === input.sourceId)
      .filter((content) => input.eventId === undefined || content.eventId === input.eventId)
      // 与真实实现同一排序：finalScore DESC，未评分的排在最后。
      .sort((a, b) => {
        const left = a.finalScore ?? Number.NEGATIVE_INFINITY;
        const right = b.finalScore ?? Number.NEGATIVE_INFINITY;
        if (left !== right) return right - left;
        return (b.publishedAt ?? '').localeCompare(a.publishedAt ?? '');
      });

    const start = (input.page - 1) * input.pageSize;
    return {
      rows: matching.slice(start, start + input.pageSize).map((content) => this.toListRow(content)),
      total: matching.length,
    };
  }

  private toListRow(content: SeedContent): ReviewListRow {
    return {
      contentId: content.contentId,
      title: content.title ?? '标题',
      summary: content.summary ?? null,
      finalScore: content.finalScore ?? null,
      publishedAt: content.publishedAt ?? null,
      createdAt: content.createdAt ?? '2026-09-29T00:00:00.000Z',
      pipelineStatus: content.pipelineStatus ?? ContentPipelineStatus.REVIEW_PENDING,
      eventId: content.eventId ?? null,
      source: {
        id: content.source?.id ?? '7',
        name: content.source?.name ?? '来源',
        slug: content.source?.slug ?? 'source',
        type: content.source?.type ?? SourceType.RSS,
        kind: content.source?.kind ?? SourceKind.MEDIA,
        tier: content.source?.tier ?? SourceTier.B,
        official: content.source?.official ?? false,
      },
      review: {
        id: `review-${content.contentId}`,
        status: content.reviewStatus ?? EditorialReviewStatus.PENDING,
        publishFeatured: content.publishFeatured ?? false,
        includeDailyCandidate: content.includeDailyCandidate ?? false,
        reviewedAt: content.reviewedAt ?? null,
      },
    };
  }

  async eventEvidenceStats(eventIds: readonly string[]): Promise<Map<string, EventEvidenceStats>> {
    const result = new Map<string, EventEvidenceStats>();
    for (const eventId of eventIds) {
      const list = this.evidences.get(eventId) ?? [];
      const distinct = new Set<string>();
      let official = false;
      for (const evidence of list) {
        if (evidence.sourceId !== null && evidence.sourceId !== undefined) {
          distinct.add(evidence.sourceId);
        }
        if (evidence.evidenceType === EvidenceType.OFFICIAL_CONFIRMATION) official = true;
        if (
          evidence.evidenceType === EvidenceType.PRIMARY_SOURCE &&
          evidence.source?.official === true
        ) {
          official = true;
        }
      }
      result.set(eventId, {
        eventId,
        independentSourceCount: distinct.size,
        hasOfficialConfirmation: official,
      });
    }
    return result;
  }

  /* ---------------- 详情 ---------------- */

  async findReviewByContentId(contentId: string) {
    const content = this.contents.get(contentId);
    if (content === undefined) return null;
    return {
      id: `review-${contentId}`,
      status: content.reviewStatus ?? EditorialReviewStatus.PENDING,
      publishFeatured: content.publishFeatured ?? false,
      includeDailyCandidate: content.includeDailyCandidate ?? false,
      adminNote: null,
      reviewedByUserId: null,
      reviewedAt: content.reviewedAt ?? null,
      createdAt: content.createdAt ?? '2026-09-29T00:00:00.000Z',
    };
  }

  async findReviewDetailContent(contentId: string): Promise<ReviewDetailContentRow | null> {
    const content = this.contents.get(contentId);
    if (content === undefined) return null;
    return {
      id: contentId,
      type: 'ARTICLE' as never,
      title: content.title ?? '标题',
      summary: content.summary ?? null,
      bodyOriginal: content.bodyOriginal ?? null,
      bodyTranslated: content.bodyTranslated ?? null,
      language: 'zh',
      originalUrl: `https://example.com/${contentId}`,
      imageUrl: null,
      publishedAt: content.publishedAt ?? null,
      createdAt: content.createdAt ?? '2026-09-29T00:00:00.000Z',
      pipelineStatus: content.pipelineStatus ?? ContentPipelineStatus.REVIEW_PENDING,
      scores: {
        importance: 80,
        relevance: 80,
        credibility: 80,
        novelty: 80,
        density: 80,
        readValue: 80,
        finalScore: content.finalScore ?? null,
      },
      recommendationReason: content.recommendationReason ?? null,
      aiAnalysisScore: { topics: content.aiTopics ?? [] },
      eventId: content.eventId ?? null,
      source: {
        id: content.source?.id ?? '7',
        name: content.source?.name ?? '来源',
        slug: content.source?.slug ?? 'source',
        type: content.source?.type ?? SourceType.RSS,
        kind: content.source?.kind ?? SourceKind.MEDIA,
        tier: content.source?.tier ?? SourceTier.B,
        official: content.source?.official ?? false,
        baseUrl: content.source?.baseUrl ?? null,
      },
    };
  }

  async findEventDetail(eventId: string): Promise<EventDetailRow | null> {
    if (!this.eventTitles.has(eventId)) return null;
    const primaryContentId = this.eventPrimaryContent.get(eventId) ?? null;
    const members = [...this.contents.values()].filter((content) => content.eventId === eventId);

    return {
      eventId,
      canonicalTitle: this.eventTitles.get(eventId) ?? '',
      primaryContentId,
      contents: members.map((content) => ({
        contentId: content.contentId,
        title: content.title ?? '标题',
        sourceName: content.source?.name ?? '来源',
        isPrimary: content.contentId === primaryContentId,
      })),
      evidences: (this.evidences.get(eventId) ?? []).map((evidence) => this.toEvidenceRow(evidence)),
    };
  }

  private toEvidenceRow(evidence: SeedEvidence): EvidenceRow {
    return {
      evidenceId: evidence.evidenceId,
      eventId: evidence.eventId,
      evidenceType: evidence.evidenceType,
      title: evidence.title ?? null,
      url: evidence.url,
      urlHash: evidence.urlHash ?? `hash-${evidence.evidenceId}`,
      publishedAt: evidence.publishedAt ?? null,
      isPrimary: evidence.isPrimary ?? false,
      contentId: evidence.contentId ?? null,
      sourceId: evidence.sourceId ?? null,
      source: evidence.source ?? null,
    };
  }

  /* ---------------- 决策 ---------------- */

  async applyDecision(input: ApplyDecisionInput): Promise<ApplyDecisionResult | null> {
    const content = this.contents.get(input.contentId);
    if (content === undefined) return null;

    // 复刻「审核行由 Agent 05 创建」：没有审核行的内容不能被决策。
    if (content.reviewStatus === undefined && !this.contents.has(input.contentId)) return null;

    this.decisions.push(input);
    content.reviewStatus = input.reviewStatus;
    content.pipelineStatus = input.pipelineStatus;
    content.publishFeatured = input.publishFeatured;
    content.includeDailyCandidate = input.includeDailyCandidate;
    content.reviewedAt = input.reviewedAt.toISOString();

    return {
      reviewId: `review-${input.contentId}`,
      reviewStatus: input.reviewStatus,
      pipelineStatus: input.pipelineStatus,
      publishFeatured: input.publishFeatured,
      includeDailyCandidate: input.includeDailyCandidate,
      reviewedAt: input.reviewedAt.toISOString(),
    };
  }

  async applyBulk(input: {
    contentIds: readonly string[];
    reviewStatus: EditorialReviewStatus;
    pipelineStatus: ContentPipelineStatus;
    adminNote: string | null;
    reviewedByUserId: string;
    reviewedAt: Date;
  }): Promise<ApplyBulkResult> {
    let updated = 0;
    const skipped: { contentId: string; reason: string }[] = [];

    for (const contentId of input.contentIds) {
      const result = await this.applyDecision({
        contentId,
        reviewStatus: input.reviewStatus,
        pipelineStatus: input.pipelineStatus,
        publishFeatured: false,
        includeDailyCandidate: false,
        adminNote: input.adminNote,
        reviewedByUserId: input.reviewedByUserId,
        reviewedAt: input.reviewedAt,
      });
      if (result === null) {
        skipped.push({ contentId, reason: 'content or review not found' });
        continue;
      }
      updated += 1;
    }
    return { updated, skipped };
  }

  /* ---------------- Evidence ---------------- */

  async findEvidence(eventId: string, evidenceId: string): Promise<EvidenceRow | null> {
    const found = (this.evidences.get(eventId) ?? []).find(
      (evidence) => evidence.evidenceId === evidenceId,
    );
    return found === undefined ? null : this.toEvidenceRow(found);
  }

  async addEvidence(record: AddEvidenceRecord): Promise<EvidenceRow> {
    const list = this.evidences.get(record.eventId) ?? [];

    // 复刻 `@@unique([eventId, urlHash])`。
    if (list.some((evidence) => (evidence.urlHash ?? `hash-${evidence.evidenceId}`) === record.urlHash)) {
      throw new Error('Unique constraint failed on (eventId, urlHash)');
    }

    const seeded: SeedEvidence = {
      evidenceId: `ev-${list.length + 1}-${record.urlHash.slice(0, 6)}`,
      eventId: record.eventId,
      evidenceType: record.evidenceType,
      url: record.url,
      urlHash: record.urlHash,
      title: record.title,
      publishedAt: record.publishedAt === null ? null : record.publishedAt.toISOString(),
      isPrimary: false,
      contentId: record.contentId,
      sourceId: record.sourceId,
      source: null,
    };
    list.push(seeded);
    this.evidences.set(record.eventId, list);
    return this.toEvidenceRow(seeded);
  }

  async updateEvidence(record: UpdateEvidenceRecord): Promise<EvidenceRow | null> {
    const list = this.evidences.get(record.eventId) ?? [];
    const found = list.find((evidence) => evidence.evidenceId === record.evidenceId);
    if (found === undefined) return null;

    if (record.evidenceType !== undefined) found.evidenceType = record.evidenceType;
    if (record.title !== undefined) found.title = record.title;
    if (record.url !== undefined) found.url = record.url;
    if (record.urlHash !== undefined) found.urlHash = record.urlHash;

    return this.toEvidenceRow(found);
  }

  async deleteEvidence(eventId: string, evidenceId: string): Promise<boolean> {
    const list = this.evidences.get(eventId) ?? [];
    const index = list.findIndex((evidence) => evidence.evidenceId === evidenceId);
    if (index < 0) return false;
    list.splice(index, 1);
    return true;
  }

  async setPrimaryEvidence(
    eventId: string,
    evidenceId: string,
  ): Promise<{ primaryEvidenceId: string } | null> {
    const list = this.evidences.get(eventId) ?? [];
    if (!list.some((evidence) => evidence.evidenceId === evidenceId)) return null;

    // 复刻真实实现的**事务语义**：先清旧的、再设新的。
    for (const evidence of list) evidence.isPrimary = false;
    for (const evidence of list) {
      if (evidence.evidenceId === evidenceId) evidence.isPrimary = true;
    }
    return { primaryEvidenceId: evidenceId };
  }

  /** 某事件的 Primary 条数（不变量断言：必须 ≤ 1）。 */
  primaryCount(eventId: string): number {
    return (this.evidences.get(eventId) ?? []).filter((evidence) => evidence.isPrimary === true)
      .length;
  }

  /* ---------------- 通知 ---------------- */

  async findNotifiedKeys(type: string): Promise<Set<string>> {
    const keys = new Set<string>();
    for (const notification of this.notifications.values()) {
      if (notification.type !== type) continue;
      if (notification.targetUrl !== null) keys.add(notification.targetUrl);
    }
    return keys;
  }

  async createNotification(input: {
    type: string;
    title: string;
    body: string;
    targetUrl: string | null;
  }): Promise<string> {
    const id = String((this.nextNotificationId += 1));
    this.notifications.set(id, { type: input.type, targetUrl: input.targetUrl });
    return id;
  }

  async listHighScoreCandidates(
    minScore: number,
  ): Promise<
    { contentId: string; title: string; finalScore: number; recommendationReason: string | null }[]
  > {
    return [...this.contents.values()]
      .filter(
        (content) =>
          (content.finalScore ?? 0) >= minScore &&
          (content.reviewStatus ?? EditorialReviewStatus.PENDING) === EditorialReviewStatus.PENDING,
      )
      .map((content) => ({
        contentId: content.contentId,
        title: content.title ?? '标题',
        finalScore: content.finalScore ?? 0,
        recommendationReason: content.recommendationReason ?? null,
      }));
  }

  async listFailingSources(): Promise<
    { id: string; name: string; lastErrorCode: string; lastErrorAt: string | null }[]
  > {
    return this.failingSources;
  }

  /* ---------------- Dashboard ---------------- */

  async dashboardStats(): Promise<DashboardStats> {
    return this.dashboard;
  }
}
