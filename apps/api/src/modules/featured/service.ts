/**
 * `FeaturedService` —— 精选。
 *
 * `docs/10`：
 *
 * > 精选是实时编辑流。Content APPROVED 且勾选 Featured 后创建 FeaturedItem。
 *
 * 允许改：自定义标题 / 摘要 / 权重 / 下架。
 * **禁止改：原始来源、originalUrl、原发布时间。**
 *
 * ── 那三条「禁止改」在实现上怎么落实 ────────────────────────────────
 * 不是靠注释，而是靠**接口形状**：`UpdateFeaturedInput` 里根本没有
 * `originalUrl` / `publishedAt` / `sourceId` 这些键，
 * 仓储的 `update` 也只写 `customTitle` / `customSummary` / `sortWeight` / `active`。
 * 想改也传不进来。
 */

import { Inject, Injectable } from '@nestjs/common';
import { AppError, ContentPipelineStatus } from '@signal/contracts';
import type { Logger } from '@signal/logger';
import {
  FEATURED_CLOCK,
  FEATURED_REPOSITORY,
  type FeaturedRepository,
  type FeaturedRow,
  type FeaturedEdits,
} from './repository';
import { MAX_CUSTOM_SUMMARY_LENGTH, MAX_CUSTOM_TITLE_LENGTH, clampChars } from './limits';
import { PublishingAuditEvent, writePublishingAudit } from '../daily/audit';

/** 注入 token：日志。 */
export const FEATURED_LOGGER = 'FEATURED_LOGGER';

export interface FeaturedClock {
  now(): Date;
}

@Injectable()
export class FeaturedService {
  constructor(
    @Inject(FEATURED_REPOSITORY) private readonly repository: FeaturedRepository,
    @Inject(FEATURED_CLOCK) private readonly clock: FeaturedClock,
    @Inject(FEATURED_LOGGER) private readonly logger: Logger,
  ) {}

  /**
   * 加入精选。
   *
   * ⚠ **只有已审核通过、且管理员勾选了 Featured 的内容才能进**（`docs/10`）。
   * 两道门都要过：
   * - `contents.pipeline_status = APPROVED`（Agent 07 的决策写的）；
   * - `editorial_reviews.publish_featured = true`（同一次决策写的）。
   *
   * 只检查前者是不够的：`pipelineStatus` 会因为别的原因变成 APPROVED
   *（例如将来的批量流程），而**「进精选」是一个独立的编辑意图**。
   */
  async create(
    contentId: string,
    input: { customTitle?: string | null; customSummary?: string | null; sortWeight?: number },
    actorUserId: string,
  ): Promise<FeaturedRow> {
    const gate = await this.repository.findContentGate(contentId);
    if (gate === null) throw this.notFound(contentId);

    if (gate.pipelineStatus !== ContentPipelineStatus.APPROVED) {
      throw new AppError({
        code: 'FEATURED_NOT_ELIGIBLE',
        httpStatus: 409,
        safeMessage: 'Only approved content can be featured',
        details: { contentId, reason: 'NOT_APPROVED', pipelineStatus: gate.pipelineStatus },
      });
    }
    if (!gate.publishFeatured) {
      throw new AppError({
        code: 'FEATURED_NOT_ELIGIBLE',
        httpStatus: 409,
        safeMessage: 'This content was not approved for the featured section',
        details: { contentId, reason: 'FEATURED_NOT_CHECKED', reviewStatus: gate.reviewStatus },
      });
    }

    const created = await this.repository.create({
      contentId,
      customTitle: clampChars(input.customTitle ?? null, MAX_CUSTOM_TITLE_LENGTH),
      customSummary: clampChars(input.customSummary ?? null, MAX_CUSTOM_SUMMARY_LENGTH),
      sortWeight: input.sortWeight ?? 0,
      publishedAt: this.clock.now(),
    });

    // 唯一约束撞车 → 已经是精选了。**不靠先查后写**（那之间有并发窗口）。
    if (created === null) {
      throw new AppError({
        code: 'FEATURED_ALREADY_EXISTS',
        httpStatus: 409,
        safeMessage: 'This content is already featured',
        details: { contentId },
      });
    }

    writePublishingAudit(this.logger, {
      event: PublishingAuditEvent.FEATURED_CREATED,
      actorUserId,
      target: { contentId },
      detail: { sortWeight: created.sortWeight, hasCustomTitle: created.customTitle !== null },
    });

    return created;
  }

  /** 改自定义标题 / 摘要 / 权重 / 上下架。 */
  async update(contentId: string, input: FeaturedEdits, actorUserId: string): Promise<FeaturedRow> {
    const updated = await this.repository.update({
      contentId,
      ...(input.customTitle === undefined
        ? {}
        : { customTitle: clampChars(input.customTitle, MAX_CUSTOM_TITLE_LENGTH) }),
      ...(input.customSummary === undefined
        ? {}
        : { customSummary: clampChars(input.customSummary, MAX_CUSTOM_SUMMARY_LENGTH) }),
      ...(input.sortWeight === undefined ? {} : { sortWeight: input.sortWeight }),
      ...(input.active === undefined ? {} : { active: input.active }),
    });

    if (updated === null) throw this.notFound(contentId);

    writePublishingAudit(this.logger, {
      event: PublishingAuditEvent.FEATURED_UPDATED,
      actorUserId,
      target: { contentId },
      // 记**改了哪些字段**而不是它们的值：自定义摘要可能是几百字，
      // 整段进日志会把审计流淹掉，而「谁改了哪几个字段」才是要回答的问题。
      detail: { fields: Object.keys(input) },
    });

    return updated;
  }

  /** 下架（软下架：`active = false`，保留历史）。 */
  async deactivate(contentId: string, actorUserId: string): Promise<FeaturedRow> {
    const updated = await this.update(contentId, { active: false }, actorUserId);

    writePublishingAudit(this.logger, {
      event: PublishingAuditEvent.FEATURED_DEACTIVATED,
      actorUserId,
      target: { contentId },
      detail: { active: false },
    });

    return updated;
  }

  /**
   * 列表。
   *
   * `publicOnly` 时**只返回仍然有效的**：`active = true` **且**内容还是
   * `APPROVED`。后者不是冗余检查 —— 内容后来被撤下（`REJECTED` / `ARCHIVED`）时，
   * 精选项不会自动消失，前台必须自己把它过滤掉，否则会把已撤下的内容继续展示。
   */
  async list(input: {
    publicOnly: boolean;
    topicSlug?: string;
    contentType?: string;
    limit: number;
    cursor?: string;
  }): Promise<{ rows: FeaturedRow[]; nextCursor: string | null }> {
    return this.repository.list(input);
  }

  private notFound(contentId: string): AppError {
    return new AppError({
      code: 'FEATURED_NOT_FOUND',
      httpStatus: 404,
      safeMessage: `Featured item not found: ${contentId}`,
      details: { contentId },
    });
  }
}
