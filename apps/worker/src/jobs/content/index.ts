/**
 * Agent 05 — Content Pipeline / Event / Evidence 的公开面。
 *
 * 下游（Agent 07 / 08 / 10 / 14）只应从本文件 import，不要深入子目录 ——
 * 子目录里的文件是实现细节，改动不受兼容性约束。
 */

/* 服务与装配 */
export { ContentService, CONTENT_LOGGER, RawItemNotFoundError } from './content.service';
export type { NormalizeOutcome } from './content.service';
export { ContentPipelineModule } from './module';

/* 队列与入队 */
export {
  BULLMQ_JOBID_MIN_SEGMENTS,
  CONTENT_PIPELINE_JOB_OPTIONS,
  CONTENT_PIPELINE_RETRY,
  NORMALIZER_VERSION,
  assertContentQueueContract,
  isContractNormalizeJobIdUsable,
  isBullMqAcceptableJobId,
  normalizeJobId,
  type ContentNormalizeJobData,
} from './queue';
export {
  CONTENT_PIPELINE_JOB_NAME,
  CONTENT_PIPELINE_QUEUE_NAME,
  QUEUE_CONCURRENCY_FOR_CONTENT_PIPELINE,
} from './queue-names';
export { CONTENT_QUEUE_CONNECTION, parseRedisConnection } from './connection';
export {
  ContentPipelineWorker,
  isContentPipelineJob,
  rawItemIdOfJobData,
  shouldStopRetrying,
  type ContentJobLike,
} from './content.worker';

/* docs/13 的 Dead Letter */
// ⚠ P3-02：与 `jobs/ai/index.ts` 对齐 —— 两个**值**导出改用模块限定名，
// 消除「同一个文件同时 import 两个 barrel 会撞名」的隐患（理由详见那边）。
// 仓库内没有调用方用过裸名；`module.ts` 自己是从 `./job-run.repository` 取的。
export {
  JOB_RUN_RECORDER as CONTENT_JOB_RUN_RECORDER,
  NoopJobRunRecorder as ContentNoopJobRunRecorder,
  type JobRunRecorder,
  type RecordJobRunInput,
} from './job-run.repository';

/* Normalize 的纯函数（下游要复用同一套判断时用） */
export {
  CONTENT_LANGUAGE_FALLBACK,
  CONTENT_TITLE_MAX_CHARS,
  CONTENT_URL_MAX_CHARS,
  normalizeRawItem,
  type NormalizeInput,
  type NormalizeResult,
  type NormalizedContent,
} from './normalize/normalize';
export { deriveContentType } from './normalize/content-type';

/* HTML 层（Agent 07 的审核页若自己渲染正文，必须用同一套清洗） */
export {
  MAX_SANITIZE_INPUT_CHARS,
  hasSubstantiveContent,
  sanitizeArticleHtml,
} from './html/sanitize';
export { MAX_PLAIN_TEXT_CHARS, htmlToPlainText } from './html/plain-text';
export { extractArticleBody, type ExtractionResult } from './html/extract';

/* 持久化端口（下游要 override 时用） */
export {
  CONTENT_REPOSITORY,
  type ContentRepository,
  type NewContent,
  type PersistOutcome,
  type RawItemWithSource,
} from './ports';
export { MAX_BINDABLE_BIGINT, toBindableId } from './bigint-id';
