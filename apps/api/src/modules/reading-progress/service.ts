/**
 * `ReadingProgressService` —— 阅读进度。
 *
 * ── `docs/11` ───────────────────────────────────────────────────────
 *
 * > Reading Progress：0–1，客户端节流更新；**>=0.95 可 completed**。
 *
 * ── ⚠ 「completed」的三条规则（每一条都有测试）────────────────────────
 *
 * 1. **跨过 0.95 的那一次写入**置 `completedAt`。
 * 2. **已完成的不回退**：之后再写 `progress = 0.2` 也**不清空** `completedAt`。
 *    理由：用户已经读完过一次。把「重读开头」当成「撤销完成」，
 *    会让「我读过哪些」这个问题的答案随一次误触而丢失。
 * 3. **不覆盖已有的完成时间**：重复写 `progress = 0.98` 不会把时间刷新成现在 ——
 *    否则「什么时候读完的」永远等于「最后一次打开」。
 *
 * ── ⚠ 写入是 upsert，不是 append ────────────────────────────────────
 * 主键是 `(userId, resourceType, resourceId)` —— 一个用户对一份内容**只有一行**。
 * `docs/11` 说「客户端节流更新」：客户端会持续 PUT 同一个资源，
 * 这里必须是覆盖而不是堆积，否则表会被几十倍地放大。
 */

import { Inject, Injectable } from '@nestjs/common';
import { AppError, PlatformErrorCode } from '@signal/contracts';
import { toResourceId } from './bigint-id';
import { READING_PROGRESS_CLOCK, READING_PROGRESS_REPOSITORY } from './repository';
import type { ReadingProgressRepository, ReadingProgressRow } from './repository';
import type { UpsertProgressBody } from './dto';

/** `docs/11`：`>= 0.95` 可 completed。 */
export const COMPLETION_THRESHOLD = 0.95;

export interface ReadingProgressClock {
  now(): Date;
}

@Injectable()
export class ReadingProgressService {
  constructor(
    @Inject(READING_PROGRESS_REPOSITORY) private readonly repository: ReadingProgressRepository,
    @Inject(READING_PROGRESS_CLOCK) private readonly clock: ReadingProgressClock,
  ) {}

  async upsert(rawUserId: string, body: UpsertProgressBody): Promise<ReadingProgressRow> {
    const userId = toResourceId(rawUserId);
    const resourceId = toResourceId(body.resourceId);
    if (userId === null) {
      throw new AppError({
        // ⚠ 用注册表常量而不是字面量：Agent 02 的守卫要求源码里的
        // `code: '...'` 字面量符合 `DOMAIN_REASON` 形状，而 `UNAUTHORIZED`
        // **没有下划线**（平台码不遵守那条命名规则）—— 写成字面量会直接变红。
        code: PlatformErrorCode.UNAUTHORIZED,
        httpStatus: 401,
        safeMessage: 'The authenticated session does not map to a usable user id',
      });
    }
    if (resourceId === null || !(await this.repository.isResourceVisible(resourceId))) {
      // 不存在与不可见返回同一个码（`docs/12`）—— 否则这个接口会变成
      // 「某 id 是否存在」的探测器。见 `CONTENT_NOT_VISIBLE` 的说明。
      throw new AppError({
        code: 'CONTENT_NOT_VISIBLE',
        httpStatus: 404,
        safeMessage: 'Content not found',
        details: { resourceId: body.resourceId },
      });
    }

    const existing = await this.repository.find({
      userId,
      resourceType: body.resourceType,
      resourceId,
    });

    // 规则 2 + 3：已完成过就保持原值（`null` = 不改这一列）。
    const completedAt =
      existing?.completedAt !== null && existing?.completedAt !== undefined
        ? null
        : body.progress >= COMPLETION_THRESHOLD
          ? this.clock.now()
          : null;

    return this.repository.upsert({
      userId,
      resourceType: body.resourceType,
      resourceId,
      progress: body.progress,
      lastPosition: body.lastPosition,
      completedAt,
    });
  }
}
