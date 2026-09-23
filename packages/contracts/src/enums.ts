/**
 * Signal 公共枚举 — 唯一来源。
 *
 * 对应开发契约 `docs/05-enums-state-machines.md` v1.1 与 `reference/contracts.ts`。
 *
 * 规则（《Signal 多 Agent 执行规则 v1.0》§6）：
 *   - 本文件属于 Frozen Contract，只有 Agent 00 / 01 / 14 可以修改。
 *   - 严禁在 apps/** 或 packages/** 其他位置重新声明这些枚举的同义版本。
 *   - 需要新增枚举值时，提交 CONTRACT_CHANGE_REQUEST.md。
 */

/* ------------------------------------------------------------------ */
/* Identity / Auth                                                     */
/* ------------------------------------------------------------------ */

export enum UserRole {
  USER = 'USER',
  ADMIN = 'ADMIN',
}

export enum UserStatus {
  ACTIVE = 'ACTIVE',
  DISABLED = 'DISABLED',
}

/** user_preferences.theme */
export enum UserTheme {
  LIGHT = 'LIGHT',
  DARK = 'DARK',
  SYSTEM = 'SYSTEM',
}

/** user_preferences.article_font_size */
export enum ArticleFontSize {
  SMALL = 'SMALL',
  DEFAULT = 'DEFAULT',
  LARGE = 'LARGE',
}

/* ------------------------------------------------------------------ */
/* Source Registry                                                     */
/* ------------------------------------------------------------------ */

/**
 * SourceType — 「怎么采集」，决定使用哪个 Collector Adapter。
 * 这不是来源的业务身份，业务身份见 SourceKind。
 */
export enum SourceType {
  RSS = 'RSS',
  X_USER = 'X_USER',
  GITHUB_REPO = 'GITHUB_REPO',
  HACKER_NEWS = 'HACKER_NEWS',
  HUGGINGFACE = 'HUGGINGFACE',
  MANUAL_URL = 'MANUAL_URL',
}

/** SourceKind — 「这是谁」，来源的业务身份。 */
export enum SourceKind {
  OFFICIAL = 'OFFICIAL',
  PERSON = 'PERSON',
  MEDIA = 'MEDIA',
  COMMUNITY = 'COMMUNITY',
  DEVELOPER = 'DEVELOPER',
  GOVERNMENT = 'GOVERNMENT',
  TREND = 'TREND',
}

/**
 * SourceTier — 编辑配置的来源等级，不由 AI 自动改写。
 * S：官方 / 一手原始来源；A：高质量独立作者 / 核心开发者；
 * B：专业媒体 / 社区精选；C：普通二手来源 / 辅助线索。
 */
export enum SourceTier {
  S = 'S',
  A = 'A',
  B = 'B',
  C = 'C',
}

/* ------------------------------------------------------------------ */
/* Evidence                                                            */
/* ------------------------------------------------------------------ */

export enum EvidenceType {
  PRIMARY_SOURCE = 'PRIMARY_SOURCE',
  OFFICIAL_CONFIRMATION = 'OFFICIAL_CONFIRMATION',
  SUPPORTING_SOURCE = 'SUPPORTING_SOURCE',
  SOCIAL_CONFIRMATION = 'SOCIAL_CONFIRMATION',
  RELATED_DISCUSSION = 'RELATED_DISCUSSION',
}

/* ------------------------------------------------------------------ */
/* Content                                                             */
/* ------------------------------------------------------------------ */

export enum ContentType {
  ARTICLE = 'ARTICLE',
  X_POST = 'X_POST',
  GITHUB_REPO = 'GITHUB_REPO',
  GITHUB_RELEASE = 'GITHUB_RELEASE',
  HN_STORY = 'HN_STORY',
  MODEL = 'MODEL',
  SHORT_POST = 'SHORT_POST',
}

export enum RawItemStatus {
  FETCHED = 'FETCHED',
  NORMALIZED = 'NORMALIZED',
  DUPLICATE = 'DUPLICATE',
  READY_FOR_ANALYSIS = 'READY_FOR_ANALYSIS',
  FAILED = 'FAILED',
}

/**
 * ContentPipelineStatus — 内容处理状态机。
 * 注意：APPROVED 只代表审核通过，不代表已发布。
 */
export enum ContentPipelineStatus {
  INGESTED = 'INGESTED',
  ANALYZING = 'ANALYZING',
  REVIEW_PENDING = 'REVIEW_PENDING',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
  ARCHIVED = 'ARCHIVED',
}

export enum EditorialReviewStatus {
  PENDING = 'PENDING',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
  DEFERRED = 'DEFERRED',
}

/* ------------------------------------------------------------------ */
/* Publishing / Daily                                                  */
/* ------------------------------------------------------------------ */

export enum DailyEditionStatus {
  DRAFT = 'DRAFT',
  REVIEWING = 'REVIEWING',
  SCHEDULED = 'SCHEDULED',
  PUBLISHED = 'PUBLISHED',
  CANCELLED = 'CANCELLED',
}

export enum DailySectionType {
  FRONT_PAGE = 'FRONT_PAGE',
  AI = 'AI',
  PRODUCT = 'PRODUCT',
  DEVELOPMENT = 'DEVELOPMENT',
  TECH = 'TECH',
  X_VOICES = 'X_VOICES',
  BRIEFS = 'BRIEFS',
}

export enum DailyDisplayStyle {
  LEAD = 'LEAD',
  MAJOR = 'MAJOR',
  STANDARD = 'STANDARD',
  BRIEF = 'BRIEF',
}

/* ------------------------------------------------------------------ */
/* AI / Jobs                                                           */
/* ------------------------------------------------------------------ */

export enum AiTaskType {
  LANGUAGE_DETECT = 'LANGUAGE_DETECT',
  TRANSLATE = 'TRANSLATE',
  CLASSIFY = 'CLASSIFY',
  SCORE = 'SCORE',
  DEDUP_VERIFY = 'DEDUP_VERIFY',
  EVENT_CLUSTER = 'EVENT_CLUSTER',
  DAILY_DRAFT = 'DAILY_DRAFT',
}

export enum AiRunStatus {
  QUEUED = 'QUEUED',
  RUNNING = 'RUNNING',
  SUCCEEDED = 'SUCCEEDED',
  FAILED = 'FAILED',
  SKIPPED = 'SKIPPED',
}

export enum JobRunStatus {
  QUEUED = 'QUEUED',
  RUNNING = 'RUNNING',
  SUCCEEDED = 'SUCCEEDED',
  FAILED = 'FAILED',
  DEAD = 'DEAD',
}

/* ------------------------------------------------------------------ */
/* Runtime value lists                                                 */
/* 供校验层 / Admin 表单 / Prisma 映射使用，保证运行期与类型期一致。      */
/* ------------------------------------------------------------------ */

export const USER_ROLES = Object.values(UserRole);
export const USER_STATUSES = Object.values(UserStatus);
export const USER_THEMES = Object.values(UserTheme);
export const ARTICLE_FONT_SIZES = Object.values(ArticleFontSize);

export const SOURCE_TYPES = Object.values(SourceType);
export const SOURCE_KINDS = Object.values(SourceKind);
export const SOURCE_TIERS = Object.values(SourceTier);

export const EVIDENCE_TYPES = Object.values(EvidenceType);

export const CONTENT_TYPES = Object.values(ContentType);
export const RAW_ITEM_STATUSES = Object.values(RawItemStatus);
export const CONTENT_PIPELINE_STATUSES = Object.values(ContentPipelineStatus);
export const EDITORIAL_REVIEW_STATUSES = Object.values(EditorialReviewStatus);

export const DAILY_EDITION_STATUSES = Object.values(DailyEditionStatus);
export const DAILY_SECTION_TYPES = Object.values(DailySectionType);
export const DAILY_DISPLAY_STYLES = Object.values(DailyDisplayStyle);

export const AI_TASK_TYPES = Object.values(AiTaskType);
export const AI_RUN_STATUSES = Object.values(AiRunStatus);
export const JOB_RUN_STATUSES = Object.values(JobRunStatus);
