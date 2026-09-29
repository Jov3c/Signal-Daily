/**
 * `AdminReviewRepository` 的 Prisma 实现。
 *
 * ⚠ 本文件是审核后端**唯一**写 `editorial_reviews` / `event_evidence` /
 * `contents.pipeline_status` 的地方。它**从不写** `sources`（Source 归 Agent 03）、
 * 也不写 worker 侧的表（`raw_items` / `ai_runs` / `job_runs`）。
 */

import { Inject, Injectable } from '@nestjs/common';
import {
  EditorialReviewStatus as PrismaEditorialReviewStatus,
  ContentPipelineStatus as PrismaContentPipelineStatus,
  type Prisma,
} from '@prisma/client';
import {
  ContentPipelineStatus,
  ContentType,
  DailyEditionStatus,
  EvidenceType,
  EditorialReviewStatus,
  SourceKind,
  SourceTier,
  SourceType,
} from '@signal/contracts';
import { PrismaService } from '../../common/prisma/prisma.service';
import { toReviewId } from './bigint-id';
import { toContractEnum } from '../../common/prisma/prisma-enums';
import {
  ADMIN_REVIEW_REPOSITORY,
  type AddEvidenceRecord,
  type AdminReviewRepository,
  type ApplyBulkResult,
  type ApplyDecisionInput,
  type ApplyDecisionResult,
  type DashboardStats,
  type EventDetailRow,
  type EventEvidenceStats,
  type EvidenceRow,
  type ListReviewInput,
  type ReviewDetailContentRow,
  type ReviewListRow,
  type UpdateEvidenceRecord,
} from './repository';

/* ------------------------------------------------------------------ */
/* 枚举桥接（与 Agent 02 的 prisma-enums 同一取舍：显式表 + 缺键即编译错） */
/* ------------------------------------------------------------------ */

const REVIEW_STATUS_TO_PRISMA: Readonly<Record<EditorialReviewStatus, PrismaEditorialReviewStatus>> =
  {
    [EditorialReviewStatus.PENDING]: PrismaEditorialReviewStatus.PENDING,
    [EditorialReviewStatus.APPROVED]: PrismaEditorialReviewStatus.APPROVED,
    [EditorialReviewStatus.REJECTED]: PrismaEditorialReviewStatus.REJECTED,
    [EditorialReviewStatus.DEFERRED]: PrismaEditorialReviewStatus.DEFERRED,
  };

const PIPELINE_STATUS_TO_PRISMA: Readonly<
  Record<ContentPipelineStatus, PrismaContentPipelineStatus>
> = {
  [ContentPipelineStatus.INGESTED]: PrismaContentPipelineStatus.INGESTED,
  [ContentPipelineStatus.ANALYZING]: PrismaContentPipelineStatus.ANALYZING,
  [ContentPipelineStatus.REVIEW_PENDING]: PrismaContentPipelineStatus.REVIEW_PENDING,
  [ContentPipelineStatus.APPROVED]: PrismaContentPipelineStatus.APPROVED,
  [ContentPipelineStatus.REJECTED]: PrismaContentPipelineStatus.REJECTED,
  [ContentPipelineStatus.ARCHIVED]: PrismaContentPipelineStatus.ARCHIVED,
};

/** `editorial_reviews.viewed_at` 之类的空值统一序列化成 `null`。 */
const iso = (value: Date | null): string | null => (value === null ? null : value.toISOString());

/** `Prisma.Decimal` → `number`（`docs/02`：BIGINT 转 string，但 Decimal 是数值语义）。 */
const num = (value: Prisma.Decimal | null): number | null =>
  value === null ? null : Number(value);

@Injectable()
export class PrismaAdminReviewRepository implements AdminReviewRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /* ---------------------------------------------------------------- */
  /* 审核队列                                                          */
  /* ---------------------------------------------------------------- */

  async listReviews(input: ListReviewInput): Promise<{ rows: ReviewListRow[]; total: number }> {
    const status = input.status ?? EditorialReviewStatus.PENDING;

    // 畸形 / 超界的筛选 id **当作「查不到」**（返回空页），而不是构造一个
    // 非法的 Prisma filter（那会让整个请求 500）。与 Agent 03 的取舍一致。
    const sourceId = input.sourceId === undefined ? undefined : toReviewId(input.sourceId);
    if (sourceId === null) return { rows: [], total: 0 };
    const eventId = input.eventId === undefined ? undefined : toReviewId(input.eventId);
    if (eventId === null) return { rows: [], total: 0 };

    const where: Prisma.ContentWhereInput = {
      // 只列出**有审核行**的内容 —— 审核队列的来源是 `EditorialReview`，
      // 而不是「所有内容」。Agent 05 在收尾时创建那一行。
      review: { is: { status: REVIEW_STATUS_TO_PRISMA[status] } },
      ...(input.minScore === undefined ? {} : { finalScore: { gte: input.minScore } }),
      ...(sourceId === undefined ? {} : { sourceId }),
      ...(eventId === undefined ? {} : { eventId }),
    };

    const [rows, total] = await Promise.all([
      this.prisma.content.findMany({
        where,
        select: {
          id: true,
          title: true,
          summary: true,
          finalScore: true,
          publishedAt: true,
          createdAt: true,
          pipelineStatus: true,
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
          review: {
            select: {
              id: true,
              status: true,
              publishFeatured: true,
              includeDailyCandidate: true,
              reviewedAt: true,
            },
          },
        },
        // `docs/09`：默认 `finalScore DESC, publishedAt DESC`。
        // MySQL 的 NULL 在 DESC 下排最后 —— 未评分的候选因此落在列表底部，
        // 这正是我们要的（它们还轮不到人来审）。
        orderBy: [{ finalScore: 'desc' }, { publishedAt: 'desc' }],
        skip: (input.page - 1) * input.pageSize,
        take: input.pageSize,
      }),
      this.prisma.content.count({ where }),
    ]);

    return {
      rows: rows.map((row) => ({
        contentId: String(row.id),
        title: row.title,
        summary: row.summary,
        finalScore: num(row.finalScore),
        publishedAt: iso(row.publishedAt),
        createdAt: row.createdAt.toISOString(),
        pipelineStatus: toContractEnum(
          Object.values(ContentPipelineStatus) as ContentPipelineStatus[],
          row.pipelineStatus,
          'ContentPipelineStatus',
        ),
        eventId: row.eventId === null ? null : String(row.eventId),
        source: {
          id: String(row.source.id),
          name: row.source.name,
          slug: row.source.slug,
          type: toContractEnum(
            Object.values(SourceType) as SourceType[],
            row.source.type,
            'SourceType',
          ),
          kind: toContractEnum(
            Object.values(SourceKind) as SourceKind[],
            row.source.kind,
            'SourceKind',
          ),
          tier: toContractEnum(
            Object.values(SourceTier) as SourceTier[],
            row.source.tier,
            'SourceTier',
          ),
          official: row.source.official,
        },
        review: {
          id: String(row.review!.id),
          status: toContractEnum(
            Object.values(EditorialReviewStatus) as EditorialReviewStatus[],
            row.review!.status,
            'EditorialReviewStatus',
          ),
          publishFeatured: row.review!.publishFeatured,
          includeDailyCandidate: row.review!.includeDailyCandidate,
          reviewedAt: iso(row.review!.reviewedAt),
        },
      })),
      total,
    };
  }

  async eventEvidenceStats(eventIds: readonly string[]): Promise<Map<string, EventEvidenceStats>> {
    const ids = eventIds
      .map(toReviewId)
      .filter((id): id is bigint => id !== null);
    if (ids.length === 0) return new Map();

    // **一次查完整页事件的证据**，而不是每行一次 —— 否则列表页会有 N+1。
    const rows = await this.prisma.eventEvidence.findMany({
      where: { eventId: { in: ids } },
      select: {
        eventId: true,
        sourceId: true,
        evidenceType: true,
        source: { select: { official: true } },
      },
    });

    const byEvent = new Map<string, EventEvidenceStats>();
    const sourcesSeen = new Map<string, Set<string>>();

    for (const eventId of ids) {
      const key = String(eventId);
      byEvent.set(key, { eventId: key, independentSourceCount: 0, hasOfficialConfirmation: false });
      sourcesSeen.set(key, new Set());
    }

    for (const row of rows) {
      const key = String(row.eventId);
      const stats = byEvent.get(key);
      if (stats === undefined) continue;

      // `distinct source_id`：同源多条只算 1（`docs/06` 的核心口径）。
      // `sourceId` 为 null 的不计入 —— 否则删掉 Source 反而让数字虚高。
      if (row.sourceId !== null) sourcesSeen.get(key)!.add(String(row.sourceId));

      if (row.evidenceType === EvidenceType.OFFICIAL_CONFIRMATION) {
        stats.hasOfficialConfirmation = true;
      } else if (
        row.evidenceType === EvidenceType.PRIMARY_SOURCE &&
        row.source?.official === true
      ) {
        stats.hasOfficialConfirmation = true;
      }
    }

    for (const [key, seen] of sourcesSeen) {
      byEvent.get(key)!.independentSourceCount = seen.size;
    }

    return byEvent;
  }

  /* ---------------------------------------------------------------- */
  /* 详情                                                              */
  /* ---------------------------------------------------------------- */

  async findReviewByContentId(contentId: string) {
    const id = toReviewId(contentId);
    if (id === null) return null;

    const row = await this.prisma.editorialReview.findUnique({
      where: { contentId: id },
      select: {
        id: true,
        status: true,
        publishFeatured: true,
        includeDailyCandidate: true,
        adminNote: true,
        reviewedByUserId: true,
        reviewedAt: true,
        createdAt: true,
      },
    });
    if (row === null) return null;

    return {
      id: String(row.id),
      status: toContractEnum(
        Object.values(EditorialReviewStatus) as EditorialReviewStatus[],
        row.status,
        'EditorialReviewStatus',
      ),
      publishFeatured: row.publishFeatured,
      includeDailyCandidate: row.includeDailyCandidate,
      adminNote: row.adminNote,
      reviewedByUserId: row.reviewedByUserId === null ? null : String(row.reviewedByUserId),
      reviewedAt: iso(row.reviewedAt),
      createdAt: row.createdAt.toISOString(),
    };
  }

  async findReviewDetailContent(contentId: string): Promise<ReviewDetailContentRow | null> {
    const id = toReviewId(contentId);
    if (id === null) return null;

    const row = await this.prisma.content.findUnique({
      where: { id },
      select: {
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
        createdAt: true,
        pipelineStatus: true,
        importanceScore: true,
        relevanceScore: true,
        credibilityScore: true,
        noveltyScore: true,
        densityScore: true,
        readValueScore: true,
        finalScore: true,
        recommendationReason: true,
        aiAnalysis: true,
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
            baseUrl: true,
          },
        },
      },
    });
    if (row === null) return null;

    return {
      id: String(row.id),
      type: toContractEnum(
        Object.values(ContentType) as ContentType[],
        row.type,
        'ContentType',
      ),
      title: row.title,
      summary: row.summary,
      bodyOriginal: row.bodyOriginal,
      bodyTranslated: row.bodyTranslated,
      language: row.language,
      originalUrl: row.originalUrl,
      imageUrl: row.imageUrl,
      publishedAt: iso(row.publishedAt),
      createdAt: row.createdAt.toISOString(),
      pipelineStatus: toContractEnum(
        Object.values(ContentPipelineStatus) as ContentPipelineStatus[],
        row.pipelineStatus,
        'ContentPipelineStatus',
      ),
      scores: {
        importance: num(row.importanceScore),
        relevance: num(row.relevanceScore),
        credibility: num(row.credibilityScore),
        novelty: num(row.noveltyScore),
        density: num(row.densityScore),
        readValue: num(row.readValueScore),
        finalScore: num(row.finalScore),
      },
      recommendationReason: row.recommendationReason,
      aiAnalysisScore: extractScoreSection(row.aiAnalysis),
      eventId: row.eventId === null ? null : String(row.eventId),
      source: {
        id: String(row.source.id),
        name: row.source.name,
        slug: row.source.slug,
        type: toContractEnum(Object.values(SourceType) as SourceType[], row.source.type, 'SourceType'),
        kind: toContractEnum(Object.values(SourceKind) as SourceKind[], row.source.kind, 'SourceKind'),
        tier: toContractEnum(Object.values(SourceTier) as SourceTier[], row.source.tier, 'SourceTier'),
        official: row.source.official,
        baseUrl: row.source.baseUrl,
      },
    };
  }

  async findEventDetail(eventId: string): Promise<EventDetailRow | null> {
    const id = toReviewId(eventId);
    if (id === null) return null;

    const event = await this.prisma.event.findUnique({
      where: { id },
      select: {
        id: true,
        canonicalTitle: true,
        primaryContentId: true,
        contents: {
          select: {
            id: true,
            title: true,
            source: { select: { name: true } },
          },
          orderBy: { id: 'asc' },
        },
        evidences: {
          select: {
            id: true,
            eventId: true,
            evidenceType: true,
            title: true,
            url: true,
            urlHash: true,
            publishedAt: true,
            isPrimary: true,
            contentId: true,
            sourceId: true,
            source: { select: { id: true, name: true, kind: true, tier: true, official: true } },
          },
          orderBy: [{ isPrimary: 'desc' }, { id: 'asc' }],
        },
      },
    });
    if (event === null) return null;

    const primaryContentId =
      event.primaryContentId === null ? null : String(event.primaryContentId);

    return {
      eventId: String(event.id),
      canonicalTitle: event.canonicalTitle,
      primaryContentId,
      contents: event.contents.map((content) => ({
        contentId: String(content.id),
        title: content.title,
        sourceName: content.source.name,
        isPrimary: primaryContentId !== null && String(content.id) === primaryContentId,
      })),
      evidences: event.evidences.map((evidence) => this.toEvidenceRow(evidence)),
    };
  }

  /** 把一条 Prisma 证据行收敛成端口形状。 */
  private toEvidenceRow(row: {
    id: bigint;
    eventId: bigint;
    evidenceType: string;
    title: string | null;
    url: string;
    urlHash: string;
    publishedAt: Date | null;
    isPrimary: boolean;
    contentId: bigint | null;
    sourceId: bigint | null;
    source: { id: bigint; name: string; kind: string; tier: string; official: boolean } | null;
  }): EvidenceRow {
    return {
      evidenceId: String(row.id),
      eventId: String(row.eventId),
      evidenceType: toContractEnum(
        Object.values(EvidenceType) as EvidenceType[],
        row.evidenceType,
        'EvidenceType',
      ),
      title: row.title,
      url: row.url,
      urlHash: row.urlHash,
      publishedAt: iso(row.publishedAt),
      isPrimary: row.isPrimary,
      contentId: row.contentId === null ? null : String(row.contentId),
      sourceId: row.sourceId === null ? null : String(row.sourceId),
      source:
        row.source === null
          ? null
          : {
              id: String(row.source.id),
              name: row.source.name,
              kind: toContractEnum(
                Object.values(SourceKind) as SourceKind[],
                row.source.kind,
                'SourceKind',
              ),
              tier: toContractEnum(
                Object.values(SourceTier) as SourceTier[],
                row.source.tier,
                'SourceTier',
              ),
              official: row.source.official,
            },
    };
  }

  /* ---------------------------------------------------------------- */
  /* 决策                                                              */
  /* ---------------------------------------------------------------- */

  async applyDecision(input: ApplyDecisionInput): Promise<ApplyDecisionResult | null> {
    const contentId = toReviewId(input.contentId);
    if (contentId === null) return null;

    return this.prisma.$transaction(async (tx) => {
      const review = await tx.editorialReview.findUnique({
        where: { contentId },
        select: { id: true },
      });
      // 审核行由 Agent 05 创建；本模块不代它创建。
      if (review === null) return null;

      await tx.editorialReview.update({
        where: { contentId },
        data: {
          status: REVIEW_STATUS_TO_PRISMA[input.reviewStatus],
          publishFeatured: input.publishFeatured,
          includeDailyCandidate: input.includeDailyCandidate,
          adminNote: input.adminNote,
          reviewedByUserId: toReviewId(input.reviewedByUserId),
          reviewedAt: input.reviewedAt,
        },
        select: { id: true },
      });

      // 同一事务里推进内容状态 —— 分开写会出现「审核已通过但内容还停在待审」。
      await tx.content.update({
        where: { id: contentId },
        data: { pipelineStatus: PIPELINE_STATUS_TO_PRISMA[input.pipelineStatus] },
        select: { id: true },
      });

      return {
        reviewId: String(review.id),
        reviewStatus: input.reviewStatus,
        pipelineStatus: input.pipelineStatus,
        publishFeatured: input.publishFeatured,
        includeDailyCandidate: input.includeDailyCandidate,
        reviewedAt: input.reviewedAt.toISOString(),
      };
    });
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
        // 批量**不允许**改精选/日报意图（`docs/09`：批量只允许 Reject/Defer）——
        // 两个布尔位保持 false，不清空管理员此前对单条的设置。
        publishFeatured: false,
        includeDailyCandidate: false,
        adminNote: input.adminNote,
        reviewedByUserId: input.reviewedByUserId,
        reviewedAt: input.reviewedAt,
      });

      if (result === null) {
        // ⚠ **不静默跳过**：管理员必须知道哪几条没生效。
        skipped.push({ contentId, reason: 'content or review not found' });
        continue;
      }
      updated += 1;
    }

    return { updated, skipped };
  }

  /* ---------------------------------------------------------------- */
  /* Evidence                                                          */
  /* ---------------------------------------------------------------- */

  async findEvidence(eventId: string, evidenceId: string): Promise<EvidenceRow | null> {
    const event = toReviewId(eventId);
    const evidence = toReviewId(evidenceId);
    if (event === null || evidence === null) return null;

    const row = await this.prisma.eventEvidence.findFirst({
      where: { id: evidence, eventId: event },
      select: {
        id: true,
        eventId: true,
        evidenceType: true,
        title: true,
        url: true,
        urlHash: true,
        publishedAt: true,
        isPrimary: true,
        contentId: true,
        sourceId: true,
        source: { select: { id: true, name: true, kind: true, tier: true, official: true } },
      },
    });
    return row === null ? null : this.toEvidenceRow(row);
  }

  async addEvidence(record: AddEvidenceRecord): Promise<EvidenceRow> {
    const eventId = toReviewId(record.eventId);
    if (eventId === null) throw new Error(`Non-bindable eventId: ${record.eventId}`);

    const created = await this.prisma.eventEvidence.create({
      data: {
        eventId,
        contentId: record.contentId === null ? null : toReviewId(record.contentId),
        sourceId: record.sourceId === null ? null : toReviewId(record.sourceId),
        evidenceType: record.evidenceType as never,
        title: record.title,
        url: record.url,
        urlHash: record.urlHash,
        publishedAt: record.publishedAt,
        isPrimary: false,
      },
      select: {
        id: true,
        eventId: true,
        evidenceType: true,
        title: true,
        url: true,
        urlHash: true,
        publishedAt: true,
        isPrimary: true,
        contentId: true,
        sourceId: true,
        source: { select: { id: true, name: true, kind: true, tier: true, official: true } },
      },
    });
    return this.toEvidenceRow(created);
  }

  async updateEvidence(record: UpdateEvidenceRecord): Promise<EvidenceRow | null> {
    const eventId = toReviewId(record.eventId);
    const evidenceId = toReviewId(record.evidenceId);
    if (eventId === null || evidenceId === null) return null;

    // `updateMany` + 影响行数：把「不属于该事件」也当作不存在（404），
    // 而不是靠先查后改之间可能被并发改掉的窗口。
    const affected = await this.prisma.eventEvidence.updateMany({
      where: { id: evidenceId, eventId },
      data: {
        ...(record.evidenceType === undefined ? {} : { evidenceType: record.evidenceType as never }),
        ...(record.title === undefined ? {} : { title: record.title }),
        ...(record.url === undefined ? {} : { url: record.url }),
        ...(record.urlHash === undefined ? {} : { urlHash: record.urlHash }),
      },
    });
    if (affected.count === 0) return null;

    return this.findEvidence(record.eventId, record.evidenceId);
  }

  async deleteEvidence(eventId: string, evidenceId: string): Promise<boolean> {
    const event = toReviewId(eventId);
    const evidence = toReviewId(evidenceId);
    if (event === null || evidence === null) return false;

    const result = await this.prisma.eventEvidence.deleteMany({
      where: { id: evidence, eventId: event },
    });
    return result.count > 0;
  }

  async setPrimaryEvidence(
    eventId: string,
    evidenceId: string,
  ): Promise<{ primaryEvidenceId: string } | null> {
    const event = toReviewId(eventId);
    const evidence = toReviewId(evidenceId);
    if (event === null || evidence === null) return null;

    return this.prisma.$transaction(async (tx) => {
      // 先确认这条证据属于该事件 —— 不属于就当作不存在（404），
      // 且**在事务内**确认，避免中间被别人删掉。
      const target = await tx.eventEvidence.findFirst({
        where: { id: evidence, eventId: event },
        select: { id: true },
      });
      if (target === null) return null;

      // ⚠ 顺序是「先清旧的、再设新的」，且两步同一事务 ——
      // `docs/03` 明确「一个事件最多一个 Primary」**DB 层不强制**。
      // 反过来的话，中间态会出现两个 Primary。
      await tx.eventEvidence.updateMany({
        where: { eventId: event, isPrimary: true },
        data: { isPrimary: false },
      });
      await tx.eventEvidence.updateMany({
        where: { id: evidence, eventId: event },
        data: { isPrimary: true },
      });

      return { primaryEvidenceId: String(evidence) };
    });
  }

  /* ---------------------------------------------------------------- */
  /* 管理员通知                                                        */
  /* ---------------------------------------------------------------- */

  async findNotifiedKeys(type: string): Promise<Set<string>> {
    const rows = await this.prisma.adminNotification.findMany({
      where: { type },
      select: { targetUrl: true },
    });
    return new Set(
      rows.map((row) => row.targetUrl).filter((url): url is string => url !== null),
    );
  }

  async createNotification(input: {
    type: string;
    title: string;
    body: string;
    targetUrl: string | null;
  }): Promise<string> {
    const row = await this.prisma.adminNotification.create({
      data: {
        type: input.type,
        title: clampChars(input.title, 255),
        body: input.body,
        targetUrl: input.targetUrl === null ? null : clampChars(input.targetUrl, 2048),
        status: 'UNREAD',
        // 邮件由 worker 消费 `notification.admin-email` 时更新 ——
        // 本模块只负责落库与入队，不在请求路径里发信。
        emailStatus: 'NONE',
      },
      select: { id: true },
    });
    return String(row.id);
  }

  async listHighScoreCandidates(minScore: number): Promise<
    { contentId: string; title: string; finalScore: number; recommendationReason: string | null }[]
  > {
    const rows = await this.prisma.content.findMany({
      where: {
        finalScore: { gte: minScore },
        // 只看**仍在待审**的：已经审过的内容再通知一次没有意义。
        review: { is: { status: PrismaEditorialReviewStatus.PENDING } },
      },
      select: {
        id: true,
        title: true,
        finalScore: true,
        recommendationReason: true,
      },
      orderBy: { finalScore: 'desc' },
      // 上限：一次扫描最多处理这么多条，避免积压时一次拉爆。
      take: 100,
    });

    return rows.map((row) => ({
      contentId: String(row.id),
      title: row.title,
      finalScore: num(row.finalScore) ?? 0,
      recommendationReason: row.recommendationReason,
    }));
  }

  async listFailingSources(): Promise<
    { id: string; name: string; lastErrorCode: string; lastErrorAt: string | null }[]
  > {
    const rows = await this.prisma.source.findMany({
      where: { lastErrorCode: { not: null } },
      select: { id: true, name: true, lastErrorCode: true, lastErrorAt: true },
      orderBy: { lastErrorAt: 'desc' },
      take: 100,
    });

    return rows.map((row) => ({
      id: String(row.id),
      name: row.name,
      lastErrorCode: row.lastErrorCode ?? '',
      lastErrorAt: iso(row.lastErrorAt),
    }));
  }

  /* ---------------------------------------------------------------- */
  /* Dashboard                                                         */
  /* ---------------------------------------------------------------- */

  async dashboardStats(input: {
    businessDayStartUtc: Date;
    businessDayEndUtc: Date;
  }): Promise<DashboardStats> {
    const dayWindow = { gte: input.businessDayStartUtc, lt: input.businessDayEndUtc };

    const [todayFetched, highScorePending, pendingReview, failing, aiCost, edition] =
      await Promise.all([
        this.prisma.rawItem.count({ where: { fetchedAt: dayWindow } }),
        this.prisma.content.count({
          where: {
            finalScore: { gte: 85 },
            review: { is: { status: PrismaEditorialReviewStatus.PENDING } },
          },
        }),
        this.prisma.editorialReview.count({
          where: { status: PrismaEditorialReviewStatus.PENDING },
        }),
        this.prisma.source.findMany({
          where: { lastErrorCode: { not: null } },
          select: { id: true, name: true, lastErrorCode: true, lastErrorAt: true },
          orderBy: { lastErrorAt: 'desc' },
          take: 20,
        }),
        this.prisma.aiRun.aggregate({
          where: { createdAt: dayWindow },
          _sum: { estimatedCostUsd: true },
        }),
        this.prisma.dailyEdition.findFirst({
          orderBy: { businessDate: 'desc' },
          select: { id: true, businessDate: true, status: true },
        }),
      ]);

    const total = aiCost._sum.estimatedCostUsd;

    return {
      todayFetched,
      highScorePending,
      pendingReview,
      failingSources: failing.map((source) => ({
        id: String(source.id),
        name: source.name,
        lastErrorCode: source.lastErrorCode ?? '',
        lastErrorAt: iso(source.lastErrorAt),
      })),
      aiCostTodayUsd: total === null ? 0 : Number(total),
      latestDailyEdition:
        edition === null
          ? null
          : {
              id: String(edition.id),
              // `businessDate` 是 `@db.Date`，Prisma 给的是 UTC 午夜的 `Date`；
              // 直接取 ISO 的前 10 位就是业务日，不要做时区换算。
              businessDate: edition.businessDate.toISOString().slice(0, 10),
              status: toContractEnum(
                Object.values(DailyEditionStatus) as DailyEditionStatus[],
                edition.status,
                'DailyEditionStatus',
              ),
            },
    };
  }
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

/** 从 `contents.ai_analysis` 里取 `score` 分区（Agent 06 定义的结构）。 */
/**
 * 按**字符**截断（对齐 `VarChar` 的语义 —— MySQL 的 `VarChar(n)` 数的是字符）。
 *
 * 只接受非 null 输入：调用方自己决定 null 怎么处理（见 `createNotification`
 * 里 `targetUrl` 的三元）。让它在 null 上返回 null 会让每个调用点都得再判一次类型。
 */
function clampChars(value: string, max: number): string {
  const codePoints = Array.from(value);
  return codePoints.length <= max ? value : codePoints.slice(0, max).join('');
}

function extractScoreSection(value: Prisma.JsonValue | null): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const score = (value as Record<string, unknown>)['score'];
  if (typeof score !== 'object' || score === null || Array.isArray(score)) return null;
  return score as Record<string, unknown>;
}

/** 供测试与模块装配使用。 */
export { ADMIN_REVIEW_REPOSITORY };
