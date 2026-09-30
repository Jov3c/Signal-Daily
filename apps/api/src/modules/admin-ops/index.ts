/**
 * `admin-ops` —— 后台运维视图的公开面（Agent 12 的 Jobs / Notifications / AI Usage 三页）。
 *
 * 下游（Agent 12 / 14）只应从本文件 import。
 */

export { AdminOpsModule } from './module';

export {
  ADMIN_OPS_CLOCK,
  ADMIN_OPS_LOGGER,
  AdminOpsService,
  pageMeta,
  recentBusinessDates,
  shiftBusinessDate,
  windowOf,
  type AdminOpsClock,
  type AiUsageView,
} from './service';

export {
  ADMIN_OPS_REPOSITORY,
  NOTIFICATION_STATUSES,
  type AdminAiRun,
  type AdminJobRun,
  type AdminNotification,
  type AdminOpsRepository,
  type AiUsageDailyRow,
  type AiUsageGroupRow,
  type AiUsageRollup,
  type AiUsageWindow,
  type JobRunListQuery,
  type NotificationListQuery,
  type NotificationStatusValue,
} from './repository';

export {
  AI_USAGE_DEFAULT_DAYS,
  AI_USAGE_MAX_DAYS,
  AI_USAGE_RECENT_LIMIT,
  invalid,
  parseAiUsageQuery,
  parseJobRunListQuery,
  parseNotificationListQuery,
  parsePositiveInt,
} from './dto/parse';
