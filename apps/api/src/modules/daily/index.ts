/**
 * Agent 08 — 日报（Daily）的公开面。
 *
 * 下游（Agent 10 的公开 API 聚合、Agent 12 的后台、Agent 14）只应从本文件
 * import，不要深入子目录 —— 子目录里的文件是实现细节。
 */

/* 模块与服务 */
export { DailyModule } from './module';
export { DailyService, DAILY_LOGGER, type EditionSummary, type PublishResult } from './service';

/* 时钟（下游要 override 时用） */
export { DAILY_CLOCK, SystemDailyClock, type DailyClock } from './clock';

/* 持久化端口（下游要 override 时用） */
export {
  DAILY_REPOSITORY,
  type DailyItemContent,
  type DailyItemRow,
  type DailyRepository,
  type DailySectionRow,
  type EditionDetail,
  type EditionRow,
  type SectionInput,
} from './repository';

/* 状态机（Agent 12 依此决定按钮的可用性，不要各写一套） */
export {
  DAILY_TRANSITIONS,
  EDITABLE_STATUSES,
  assertStateMachineCoversContract,
  canTransition,
  isEditable,
} from './state';

/* 发布前校验（与 worker 侧逐字相同，见 preflight.ts 文件头） */
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

/* 前台投影（Agent 10 / 13 要用同一份，别再造一个） */
export {
  toArchiveEntry,
  toPublicEdition,
  type PublicDailyArchiveEntry,
  type PublicDailyEdition,
  type PublicDailyItem,
  type PublicDailySection,
} from './public-view';

/* 审计 */
export {
  PublishingAuditEvent,
  writePublishingAudit,
  type PublishingAuditEventValue,
  type PublishingAuditRecord,
} from './audit';

/* 请求校验（Agent 12 组装表单时复用同一套规则） */
export {
  asRecord,
  invalid,
  monthRange,
  parseBusinessDate,
  parseOptionalStatus,
  parseScheduleBody,
  parseSectionsBody,
  parseYearMonth,
  type SectionBody,
  type SectionsBody,
  type YearMonth,
} from './dto';

/* 字段上限（后台前端做即时校验时复用） */
export {
  MAX_CUSTOM_EXCERPT_LENGTH,
  MAX_CUSTOM_HEADLINE_LENGTH,
  MAX_EDITION_HEADLINE_LENGTH,
  MAX_ITEMS_PER_SECTION,
  MAX_SECTIONS,
  MAX_SECTION_TITLE_LENGTH,
  clampChars,
} from './limits';
