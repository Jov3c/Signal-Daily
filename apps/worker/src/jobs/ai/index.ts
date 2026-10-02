/**
 * Agent 06 — AI Provider / 翻译 / 分类 / 评分的公开面。
 *
 * 下游（Agent 05 / 07 / 08 / 14）只应从本文件 import，不要深入子目录 ——
 * 子目录里的文件是实现细节，改动不受兼容性约束。
 */

/* 服务与装配 */
export { AiService, AI_LOGGER, type AiTaskOutcome } from './ai.service';
export { AiWorkerModule } from './module';

/* 队列 */
export {
  AI_JOB_OPTIONS,
  assertEnqueueOptions,
  assertQueueMapping,
  BULLMQ_JOBID_MIN_SEGMENTS,
  classifyScoreJobId,
  isBullMqAcceptableJobId,
  TASK_TO_JOB_NAME,
  translateJobId,
  type AiClassifyScoreJobData,
  type AiJobData,
  type AiTranslateJobData,
} from './queue';
export { AI_QUEUE_NAME, QUEUE_CONCURRENCY_FOR_AI } from './queue-names';
export { AI_QUEUE_CONNECTION, parseRedisConnection } from './connection';
export {
  AiQueueWorker,
  retryDecision,
  shouldStopRetrying,
  failureKindOf,
  contentIdOfJobData,
  taskTypeOfJobName,
  type AiJobLike,
  type RetryDecision,
} from './ai.worker';

/* docs/13 的 Dead Letter：最终失败写 job_runs = DEAD */
// ⚠ P3-02：这里的两个**值**导出改用模块限定名（`AI_` / `Ai` 前缀）。
// 原来叫裸的 `JOB_RUN_RECORDER` / `NoopJobRunRecorder`，与
// `jobs/content/index.ts` 的同名导出**撞名** —— 一个文件同时从两个 barrel
// import 就必须 `as` 重命名，而两个名字绑的是**不同的实现**，重命名极易看错。
// 本仓库已有的约定就是限定名（见 `jobs/publishing` 的
// `PUBLISHING_JOB_RUN_RECORDER`），这里向它对齐。
// 仓库内没有任何调用方用过裸名（它们都从 `./job-run.repository` 直接 import），
// 所以这是一次零破坏的改名。
// `JobRunRecorder` / `RecordJobRunInput` 两个**类型**保持原名：它们是刻意被
// `jobs/publishing` 复用的端口形状，不是各模块不同的实现。
export {
  JOB_RUN_RECORDER as AI_JOB_RUN_RECORDER,
  NoopJobRunRecorder as AiNoopJobRunRecorder,
  type JobRunRecorder,
  type RecordJobRunInput,
} from './job-run.repository';

/* 配置与错误 */
export {
  AI_CONFIG,
  DEFAULT_AI_REQUEST_TIMEOUT_MS,
  createAiConfig,
  missingAiConfig,
  modelFor,
  type AiConfig,
} from './ai.config';
export {
  AiError,
  isAiError,
  retryPolicyFor,
  aiBudgetExceededError,
  aiContentNotFoundError,
  aiNotConfiguredError,
  aiTaskNotImplementedError,
  aiTaskUnsupportedError,
  aiTransientError,
  aiUnauthorizedError,
} from './ai.errors';
export type { AiFailureKind, AiModelTier, AiCompletionResult } from './ai.types';
export {
  AI_MODEL_TIERS,
  CRITICAL_TASKS,
  TASK_MODEL_TIER,
  TASK_TEMPERATURE,
  isCriticalTask,
} from './ai.types';

/* 评分（Agent 07 审核列表的排序/筛选要用档位） */
export {
  SCORE_BANDS,
  SCORE_BAND_THRESHOLDS,
  SCORE_DIMENSIONS,
  SCORE_WEIGHTS,
  clampScore,
  computeFinalScore,
  isHighPriority,
  quantizeScore,
  scoreBand,
  scoreContent,
  toContentScoreUpdate,
  type DimensionScores,
  type ScoreBand,
  type ScoreResult,
} from './scoring';

/* Evidence 上下文（Agent 07 的 Review Detail 要用同一套口径） */
export {
  buildEvidenceContext,
  toPromptJson,
  type EvidenceContext,
  type EvidenceContextResult,
  type EvidenceProjection,
  type SourceIdentity,
} from './evidence-context';

/* 预算（运维 / 健康检查） */
export {
  AI_BUDGET_EXCEEDED_RATIO,
  AI_BUDGET_WARNING_RATIO,
  AiBudgetGuard,
  AI_SPEND_REPOSITORY,
  type AiBudgetSnapshot,
  type AiBudgetState,
  type AiSpendRepository,
  type AiSpendSummary,
} from './budget';

/* 持久化端口（下游要 override 时用） */
export { AI_REPOSITORY, type AiRepository, type AiContentRecord } from './ai-run.repository';

/* Provider 端口（下游要替换实现时用） */
export { AI_PROVIDER, type AiProvider, type AiCompletionRequest } from './provider/provider';

/* 安全（Agent 08 的 Daily Draft 复用同一套隔离） */
export {
  UNTRUSTED_DATA_NOTICE,
  UNTRUSTED_SENTINEL_CLOSE,
  UNTRUSTED_SENTINEL_OPEN,
  countOccurrences,
  isStrippedChar,
  neutralizeAngleBrackets,
  normalizeForModelView,
  sanitizeSingleLineLabel,
  sanitizeUntrustedText,
  stripInvisibleChars,
  truncateAtCodePointBoundary,
  wrapUntrusted,
} from './untrusted';

/* Prompt Registry（下游要看版本与是否已实现） */
export {
  PROMPT_REGISTRY,
  implementedTasks,
  isTaskImplemented,
  promptFor,
} from './prompts/registry';

/* 结构化输出 */
export { parseStructuredOutput } from './schema/validate';
export { normalizeLanguageCode, isValidLanguageCode } from './schema/language';
export { TRANSLATED_TEXT_MAX_CHARS } from './schema/translate.schema';

/* ai_analysis 的分区结构（Agent 07 的审核页按这个读） */
export { ANALYSIS_SECTIONS, type AnalysisSection } from './prisma-ai-run.repository';
