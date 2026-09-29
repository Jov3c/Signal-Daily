/**
 * 管理员操作的审计记录。
 *
 * ── `docs/09`：**「所有人工 Evidence 操作写审计日志」** ──────────────
 *
 * ── ⚠ 为什么是日志而不是一张表（设计取舍，已记入 HANDOFF）──────────
 * schema 里有 `admin_notifications`，但那是**发给管理员看的通知**，
 * 不是**记录管理员做了什么**的审计 —— 两者方向相反，混用会让
 * 「已读」语义与「已发生」语义纠缠在一起。
 *
 * 而 schema 里**没有**审计表，加表属 Agent 01（§10 禁止其他 Agent 建 Migration）。
 *
 * 所以 V1 的实现是：**写结构化审计日志**，每条带一个专用 `errorCode`
 * 与操作者 id，便于按 code + userId 过滤。
 *
 * **代价必须说清楚**：日志会被轮转掉（`docs/15` 的 Docker log rotate），
 * 因此这不是可长期追溯的审计。**已提 CCR 请求一张 `admin_audit_logs` 表**；
 * 在那之前，本模块的审计强度是「可观测」而不是「可取证」。
 */

import type { Logger } from '@signal/logger';

/**
 * 审计事件的错误码（作为日志字段，不是 HTTP 错误）。
 *
 * 用 `ADMIN_*` 前缀而不是往 `DomainErrorCode` 里塞 —— 它们**不是错误码**，
 * 只是日志里的分类标签；塞进契约的错误码注册表会让「错误码」这个概念失去边界。
 */
export const AuditEvent = {
  EVIDENCE_ADDED: 'ADMIN_EVIDENCE_ADDED',
  EVIDENCE_UPDATED: 'ADMIN_EVIDENCE_UPDATED',
  EVIDENCE_DELETED: 'ADMIN_EVIDENCE_DELETED',
  EVIDENCE_PRIMARY_SET: 'ADMIN_EVIDENCE_PRIMARY_SET',
  REVIEW_DECIDED: 'ADMIN_REVIEW_DECIDED',
  REVIEW_BULK_DECIDED: 'ADMIN_REVIEW_BULK_DECIDED',
  /** 系统（定时扫描）产生的通知 —— actor 是 'system' 而不是某个人。 */
  NOTIFICATION_RAISED: 'ADMIN_NOTIFICATION_RAISED',
} as const;

export type AuditEventValue = (typeof AuditEvent)[keyof typeof AuditEvent];

/** 一条审计记录。 */
export type AuditRecord = {
  event: AuditEventValue;
  /** 操作者（`users.id`，字符串形式）。`docs/09` 要求能追到人。 */
  actorUserId: string;
  /** 操作对象（事件 / 证据 / 内容 id）。 */
  target: Record<string, string | null>;
  /** 变更前后，或动作参数。 */
  detail: Record<string, unknown>;
};

/**
 * 写一条审计记录。
 *
 * 用 `logger.info` 而不是 `warn`/`error`：审计是**正常业务事件**，
 * 不是异常。用 error 级别会让真正的故障淹没在审计流里。
 */
export function writeAudit(logger: Logger, record: AuditRecord): void {
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
