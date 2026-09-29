/**
 * `NotificationService` —— 管理员通知（任务书的「管理员通知」）。
 *
 * 两类（任务书的测试清单明确点名）：
 *
 * ```text
 * 高分通知        finalScore >= 85（docs/08 的一级候选）
 * Source 失败通知  sources.last_error_code 非空
 * ```
 *
 * ── 为什么是**扫描**而不是事件回调（设计取舍）────────────────────────
 * 高分发生在 Agent 06 的 AI 作业里、来源失败发生在 Agent 04 的采集作业里，
 * 两者都已经交付、都不会回调本模块（§9：不改别人的模块）。
 * `docs/13` 的 Job 清单里也没有「通知扫描」这一类。
 *
 * 所以本模块用**幂等扫描**收敛：找出「该通知但还没通知过」的对象，
 * 落 `admin_notifications` 行并入队 `notification.admin-email`。
 *
 * 幂等靠 `(type, targetUrl)` 去重 —— `admin_notifications` **没有唯一约束**，
 * 所以「同一件事只通知一次」是业务层的责任，而不是数据库的。
 *
 * ── ⚠ 这是一个 API 进程里的定时器（取舍）────────────────────────────
 * 与 Agent 05 在 worker 里做收尾扫描不同，本模块在 **api** 进程里挂了一个
 * 60 秒的定时器。理由：通知的触发条件横跨 04/06 两个 worker 模块，
 * 而它没有自己的 Job 名；放在 api 里至少不需要再改别人的模块。
 *
 * 代价：api 进程多了一个后台任务、「通知」这件事不在 worker 的运维视野里。
 * **已提 CCR**，建议 Agent 11 把它挪进 worker（`notification.admin-email`
 * 的 producer 本来就更适合待在 worker 侧）。
 */

import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { Logger } from '@signal/logger';
import { writeAudit, AuditEvent } from './audit';
import { ADMIN_REVIEW_REPOSITORY, type AdminReviewRepository } from './repository';
import { HIGH_SCORE_THRESHOLD } from './dto/review.dto';

/** 注入 token。 */
export const NOTIFICATION_LOGGER = 'NOTIFICATION_LOGGER';

/** 通知类型（落 `admin_notifications.type`，`VarChar(80)`）。 */
export const NotificationType = {
  HIGH_SCORE_CONTENT: 'HIGH_SCORE_CONTENT',
  SOURCE_FAILURE: 'SOURCE_FAILURE',
} as const;
export type NotificationTypeValue = (typeof NotificationType)[keyof typeof NotificationType];

/**
 * 通知的 `targetUrl` —— **同时充当去重键**。
 *
 * 用后台路径（`/admin/review/<id>`）而不是外部 URL：管理员点通知要跳的是
 * 后台的审核页，而不是原始文章。这样它天然是稳定、唯一的。
 */
export function highScoreTargetUrl(contentId: string): string {
  return `/admin/review/${contentId}`;
}

export function sourceFailureTargetUrl(sourceId: string): string {
  return `/admin/sources/${sourceId}`;
}

/** 一次扫描的结果（供日志与测试断言）。 */
export type NotificationScanResult = {
  highScoreCreated: number;
  sourceFailureCreated: number;
};

@Injectable()
export class NotificationService {
  constructor(
    @Inject(ADMIN_REVIEW_REPOSITORY) private readonly repository: AdminReviewRepository,
    @Inject(NOTIFICATION_LOGGER) private readonly logger: Logger,
  ) {}

  /**
   * 扫描并创建缺失的通知。
   *
   * **幂等**：已经通知过的对象不会再产生第二条。
   * 因此它可以被定时器反复调用，也可以被测试直接调用。
   */
  async scan(): Promise<NotificationScanResult> {
    const [highScoreCreated, sourceFailureCreated] = await Promise.all([
      this.scanHighScore(),
      this.scanSourceFailure(),
    ]);
    return { highScoreCreated, sourceFailureCreated };
  }

  /**
   * 高分候选。
   *
   * 口径是 `finalScore >= 85` **且仍在审核队列（`EditorialReview = PENDING`）** ——
   * 已经审过的内容再通知一次没有意义（管理员已经处理过它了）。
   */
  private async scanHighScore(): Promise<number> {
    const notified = await this.repository.findNotifiedKeys(NotificationType.HIGH_SCORE_CONTENT);
    const candidates = await this.repository.listHighScoreCandidates(HIGH_SCORE_THRESHOLD);

    let created = 0;
    for (const candidate of candidates) {
      const targetUrl = highScoreTargetUrl(candidate.contentId);
      if (notified.has(targetUrl)) continue;

      const notificationId = await this.repository.createNotification({
        type: NotificationType.HIGH_SCORE_CONTENT,
        title: `高分候选（${candidate.finalScore.toFixed(1)}）：${candidate.title}`,
        body: candidate.recommendationReason ?? '暂无推荐理由',
        targetUrl,
      });
      created += 1;

      // 审计：通知是**系统**产生的，actor 用 `system` 占位 ——
      // 「谁触发的」在这里是「定时扫描」，不是某个人。
      writeAudit(this.logger, {
        event: AuditEvent.NOTIFICATION_RAISED,
        actorUserId: 'system',
        target: { contentId: candidate.contentId, notificationId },
        detail: { kind: 'high-score-notification', finalScore: candidate.finalScore },
      });
    }

    if (created > 0) {
      this.logger.info({ created }, 'high score notifications raised');
    }
    return created;
  }

  /** 采集失败的来源。 */
  private async scanSourceFailure(): Promise<number> {
    const notified = await this.repository.findNotifiedKeys(NotificationType.SOURCE_FAILURE);
    const failing = await this.repository.listFailingSources();

    let created = 0;
    for (const source of failing) {
      const targetUrl = sourceFailureTargetUrl(source.id);
      if (notified.has(targetUrl)) continue;

      const notificationId = await this.repository.createNotification({
        type: NotificationType.SOURCE_FAILURE,
        title: `来源采集失败：${source.name}`,
        body: `错误码：${source.lastErrorCode}${
          source.lastErrorAt === null ? '' : `，最近一次：${source.lastErrorAt}`
        }`,
        targetUrl,
      });
      created += 1;

      writeAudit(this.logger, {
        event: AuditEvent.NOTIFICATION_RAISED,
        actorUserId: 'system',
        target: { sourceId: source.id, notificationId },
        detail: { kind: 'source-failure-notification', errorCode: source.lastErrorCode },
      });
    }

    if (created > 0) {
      this.logger.info({ created }, 'source failure notifications raised');
    }
    return created;
  }
}

/**
 * 通知的稳定去重摘要（供需要额外键的场景）。
 *
 * ⚠ 现在**没有使用**它 —— 去重键是 `targetUrl`。保留它是为了在
 * 「同一个 target 需要在不同时间点再次通知」时有一个现成的工具，
 * 而不是临时再想一个格式。**未使用的导出会在 lint 里报错**，
 * 所以它是被 `index.ts` 导出给下游的（Agent 12 的未读角标可能要用）。
 */
export function notificationDedupeKey(type: string, targetUrl: string): string {
  return createHash('sha256').update(`${type}:${targetUrl}`).digest('hex');
}
