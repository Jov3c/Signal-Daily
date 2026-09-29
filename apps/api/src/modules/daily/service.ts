/**
 * `DailyService` —— 日报的编辑、排期、发布与公开读取。
 *
 * ── 责任边界（重要）────────────────────────────────────────────────
 *
 * ```text
 * 本服务（apps/api）        建期次之外的**一切编辑动作** + 手动发布 + 公开读
 * worker/publishing         草稿生成（05:30 / 07:00）+ 定时发布（08:00）
 * ```
 *
 * 草稿**只由 worker 生成**：`docs/13` 把 `publishing.daily-draft` 定在 worker，
 * 而候选选择依赖 `contents` 的大范围扫描，放在 HTTP 请求里会拖住后台。
 * 管理员要的「重新生成」在 V1 里等价于「再等一轮调度」——
 * 已记入 HANDOFF 的设计取舍。
 *
 * ── 为什么发布前要自己再做一遍准入 ────────────────────────────────
 * 草稿编译器只挑 `APPROVED` + `includeDailyCandidate` 的候选，
 * 但**手工编辑是另一条路径**：管理员可以自由输入 contentId。
 * 没有这道校验，就能把一条还没审的内容直接发到前台，
 * 绕过 `docs/00` 的「任何内容必须人工审核」。因此：
 *
 * - `replaceSections` 保存时校验（拒绝并说明是哪些 id）；
 * - `publish` 再校验一次（内容可能在保存**之后**被撤销）。
 *
 * ── `docs/10` 的「未审核 08:00 不发」怎么落实 ──────────────────────
 * 只有 `SCHEDULED` 能发布。08:00 的定时任务读到的若不是 `SCHEDULED`，
 * 它**什么都不做**（保持草稿），而不是「到点就发」。
 */

import { Inject, Injectable } from '@nestjs/common';
import {
  AppError,
  ContentPipelineStatus,
  DAILY_TARGET_PUBLISH_HOUR,
  DailyEditionStatus,
  PlatformErrorCode,
} from '@signal/contracts';
import { businessDateOf, businessTimeToUtc } from '@signal/config';
import type { Logger } from '@signal/logger';
import { DAILY_CLOCK } from './clock';
import { DAILY_REPOSITORY } from './repository';
import type { EditionDetail, EditionRow, DailyRepository, SectionInput } from './repository';
import { formatEditionNo, nextEditionNo, preflightEdition } from './preflight';
import { canTransition, isEditable } from './state';
import { PublishingAuditEvent, writePublishingAudit } from './audit';
import type { SectionsBody } from './dto';

/** 注入 token：日志。 */
export const DAILY_LOGGER = 'DAILY_LOGGER';

export interface DailyClockLike {
  now(): Date;
}

/** 后台列表里的一行。 */
export type EditionSummary = EditionRow & {
  /** 期号的人类可读形式（`NO.001`）；未发布时为 `null`。 */
  editionNoLabel: string | null;
  /** 条目总数 —— 列表页要显示「这一期有几条」。 */
  itemCount: number;
};

/**
 * 发布成功的结果。
 *
 * ⚠ **这个类型没有「失败」形态** —— 发布不成功一律**抛错**
 *（未排期 / 预检不过 / 已经发布过 / 被别人抢先）。
 * 因此没有 `published: false` 这种字段：那种形状会诱使调用方
 * 把「没发出去」当成一次成功（worker 侧确实需要那套形状，
 * 因为它的重试必须幂等；**这两条路径的诉求不同**，见 `publish()` 的注释）。
 */
export type PublishResult = {
  edition: EditionRow;
  /** `NO.001`。 */
  editionNoLabel: string | null;
};

@Injectable()
export class DailyService {
  constructor(
    @Inject(DAILY_REPOSITORY) private readonly repository: DailyRepository,
    @Inject(DAILY_CLOCK) private readonly clock: DailyClockLike,
    @Inject(DAILY_LOGGER) private readonly logger: Logger,
  ) {}

  /* ---------------------------------------------------------------- */
  /* 读取                                                              */
  /* ---------------------------------------------------------------- */

  /** 后台列表：某个月的期次。 */
  async listMonth(input: {
    from: string;
    to: string;
    status?: DailyEditionStatus;
  }): Promise<EditionSummary[]> {
    const rows = await this.repository.listByDateRange(input);
    return Promise.all(rows.map((row) => this.toSummary(row)));
  }

  /**
   * 后台详情：编辑台要看到版块、条目与内容预览。
   *
   * ⚠ **对「今天及过去」的日期是惰性补建的**（`ensureDraft`）——
   * 打开编辑台这个动作本身就意味着「今天这一期应该存在」。
   * 未来的日期**不补建**：那会在列表里堆出一批空期次，
   * 而 `docs/10` 的 00:10 调度本来就会在当天创建它。
   *
   * 这是一次**读操作带写入**，可接受的理由与 Agent 07 的 Dashboard 相同：
   * 补建是幂等的、且不需要覆盖任何已有内容（`ensureDraft` 对已存在的期
   * 原样返回）。**已记入 HANDOFF**。
   */
  async detail(businessDate: string): Promise<EditionDetail> {
    const edition =
      businessDate <= this.businessToday()
        ? await this.repository.ensureDraft(businessDate)
        : await this.repository.findByBusinessDate(businessDate);
    if (edition === null) throw this.notFound(businessDate);

    const detail = await this.repository.detail(edition.editionId);
    if (detail === null) throw this.notFound(businessDate);
    return detail;
  }

  /** 公开读取：**未发布对外不存在**（`docs/10`）。 */
  async publishedDetail(businessDate: string): Promise<EditionDetail> {
    const detail = await this.repository.findPublishedDetail(businessDate);
    if (detail === null) throw this.notFound(businessDate);
    return detail;
  }

  /** 公开归档：**只返回 PUBLISHED**（`docs/10`：前台日历只展示 PUBLISHED）。 */
  async archive(input: { from: string; to: string }): Promise<EditionSummary[]> {
    const rows = await this.repository.listArchive(input);
    return Promise.all(rows.map((row) => this.toSummary(row)));
  }

  /* ---------------------------------------------------------------- */
  /* 编辑                                                              */
  /* ---------------------------------------------------------------- */

  /**
   * 整体替换某一期的版块与条目。
   *
   * - 只有 `DRAFT` / `REVIEWING` / `SCHEDULED` 可编辑（见 `state.ts`）；
   * - `DRAFT` 被编辑后变成 `REVIEWING` —— 「有人动过它了」，
   *   这既让 `docs/10` 的 07:30 提醒有意义，也让草稿编译器**停止覆盖**
   *   （编译器只写 `DRAFT`，见 worker 的 `publishing.service.ts`）；
   * - `SCHEDULED` 编辑后**仍是 `SCHEDULED`**：修个错别字不该把已排的期踢回去。
   */
  async replaceSections(
    businessDate: string,
    body: SectionsBody,
    actorUserId: string,
  ): Promise<EditionDetail> {
    const edition = await this.repository.findByBusinessDate(businessDate);
    if (edition === null) throw this.notFound(businessDate);

    if (!isEditable(edition.status)) {
      throw this.invalidTransition(edition.status, DailyEditionStatus.REVIEWING, {
        businessDate,
        hint: 'published editions cannot be edited (docs/10: no silent re-layout)',
      });
    }

    const sections: SectionInput[] = body.sections.map((section) => ({
      type: section.type,
      title: section.title,
      sortOrder: section.sortOrder,
      items: section.items,
    }));

    await this.assertContentsPublishable(sections, businessDate);

    await this.repository.replaceSections(edition.editionId, sections);

    if (body.headline !== undefined) {
      await this.repository.updateEdition(edition.editionId, { headline: body.headline });
    }
    // `DRAFT` → `REVIEWING`：这是**唯一的**自动转移，且只在管理员真的保存了内容时发生。
    if (edition.status === DailyEditionStatus.DRAFT) {
      await this.repository.updateEdition(edition.editionId, {
        status: DailyEditionStatus.REVIEWING,
      });
    }

    writePublishingAudit(this.logger, {
      event: PublishingAuditEvent.DAILY_SECTIONS_REPLACED,
      actorUserId,
      target: { businessDate, editionId: edition.editionId },
      detail: {
        fromStatus: edition.status,
        sectionCount: sections.length,
        itemCount: sections.reduce((total, section) => total + section.items.length, 0),
      },
    });

    return this.detail(businessDate);
  }

  /* ---------------------------------------------------------------- */
  /* 排期 / 取消                                                        */
  /* ---------------------------------------------------------------- */

  /**
   * 排期：把这一期标记为「到目标时刻就可以上」。
   *
   * `scheduledAt` **由服务端算**，永远等于该业务日的**上海 08:00**
   *（`docs/10` 的目标发布时刻，契约常量 `DAILY_TARGET_PUBLISH_HOUR`）——
   * 接口不接受调用方指定的时刻。
   *
   * 用 `businessTimeToUtc` 换算而不是拼 `T08:00:00Z`：后者是 UTC 08:00，
   * 即上海 16:00，会比目标晚 8 小时。
   *
   * ⚠ `scheduledAt` 落库的用途是**记录与展示**（运维回答「这一期本来打算几点发」），
   * 它**不驱动发布** —— 发布由 worker 的 08:00 那一班按 `status === SCHEDULED` 触发。
   * 两者之所以一致，是因为它们**都从同一个契约常量派生**
   *（worker 侧 `SLOT_TIME[PUBLISH]`，有一条测试钉住它与常量相等）。
   * 第一版让调用方传时刻、存进库、却没人读 —— 那是一个被静默兑现错的承诺。
   */
  async schedule(businessDate: string, actorUserId: string): Promise<EditionRow> {
    const edition = await this.repository.findByBusinessDate(businessDate);
    if (edition === null) throw this.notFound(businessDate);

    if (!canTransition(edition.status, DailyEditionStatus.SCHEDULED)) {
      throw this.invalidTransition(edition.status, DailyEditionStatus.SCHEDULED, { businessDate });
    }

    const target = businessTimeToUtc(businessDate, DAILY_TARGET_PUBLISH_HOUR);

    const updated = await this.repository.updateEdition(edition.editionId, {
      status: DailyEditionStatus.SCHEDULED,
      scheduledAt: target,
    });
    if (updated === null) throw this.notFound(businessDate);

    writePublishingAudit(this.logger, {
      event: PublishingAuditEvent.DAILY_SCHEDULED,
      actorUserId,
      target: { businessDate, editionId: edition.editionId },
      detail: { fromStatus: edition.status, scheduledAt: target.toISOString() },
    });

    return updated;
  }

  /** 取消。`docs/10`：**取消草稿不占号**，所以这是无损的（且可以恢复）。 */
  async cancel(businessDate: string, actorUserId: string): Promise<EditionRow> {
    const edition = await this.repository.findByBusinessDate(businessDate);
    if (edition === null) throw this.notFound(businessDate);

    if (!canTransition(edition.status, DailyEditionStatus.CANCELLED)) {
      throw this.invalidTransition(edition.status, DailyEditionStatus.CANCELLED, { businessDate });
    }

    const updated = await this.repository.updateEdition(edition.editionId, {
      status: DailyEditionStatus.CANCELLED,
    });
    if (updated === null) throw this.notFound(businessDate);

    writePublishingAudit(this.logger, {
      event: PublishingAuditEvent.DAILY_CANCELLED,
      actorUserId,
      target: { businessDate, editionId: edition.editionId },
      detail: { fromStatus: edition.status },
    });

    return updated;
  }

  /* ---------------------------------------------------------------- */
  /* 发布                                                              */
  /* ---------------------------------------------------------------- */

  /**
   * 发布（管理员手动路径）。
   *
   * 顺序是**刻意的**：
   *
   * 1. 存在性 → 2. 已经是 `PUBLISHED` 就报 **409 `DAILY_ALREADY_PUBLISHED`** →
   * 3. 必须 `SCHEDULED`（`docs/10` 的「未审核 08:00 不发」）→
   * 4. **发布前校验**（`docs/10` 的 Publish Preflight）→
   * 5. 占期号并落库（`markPublished` 内部是条件更新 + 唯一约束兜底）。
   *
   * 第 4 步在第 5 步之前是关键：**校验失败绝不能占期号**。
   * 否则一次失败的发布会让 `NO.001` 空掉，而 `docs/10` 说期号只在
   * 「真正发布」时分配。
   *
   * ── ⚠ 为什么这里**不**像 worker 那样幂等成功 ──────────────────────
   * worker 的 `publishIfScheduled` 必须幂等：它会被重试、也会与手动发布撞车，
   * 在那里「目标状态已达成」就等于成功。
   *
   * 而这是**人点的**。管理员点「发布」而它已经发布过时，
   * 一个静默的 200 会让他以为「这次点击完成了发布」——
   * 而 V1 **不支持发布后修改**（没有 revision 表），所以「它早就发出去了、
   * 你刚才那次点击什么也没做」才是他要听到的话。
   * 409 带一个专门的码，前端可以直接说清「已发布，去看归档」。
   */
  async publish(businessDate: string, actorUserId: string): Promise<PublishResult> {
    const edition = await this.repository.findByBusinessDate(businessDate);
    if (edition === null) throw this.notFound(businessDate);

    if (edition.status === DailyEditionStatus.PUBLISHED) {
      throw new AppError({
        code: 'DAILY_ALREADY_PUBLISHED',
        httpStatus: 409,
        safeMessage: 'This daily edition has already been published',
        details: {
          businessDate,
          editionNo: edition.editionNo,
          publishedAt: edition.publishedAt,
          // 说清「下一步该做什么」——否则管理员只会反复点发布。
          hint: 'published editions cannot be edited in V1; see the archive instead',
        },
      });
    }

    if (edition.status !== DailyEditionStatus.SCHEDULED) {
      throw this.invalidTransition(edition.status, DailyEditionStatus.PUBLISHED, {
        businessDate,
        hint: 'only a SCHEDULED edition may be published (docs/10)',
      });
    }

    const snapshot = await this.repository.snapshot(edition.editionId);
    if (snapshot === null) throw this.notFound(businessDate);

    const preflight = preflightEdition(snapshot);
    if (!preflight.ok) {
      // `docs/10` 的 preflight「只报告不修」：自动挑一条当 LEAD 会让
      // 「发布」变成一个会改变内容的动作，而管理员以为它只是「发出去」。
      throw new AppError({
        code: 'DAILY_PREFLIGHT_FAILED',
        httpStatus: 409,
        safeMessage: 'Daily edition failed the publish preflight',
        details: { businessDate, issues: preflight.issues },
      });
    }

    const publishedCount = await this.repository.countPublished();
    const publishedAt = this.clock.now();
    const marked = await this.repository.markPublished(edition.editionId, {
      editionNo: nextEditionNo(publishedCount),
      publishedAt,
    });

    // `null` = 在我们读状态之后、写之前，别人（08:00 的定时任务、或另一次点击）
    // 先发布了。**与上面那条一致地报 409**：这一次点击确实没有完成发布，
    // 而目标状态已经达成 —— 两件事都要说清，不能只报其中一件。
    if (marked === null) {
      const current = await this.repository.findByBusinessDate(businessDate);
      throw new AppError({
        code: 'DAILY_ALREADY_PUBLISHED',
        httpStatus: 409,
        safeMessage:
          'This daily edition was published by someone else while you were publishing it',
        details: {
          businessDate,
          editionNo: current?.editionNo ?? null,
          raced: true,
        },
      });
    }

    const itemCount = snapshot.sections.reduce((total, section) => total + section.items.length, 0);

    writePublishingAudit(this.logger, {
      event: PublishingAuditEvent.DAILY_PUBLISHED,
      actorUserId,
      target: { businessDate, editionId: edition.editionId },
      detail: {
        editionNo: marked.editionNo,
        editionNoLabel: marked.editionNo === null ? null : formatEditionNo(marked.editionNo),
        sectionCount: snapshot.sections.length,
        itemCount,
      },
    });

    return {
      edition: marked,
      editionNoLabel: marked.editionNo === null ? null : formatEditionNo(marked.editionNo),
    };
  }

  /* ---------------------------------------------------------------- */
  /* 内部                                                              */
  /* ---------------------------------------------------------------- */

  /**
   * 保存前的准入校验：所有引用的内容必须存在且已 `APPROVED`。
   *
   * 一次性把**所有**问题报出来（而不是遇到第一个就退），
   * 这样管理员一次就能修完 —— 与手写校验的取舍一致。
   */
  private async assertContentsPublishable(
    sections: readonly SectionInput[],
    businessDate: string,
  ): Promise<void> {
    const contentIds = [...new Set(sections.flatMap((s) => s.items.map((i) => i.contentId)))];
    if (contentIds.length === 0) return;

    const statuses = await this.repository.findContentStatuses(contentIds);

    const problems: { contentId: string; reason: string }[] = [];
    for (const contentId of contentIds) {
      const status = statuses.get(contentId);
      if (status === undefined) {
        problems.push({ contentId, reason: 'CONTENT_NOT_FOUND' });
      } else if (status !== ContentPipelineStatus.APPROVED) {
        problems.push({ contentId, reason: status });
      }
    }
    if (problems.length === 0) return;

    throw new AppError({
      code: PlatformErrorCode.CONFLICT,
      httpStatus: 409,
      safeMessage:
        'Daily items must reference existing, approved content ' +
        '(docs/00: every published item must have been reviewed by a human)',
      details: { businessDate, problems },
    });
  }

  /**
   * 当前的**上海业务日**（`YYYY-MM-DD`）。
   *
   * 用 `businessDateOf` 而不是 `now.toISOString().slice(0,10)` ——
   * 后者是 UTC 日，在上海时间 00:00–08:00 之间会比业务日**早一天**，
   * 于是「打开今天的编辑台」会去补建昨天那一期，而今天那期永远不存在。
   */
  private businessToday(): string {
    return businessDateOf(this.clock.now());
  }

  private async toSummary(row: EditionRow): Promise<EditionSummary> {
    const detail = await this.repository.detail(row.editionId);
    const itemCount =
      detail === null
        ? 0
        : detail.sections.reduce((total, section) => total + section.items.length, 0);

    return {
      ...row,
      editionNoLabel: row.editionNo === null ? null : formatEditionNo(row.editionNo),
      itemCount,
    };
  }

  private notFound(businessDate: string): AppError {
    return new AppError({
      code: 'DAILY_EDITION_NOT_FOUND',
      httpStatus: 404,
      safeMessage: `No daily edition for ${businessDate}`,
      details: { businessDate },
    });
  }

  private invalidTransition(
    from: DailyEditionStatus,
    to: DailyEditionStatus,
    extra: Record<string, unknown>,
  ): AppError {
    return new AppError({
      code: 'DAILY_INVALID_TRANSITION',
      httpStatus: 409,
      safeMessage: `Cannot move daily edition from ${from} to ${to}`,
      details: { from, to, ...extra },
    });
  }
}
