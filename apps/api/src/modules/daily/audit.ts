/**
 * Agent 08 的编辑动作审计记录。
 *
 * ── 为什么需要 ──────────────────────────────────────────────────────
 * 日报是**对外发布**的动作。回答「这一期是谁在什么时候排的期、谁点的发布、
 * 发布前长什么样」是运营上的基本要求，出了问题要能追到人。
 *
 * ── ⚠ 与 Agent 07 一样，这是日志而不是一张表（设计取舍，已记入 HANDOFF）──
 * `prisma/schema.prisma` 里**没有审计表**，加表属 Agent 01
 *（§10 禁止其他 Agent 建 Migration）。Agent 07 已经为「人工 Evidence 操作」
 * 提了 CCR 请求一张 `admin_audit_logs`，本模块**沿用同一个诉求**，
 * 不重复提一份。
 *
 * 因此 V1 的审计强度是「**可观测**」而不是「**可取证**」——
 * 日志会被 `docs/15` 的轮转策略清掉。
 *
 * ── 为什么 `featured` 复用本文件 ────────────────────────────────────
 * 精选与日报同属 Agent 08 的发布域，共用同一套审计形状。
 * 放 `daily/` 只是因为日报的动作更多；`featured/` 通过 `../daily/audit` 取用。
 * 这是**同一个 Owner 的模块间共用**，不是跨 Agent 依赖。
 */

import type { Logger } from '@signal/logger';

/**
 * 审计事件名。
 *
 * 用 `ADMIN_*` 前缀而不是往 `DomainErrorCode` 里塞 —— 它们**不是错误码**，
 * 只是日志里的分类标签（与 Agent 07 的 `AuditEvent` 同一取舍）。
 */
export const PublishingAuditEvent = {
  FEATURED_CREATED: 'ADMIN_FEATURED_CREATED',
  FEATURED_UPDATED: 'ADMIN_FEATURED_UPDATED',
  FEATURED_DEACTIVATED: 'ADMIN_FEATURED_DEACTIVATED',
  DAILY_SECTIONS_REPLACED: 'ADMIN_DAILY_SECTIONS_REPLACED',
  DAILY_SCHEDULED: 'ADMIN_DAILY_SCHEDULED',
  DAILY_PUBLISHED: 'ADMIN_DAILY_PUBLISHED',
  DAILY_CANCELLED: 'ADMIN_DAILY_CANCELLED',
} as const;

export type PublishingAuditEventValue =
  (typeof PublishingAuditEvent)[keyof typeof PublishingAuditEvent];

export type PublishingAuditRecord = {
  event: PublishingAuditEventValue;
  /** 操作者（`users.id`，字符串形式）。 */
  actorUserId: string;
  /** 操作对象：业务日、内容 id 等。 */
  target: Record<string, string | null>;
  /** 动作参数或变更前后。 */
  detail: Record<string, unknown>;
};

/**
 * 写一条审计记录。
 *
 * 用 `info` 而不是 `warn`/`error`：审计是**正常业务事件**，
 * 用 error 级别会让真正的故障淹没在审计流里（与 Agent 07 同一理由）。
 */
export function writePublishingAudit(logger: Logger, record: PublishingAuditRecord): void {
  logger.info(
    {
      errorCode: record.event,
      userId: record.actorUserId,
      auditTarget: record.target,
      auditDetail: record.detail,
    },
    'admin audit',
  );
}
