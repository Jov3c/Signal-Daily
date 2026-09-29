/**
 * Agent 07 — 编辑审核 CMS API / Evidence 的公开面。
 *
 * 下游（Agent 12 的 Admin UI、Agent 14）只应从本文件 import，
 * 不要深入子目录 —— 子目录里的文件是实现细节。
 */

/* 模块与服务 */
export { AdminReviewModule, NOTIFICATION_SCAN_INTERVAL_MS } from './module';
export { ReviewService, DECISION_MAPPINGS, REVIEW_LOGGER } from './review.service';
export { EvidenceService, EVIDENCE_LOGGER, normalizeEvidenceUrl, hashEvidenceUrl } from './evidence.service';
export {
  NotificationService,
  NOTIFICATION_LOGGER,
  NotificationType,
  highScoreTargetUrl,
  sourceFailureTargetUrl,
  type NotificationScanResult,
} from './notification.service';

/* 时钟（下游要 override 时用） */
export { ADMIN_REVIEW_CLOCK, SystemAdminReviewClock, type AdminReviewClock } from './clock';

/* Origin 守卫（CCR 建议提到 common/，见 admin-origin.guard.ts 的说明） */
export {
  ADMIN_ORIGIN_CONFIG,
  AdminOriginGuard,
  createAdminOriginConfig,
  type AdminOriginConfig,
} from './admin-origin.guard';

/* 审计 */
export { AuditEvent, writeAudit, type AuditEventValue, type AuditRecord } from './audit';

/* 分数档位（与 Agent 06 同口径的第二份实现，见 scoring.ts 的说明） */
export { SCORE_BANDS, SCORE_BAND_THRESHOLDS, isHighPriority, scoreBand, type ScoreBand } from './scoring';

/* DTO 与校验（Agent 12 组装表单时复用同一套规则） */
export {
  BULK_REVIEW_ACTIONS,
  HIGH_SCORE_THRESHOLD,
  REVIEW_ACTIONS,
  REVIEW_LIST_DEFAULTS,
  type AddEvidenceInput,
  type BulkReviewAction,
  type BulkReviewInput,
  type BulkReviewResponse,
  type DashboardResponse,
  type EvidenceDetail,
  type EvidenceMutationResponse,
  type ReviewAction,
  type ReviewDecisionInput,
  type ReviewDecisionResponse,
  type ReviewDetail,
  type ReviewListItem,
  type ReviewListQuery,
  type ReviewListResponse,
  type SimilarContent,
  type UpdateEvidenceInput,
} from './dto/review.dto';
export {
  MAX_BULK_SIZE,
  parseAddEvidenceBody,
  parseBulkBody,
  parseDecisionBody,
  parseReviewListQuery,
  parseUpdateEvidenceBody,
} from './dto/parse';

/* 持久化端口（下游要 override 时用） */
export { ADMIN_REVIEW_REPOSITORY, type AdminReviewRepository } from './repository';
