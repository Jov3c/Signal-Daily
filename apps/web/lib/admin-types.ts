/**
 * 后台用到的响应类型 —— 全部是**契约之外的模块内 DTO 的镜像**。
 *
 * ⚠ 这个文件的每一行都值得解释一次「为什么在这里而不在契约里」。
 *
 * `@signal/contracts` 只冻结了两类东西：**公共枚举**与**公开 DTO**
 *（`dto/public.ts`）。而后台响应形状是各模块自己的读模型 —— 它们散落在
 * `apps/api/src/modules/<模块>/repository.ts` 或 `dto/` 里。
 * 前端 import 不了 `apps/api`（跨 app 只能共享 `packages/*`，`docs/02`），
 * Agent 02 / 08 / 09 都提过把它们的 DTO 提到 contracts 的 CCR，尚未裁决。
 *
 * 于是只能镜像。**但镜像最怕的是静默漂移**（后端改了字段名、前端少显示一列，
 * 没有任何测试会红），所以：
 *
 * 1. 每个类型都注明**真源文件**；
 * 2. `apps/web/test/contract-parity.spec.ts` 从那些源文件里把**字段名**读出来
 *    与本文件比对 —— 改名就会红；
 * 3. 后端**新增**字段不会红（前端不读它而已），这是刻意的：
 *    把「后端加字段」也变成前端构建失败会让人不敢改后端。
 *
 * 日期一律是 **ISO 字符串**（不写 `Date`）：JSON 过去之后就不是 `Date` 了，
 * 写成 `Date` 会让调用方以为能直接 `.getTime()`，而那只在编译期成立。
 */

import type {
  AiRunStatus,
  AiTaskType,
  ContentPipelineStatus,
  ContentType,
  DailyDisplayStyle,
  DailyEditionStatus,
  DailySectionType,
  EditorialReviewStatus,
  EvidenceType,
  JobRunStatus,
  SourceKind,
  SourceTier,
  SourceType,
} from '@signal/contracts';

/* ------------------------------------------------------------------ */
/* 来源信息（后台各处复用的那一小块）                                   */
/* ------------------------------------------------------------------ */

/** 内容/证据上挂的来源摘要。真源：`admin-review/repository.ts`。 */
export type AdminSourceRef = {
  id: string;
  name: string;
  slug: string;
  type: SourceType;
  kind: SourceKind;
  tier: SourceTier;
  official: boolean;
};

/* ------------------------------------------------------------------ */
/* Dashboard                                                           */
/* ------------------------------------------------------------------ */

/** `GET /admin/dashboard`。真源：`admin-review/repository.ts` 的 `DashboardStats`。 */
export type DashboardStats = {
  todayFetched: number;
  highScorePending: number;
  pendingReview: number;
  failingSources: {
    id: string;
    name: string;
    lastErrorCode: string;
    lastErrorAt: string | null;
  }[];
  aiCostTodayUsd: number;
  latestDailyEdition: {
    id: string;
    businessDate: string;
    status: DailyEditionStatus;
  } | null;
};

/* ------------------------------------------------------------------ */
/* 审核                                                                */
/* ------------------------------------------------------------------ */

/** `GET /admin/review` 的一行。真源：`admin-review/repository.ts` 的 `ReviewListRow`。 */
export type ReviewListRow = {
  contentId: string;
  title: string;
  summary: string | null;
  finalScore: number | null;
  publishedAt: string | null;
  createdAt: string;
  pipelineStatus: ContentPipelineStatus;
  eventId: string | null;
  source: AdminSourceRef;
  review: {
    id: string;
    status: EditorialReviewStatus;
    publishFeatured: boolean;
    includeDailyCandidate: boolean;
    reviewedAt: string | null;
  };
};

/** 证据链上的一条。真源：`admin-review/repository.ts` 的 `EvidenceRow`。 */
export type AdminEvidence = {
  evidenceId: string;
  eventId: string;
  evidenceType: EvidenceType;
  title: string | null;
  url: string;
  /** `Char(64)` 的 sha256 十六进制小写 —— 后台用它显示去重指纹。 */
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

/**
 * `GET /admin/review/:contentId`。真源：`admin-review/review.service.ts` 的 `detail()`。
 *
 * ⚠ 这一份**必须**完整（`docs/09` 的「必须同时看到」清单）：原文/翻译、来源、
 * 六维分与理由、Event、Primary / Supporting Evidence、独立来源数、官方确认、
 * 相似内容。少一样就等于审核员要另开一个页面。
 */
export type ReviewDetail = {
  content: {
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
  };
  source: AdminSourceRef & { baseUrl: string | null };
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
    /** 分数档（`docs/08`）。`null` = 还没评分。 */
    band: string | null;
    recommendationReason: string | null;
    topics: string[];
    analysis: Record<string, unknown> | null;
  };
  event: {
    id: string;
    canonicalTitle: string;
    primaryContentId: string | null;
    isPrimaryContent: boolean;
    independentSourceCount: number;
    hasOfficialConfirmation: boolean;
    primaryEvidence: AdminEvidence | null;
    supportingEvidence: AdminEvidence[];
    relatedDiscussion: AdminEvidence[];
    contents: { contentId: string; title: string; sourceName: string; isPrimary: boolean }[];
  } | null;
  similarContents: {
    contentId: string;
    title: string;
    sourceName: string;
    /** 恒为 `null` —— 相似度算法在 worker 侧，后台不重算。 */
    similarity: number | null;
    sameSource: boolean;
    isEventPrimary: boolean;
  }[];
  review: {
    id: string;
    status: EditorialReviewStatus;
    publishFeatured: boolean;
    includeDailyCandidate: boolean;
    reviewedAt: string | null;
  } | null;
};

/* ------------------------------------------------------------------ */
/* Source 管理                                                         */
/* ------------------------------------------------------------------ */

/** `GET /admin/sources` 的一行。真源：`sources/dto/source.dto.ts` 的 `SourceDto`。 */
export type SourceDto = {
  id: string;
  name: string;
  slug: string;
  type: SourceType;
  kind: SourceKind;
  tier: SourceTier;
  official: boolean;
  baseUrl: string | null;
  feedUrl: string | null;
  externalId: string | null;
  language: string | null;
  priority: number;
  trustScore: number;
  fetchIntervalSeconds: number;
  enabled: boolean;
  config: Record<string, unknown> | null;
  lastFetchedAt: string | null;
  nextFetchAt: string | null;
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  lastErrorCode: string | null;
  createdAt: string;
  updatedAt: string;
};

/* ------------------------------------------------------------------ */
/* 日报编排                                                            */
/* ------------------------------------------------------------------ */

/**
 * `GET /admin/daily` 的一行。
 *
 * ⚠ **真源是 `DailyService.EditionSummary`**，不是 `daily/repository.ts` 的
 * `EditionRow` —— 2026-10-02 修。`EditionSummary = EditionRow & { editionNoLabel;
 * itemCount }`，**接口返回的是它**；指向 `EditionRow` 会漏掉那两个字段，
 * 而它们恰好是最容易漂移的部分。
 *
 * 原先这里有两处漂移（清单 P3-01）：
 *
 * ```text
 *   id            ← 后端是 `editionId`
 *   （缺）         ← 后端还有 `editionNoLabel`
 * ```
 *
 * 之所以没爆：后台日报页当前只读 `row.itemCount`。**改名不会让任何测试变红** ——
 * 直到有人开始读那个字段。现已纳入 `contract-parity.spec.ts`。
 */
export type AdminEditionRow = {
  editionId: string;
  businessDate: string;
  editionNo: number | null;
  /** 期号的人类可读形式（`NO.001`）；未发布时为 `null`。 */
  editionNoLabel: string | null;
  status: DailyEditionStatus;
  headline: string | null;
  scheduledAt: string | null;
  publishedAt: string | null;
  itemCount: number;
};

/* ------------------------------------------------------------------ */
/* 运维视图（Agent 12 新补的三组接口）                                  */
/* ------------------------------------------------------------------ */

/** `GET /admin/jobs`。真源：`admin-ops/repository.ts` 的 `AdminJobRun`。 */
export type AdminJobRun = {
  id: string;
  jobType: string;
  jobKey: string | null;
  status: JobRunStatus;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  attempts: number;
  errorCode: string | null;
  metadata: unknown;
};

/** `GET /admin/notifications`。真源：`admin-ops/repository.ts` 的 `AdminNotification`。 */
export type AdminNotification = {
  id: string;
  type: string;
  title: string;
  body: string;
  targetUrl: string | null;
  status: string;
  emailStatus: string;
  createdAt: string;
  readAt: string | null;
};

/** 用量汇总（总量 / 按 taskType / 按 model 共用这一形状）。 */
export type AiUsageRollup = {
  runs: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  failedRuns: number;
};

export type AiUsageGroupRow = AiUsageRollup & { key: string };
export type AiUsageDailyRow = AiUsageRollup & { businessDate: string };

/** `GET /admin/ai-usage`。真源：`admin-ops/service.ts` 的 `AiUsageView`。 */
export type AiUsageView = {
  window: { from: string; to: string; days: number; timezone: string };
  totals: AiUsageRollup;
  byTaskType: AiUsageGroupRow[];
  byModel: AiUsageGroupRow[];
  daily: AiUsageDailyRow[];
  recent: {
    id: string;
    contentId: string | null;
    taskType: AiTaskType;
    provider: string;
    model: string;
    promptVersion: string;
    status: AiRunStatus;
    inputTokens: number | null;
    outputTokens: number | null;
    estimatedCostUsd: number | null;
    durationMs: number | null;
    errorCode: string | null;
    createdAt: string;
  }[];
};

/* ------------------------------------------------------------------ */
/* 页面用得到的小工具                                                   */
/* ------------------------------------------------------------------ */

/** `AdminEditionRow`/`AdminDaily` 里版块的类型（后端 `DailySectionType`）。 */
export type { DailySectionType, DailyDisplayStyle };
