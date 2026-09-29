/**
 * 管理员通知端口。
 *
 * ── 为什么本模块要写通知 ────────────────────────────────────────────
 * `docs/10` 的「建议调度」里有一条：
 *
 * ```text
 * 07:30 未 REVIEWING 则通知管理员
 * ```
 *
 * 这是**日报链路自己的**一条运营规则（不是审核链路的），
 * 所以由本模块的调度器负责。`docs/13` 的 10 个 Job 名里没有「日报提醒」，
 * 因此它**不入队**，由调度器在进程内直接完成。
 *
 * ── ⚠ 与 Agent 07 的关系 ────────────────────────────────────────────
 * Agent 07 的 `NotificationService` 也往 `admin_notifications` 写行
 *（高分候选、来源失败），但它在 `apps/api` 里 —— 跨 app 不能 import。
 *
 * 本模块因此直接写同一张表。已记入 Agent 08 的 CCR：
 * **通知是第三个「必须跨 app 共用却只能各写一份」的东西**
 *（前两个是 Agent 07 的分数档位、本模块的 preflight），
 * 建议 Agent 14 把它提成 `packages/*` 或一个独立的 notification 服务。
 */

import type { Logger } from '@signal/logger';

/** 注入 token。 */
export const PUBLISHING_NOTIFIER = 'PUBLISHING_NOTIFIER';

/** 通知类型（写进 `admin_notifications.type`）。 */
export const PublishingNotificationType = {
  /** `docs/10` 的 07:30：日报还没进 REVIEWING，提醒管理员。 */
  DAILY_REVIEW_PENDING: 'DAILY_REVIEW_PENDING',
  /**
   * 08:00 到点时这一期还是 `DRAFT`（没排期），因此**没有发布**。
   *
   * 与 `DAILY_REVIEW_PENDING` 分开：前者是「快去看看」，
   * 后者是「今天这一期已经错过了发布时刻」—— 后者更严重，
   * 管理员需要立刻知道，而不是两条一样的提醒。
   */
  DAILY_NOT_PUBLISHED: 'DAILY_NOT_PUBLISHED',
  /** 发布前校验没过，因此没有发布（`docs/10` 的 Publish Preflight）。 */
  DAILY_PREFLIGHT_BLOCKED: 'DAILY_PREFLIGHT_BLOCKED',
} as const;

export type PublishingNotificationTypeValue =
  (typeof PublishingNotificationType)[keyof typeof PublishingNotificationType];

export type PublishingNotificationInput = {
  type: PublishingNotificationTypeValue;
  title: string;
  body: string;
  /**
   * 去重键（写进 `target_url`）。
   *
   * `admin_notifications` **没有**唯一约束（Agent 07 的说明），
   * 所以幂等靠「先查后写」在应用层做。两张表都没有约束的前提下，
   * 这是唯一可行的做法 —— 代价是并发下可能写两行，
   * 而通知重复一次比漏掉一次好。
   */
  targetUrl: string;
};

export interface PublishingNotifier {
  /**
   * 写一条通知；**已经通知过就返回 `false`**（幂等）。
   *
   * @returns `true` = 本次真的写入了，`false` = 之前已经通知过。
   */
  notify(input: PublishingNotificationInput): Promise<boolean>;
}

/**
 * 什么都不做的实现（单元测试用）。
 *
 * 与 Agent 06 的 `NoopJobRunRecorder` 同一取舍：**刻意不是默认值** ——
 * 默认必须真写，否则就回到「契约要求了但没人做」的原始问题。
 */
export class NoopPublishingNotifier implements PublishingNotifier {
  readonly calls: PublishingNotificationInput[] = [];

  async notify(input: PublishingNotificationInput): Promise<boolean> {
    this.calls.push(input);
    return true;
  }
}

/** 便于实现侧打日志。 */
export type NotifierLogger = Logger;
