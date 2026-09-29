/**
 * Agent 08 — 日报发布（Publishing）的公开面。
 *
 * 下游（Agent 14、以及任何要复用发布逻辑的模块）只应从本文件 import，
 * 不要深入子目录 —— 子目录里的文件是实现细节。
 */

/* 模块与服务 */
export { PublishingModule } from './module';
export {
  PublishingService,
  PUBLISHING_LOGGER,
  CANDIDATE_LIMIT,
  candidateWindow,
  dailyAdminUrl,
  type GenerateDraftResult,
  type InitDraftResult,
  type PublishOutcome,
  type ReminderOutcome,
} from './publishing.service';

/* 队列：JobId / 槽位 / 入队选项 */
export {
  BULLMQ_JOBID_SEGMENTS,
  PUBLISHING_JOB_OPTIONS,
  PUBLISHING_RETRY_POLICY,
  PUBLISHING_SLOT,
  PUBLISHING_SLOTS_IN_ORDER,
  SLOT_JOB_NAME,
  SLOT_TIME,
  assertPublishingQueueContract,
  dailyDraftJobId,
  publishingQueueProblems,
  dailyPublishJobId,
  isBullMqAcceptableJobId,
  isPublishingJobData,
  type PublishingJobData,
  type PublishingQueueChecks,
  type PublishingSlot,
} from './queue';
export { PUBLISHING_QUEUE_NAME, QUEUE_CONCURRENCY_FOR_PUBLISHING } from './queue-names';

/* 调度器（Agent 14 若要调整 tick 间隔，从这里拿常量） */
export {
  PUBLISHING_ENQUEUER,
  SCHEDULER_TICK_INTERVAL_MS,
  PublishingScheduler,
  slotKey,
  type PublishingEnqueuer,
  type SlotOutcome,
  type TickResult,
} from './scheduler';
export {
  PUBLISHING_QUEUE,
  PUBLISHING_QUEUE_CONNECTION,
  BullPublishingEnqueuer,
  publishingConnectionOptions,
} from './enqueuer';

/* 消费者（测试要构造它） */
export {
  PublishingQueueWorker,
  isPublishingJob,
  type PublishingJobLike,
} from './publishing.worker';

/* 草稿编译器（纯函数，可单独测） */
export {
  DEFAULT_SECTIONS,
  DraftNoteReason,
  FRONT_PAGE_SIZE,
  MAJOR_SOURCE_SHARE,
  X_VOICES_MAX,
  X_VOICES_MIN,
  applySourceDiversity,
  compareCandidates,
  compileDraft,
  displayStyleFor,
  sectionForCandidate,
  type CompiledDraft,
  type CompiledItem,
  type CompiledSection,
  type DraftCandidate,
  type DraftNote,
  type DraftNoteReasonValue,
} from './draft-compiler';

/* 发布前校验（与 api 侧逐字相同，见 preflight.ts 文件头） */
export {
  MAX_LEAD_ITEMS,
  PreflightReason,
  formatEditionNo,
  nextEditionNo,
  preflightEdition,
  type EditionSnapshot,
  type PreflightIssue,
  type PreflightReasonValue,
  type PreflightResult,
} from './preflight';

/* 通知端口（下游要 override 时用） */
export {
  PUBLISHING_NOTIFIER,
  NoopPublishingNotifier,
  PublishingNotificationType,
  type PublishingNotificationInput,
  type PublishingNotificationTypeValue,
  type PublishingNotifier,
} from './notifier';

/* 持久化端口 */
export {
  PUBLISHING_REPOSITORY,
  type PublishingEditionRow,
  type PublishingRepository,
  type PublishingSectionInput,
} from './publishing.repository';

/* Dead Letter（实现本地的，端口复用 Agent 06 的） */
export {
  PrismaPublishingJobRunRecorder,
  PUBLISHING_JOB_RUN_RECORDER,
} from './prisma-job-run.repository';

/* 时钟 */
export { PUBLISHING_CLOCK, SystemPublishingClock, type PublishingClock } from './clock';
