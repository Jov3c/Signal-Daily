/**
 * `PublishingService` —— 日报的**草稿生成**与**定时发布**。
 *
 * 这是 worker 侧的发布权威：`daily_editions` 从 `SCHEDULED` 到 `PUBLISHED`
 * 这一步**只在这里发生**（api 侧有一条同步的手动发布路径，
 * 两者共用同一套 `preflight.ts`，见那个文件的文件头）。
 *
 * ── `docs/10` 的调度与实现对照 ──────────────────────────────────────
 *
 * ```text
 * 00:10 初始化当天 DRAFT      -> initDraft()          只建空期，不碰内容
 * 05:30 生成初始 draft        -> generateDraft()      整份重算
 * 07:00 刷新候选              -> generateDraft()      同一函数，重跑而已
 * 07:30 未 REVIEWING 则通知   -> remindIfNotReviewing()
 * 08:00 只有 SCHEDULED 才发布 -> publishIfScheduled()
 * 未审核保持草稿              -> generateDraft 只写 DRAFT；
 *                                publishIfScheduled 只发 SCHEDULED
 * ```
 *
 * ── ⚠ 草稿生成的三条安全性质（每一条都有测试）────────────────────────
 *
 * 1. **只写 `DRAFT`**。管理员一旦保存过（→ `REVIEWING`）或排过期
 *    （→ `SCHEDULED`），生成器**再也不会碰它**。
 *    这是「05:30 的自动草稿不会覆盖管理员 06:00 的编辑」的**唯一**保证，
 *    也是为什么不需要逐条 diff —— 不是 DRAFT 就整份不动。
 * 2. **整份重算**，不是增量。因为只有 DRAFT 才会走到这里，
 *    而 DRAFT 意味着「没有任何人动过」，重算就是等价且更简单的做法：
 *    它顺带处理了「某条候选后来被撤下」这种情况（增量做不到）。
 * 3. **没有候选时不替换**。否则一次上游故障（候选查询返回空）
 *    会把一份已经生成好的草稿清空。
 *
 * ── ⚠ 追赶（catch-up）：worker 停机错过 08:00 会怎样 ─────────────────
 * `scheduler.ts` 对**当天已经过去**的槽位会补跑。这是刻意的：
 * 所有会被补跑的动作都以**人的决定**为前提 ——
 * `publishIfScheduled` 只发 `SCHEDULED`，而 `SCHEDULED` 只能由管理员排期。
 * 因此「补跑」不可能把一份没审过的日报发出去。
 * 08:00 是**目标时刻**，不是有效期。
 *
 * ⚠ 但**不回溯历史**：worker 停机两天后重启，只会处理**当天**的槽位，
 * 中间那两天的期次不会被补发。日报是当日产品，补发一份两天前的日报
 * 没有意义（`docs/10` 也没有要求）。已记入 HANDOFF。
 */

import { Inject, Injectable } from '@nestjs/common';
import { DAILY_TARGET_PUBLISH_HOUR, DailyEditionStatus } from '@signal/contracts';
import { businessTimeToUtc } from '@signal/config';
import type { Logger } from '@signal/logger';
import { compileDraft, type CompiledDraft } from './draft-compiler';
import {
  PUBLISHING_NOTIFIER,
  PublishingNotificationType,
  type PublishingNotifier,
} from './notifier';
import { preflightEdition, type PreflightIssue } from './preflight';
import { PUBLISHING_REPOSITORY, type PublishingRepository } from './publishing.repository';
import { PUBLISHING_CLOCK, type PublishingClock } from './clock';

/** 注入 token：日志。 */
export const PUBLISHING_LOGGER = 'PUBLISHING_LOGGER';

/** 一次候选查询的上限（与仓储的 `CANDIDATE_QUERY_LIMIT` 一致）。 */
export const CANDIDATE_LIMIT = 300;

/** `initDraft` 的结果。 */
export type InitDraftResult = {
  editionId: string;
  businessDate: string;
  status: DailyEditionStatus;
  /** 本次调用是否真的创建了期次（`false` = 之前就存在）。 */
  created: boolean;
};

/** `generateDraft` 的结果。 */
export type GenerateDraftResult = {
  businessDate: string;
  editionId: string;
  /** 是否真的写入了草稿内容。 */
  generated: boolean;
  /** 没生成的原因（`generated: false` 时有值）。 */
  skippedReason: 'NOT_DRAFT' | 'NO_CANDIDATES' | null;
  status: DailyEditionStatus;
  sectionCount: number;
  itemCount: number;
  /** 候选没进草稿的原因（见 `draft-compiler.ts`）。 */
  notes: CompiledDraft['notes'];
};

/** 定时发布的结果。 */
export type PublishOutcome = {
  businessDate: string;
  published: boolean;
  /**
   * `CANCELLED` 与 `NOT_SCHEDULED` 分开：
   * 前者是「管理员主动取消了」（**不发提醒**），
   * 后者是「他忘了排期」（**要提醒**）。运维面板据此区分
   * 「今天本该有报纸但没出」与「今天本来就没有报纸」。
   */
  reason:
    | 'PUBLISHED'
    | 'ALREADY_PUBLISHED'
    | 'NO_EDITION'
    | 'NOT_SCHEDULED'
    | 'CANCELLED'
    | 'PREFLIGHT_FAILED';
  editionNo: number | null;
  issues: PreflightIssue[];
};

/** 07:30 提醒的结果。 */
export type ReminderOutcome = {
  businessDate: string;
  /** 是否**本次**新写了通知（幂等：之前写过则为 `false`）。 */
  notified: boolean;
  reason: 'NOTIFIED' | 'ALREADY_NOTIFIED' | 'NO_EDITION' | 'ALREADY_REVIEWING' | 'CANCELLED';
};

@Injectable()
export class PublishingService {
  constructor(
    @Inject(PUBLISHING_REPOSITORY) private readonly repository: PublishingRepository,
    @Inject(PUBLISHING_NOTIFIER) private readonly notifier: PublishingNotifier,
    @Inject(PUBLISHING_CLOCK) private readonly clock: PublishingClock,
    @Inject(PUBLISHING_LOGGER) private readonly logger: Logger,
  ) {}

  /* ---------------------------------------------------------------- */
  /* 00:10 —— 初始化当天 DRAFT                                          */
  /* ---------------------------------------------------------------- */

  /**
   * 确保当天的空草稿存在。
   *
   * **不碰任何内容**：只建一行 `DRAFT`。填内容的是 05:30 那一趟。
   * 这样「建期次」与「填内容」是两个独立可重试的动作，
   * 早上 05:30 的失败不会连带影响 00:10 的成果。
   */
  async initDraft(businessDate: string): Promise<InitDraftResult> {
    const before = await this.repository.findEdition(businessDate);
    const edition = await this.repository.ensureDraft(businessDate);

    return {
      editionId: edition.editionId,
      businessDate,
      status: edition.status,
      created: before === null,
    };
  }

  /* ---------------------------------------------------------------- */
  /* 05:30 / 07:00 —— 生成与刷新草稿                                    */
  /* ---------------------------------------------------------------- */

  async generateDraft(businessDate: string): Promise<GenerateDraftResult> {
    // 期次不存在时**补建**而不是失败：00:10 那一趟可能因为 worker 停机而没跑，
    // 而「因为没建期次所以今天没有日报」是没人能接受的失败方式。
    const edition = await this.repository.ensureDraft(businessDate);

    // ── 安全性质 1：只写 DRAFT ──────────────────────────────────────
    if (edition.status !== DailyEditionStatus.DRAFT) {
      return {
        businessDate,
        editionId: edition.editionId,
        generated: false,
        skippedReason: 'NOT_DRAFT',
        status: edition.status,
        sectionCount: 0,
        itemCount: 0,
        notes: [],
      };
    }

    const { startUtc, endUtc } = candidateWindow(businessDate);
    const candidates = await this.repository.findCandidates({
      startUtc,
      endUtc,
      limit: CANDIDATE_LIMIT,
    });

    const compiled = compileDraft(candidates);

    // ── 安全性质 3：没有候选时不替换 ────────────────────────────────
    if (compiled.sections.length === 0) {
      // 注意这里**不报错**：早上 05:30 候选为空是正常现象
      //（例如所有来源都还没采到东西），不是故障。
      this.logger.warn(
        { businessDate, candidateCount: candidates.length, errorCode: 'PUBLISHING_NO_CANDIDATES' },
        'daily draft generation produced no sections; leaving the existing draft untouched',
      );
      return {
        businessDate,
        editionId: edition.editionId,
        generated: false,
        skippedReason: 'NO_CANDIDATES',
        status: edition.status,
        sectionCount: 0,
        itemCount: 0,
        notes: compiled.notes,
      };
    }

    // ── 安全性质 2：整份重算 ────────────────────────────────────────
    await this.repository.replaceSections(edition.editionId, compiled.sections);

    const itemCount = compiled.sections.reduce((total, s) => total + s.items.length, 0);

    this.logger.info(
      {
        businessDate,
        editionId: edition.editionId,
        candidateCount: candidates.length,
        sectionCount: compiled.sections.length,
        itemCount,
        noteCount: compiled.notes.length,
      },
      'daily draft generated',
    );

    return {
      businessDate,
      editionId: edition.editionId,
      generated: true,
      skippedReason: null,
      status: edition.status,
      sectionCount: compiled.sections.length,
      itemCount,
      notes: compiled.notes,
    };
  }

  /* ---------------------------------------------------------------- */
  /* 07:30 —— 未 REVIEWING 则提醒管理员                                 */
  /* ---------------------------------------------------------------- */

  async remindIfNotReviewing(businessDate: string): Promise<ReminderOutcome> {
    const edition = await this.repository.findEdition(businessDate);
    if (edition === null) {
      return { businessDate, notified: false, reason: 'NO_EDITION' };
    }
    if (edition.status === DailyEditionStatus.CANCELLED) {
      // 管理员已经明确取消了这一期 —— 再提醒他是噪音。
      return { businessDate, notified: false, reason: 'CANCELLED' };
    }
    if (
      edition.status === DailyEditionStatus.REVIEWING ||
      edition.status === DailyEditionStatus.SCHEDULED ||
      edition.status === DailyEditionStatus.PUBLISHED
    ) {
      return { businessDate, notified: false, reason: 'ALREADY_REVIEWING' };
    }

    // 走到这里 status 必然是 DRAFT（`docs/05` 只有五个状态，
    // 上面已经排除了四个；`Record` 式的穷尽判断由类型系统保证）。
    const notified = await this.notifier.notify({
      type: PublishingNotificationType.DAILY_REVIEW_PENDING,
      title: `日报 ${businessDate} 还未审核`,
      body:
        `到 ${REVIEW_ALERT_LABEL} 时，${businessDate} 这一期仍是草稿（没有进入 REVIEWING）。` +
        `未审核的日报不会在 08:00 自动发布，请尽快在后台确认。`,
      targetUrl: dailyAdminUrl(businessDate),
    });

    return {
      businessDate,
      notified,
      reason: notified ? 'NOTIFIED' : 'ALREADY_NOTIFIED',
    };
  }

  /* ---------------------------------------------------------------- */
  /* 08:00 —— 只有 SCHEDULED 才发布                                     */
  /* ---------------------------------------------------------------- */

  async publishIfScheduled(businessDate: string): Promise<PublishOutcome> {
    const edition = await this.repository.findEdition(businessDate);
    if (edition === null) {
      return {
        businessDate,
        published: false,
        reason: 'NO_EDITION',
        editionNo: null,
        issues: [],
      };
    }

    if (edition.status === DailyEditionStatus.PUBLISHED) {
      return {
        businessDate,
        published: false,
        reason: 'ALREADY_PUBLISHED',
        editionNo: edition.editionNo,
        issues: [],
      };
    }

    // ⚠ **已取消的期次不发提醒。**
    //
    // 「08:00 没发布」这条通知的用途是「你今天漏了一件事」。
    // 而取消是管理员**主动的决定** —— 再提醒他一次是纯噪音，
    // 而且会稀释那条通知的信噪比（真正漏掉的那天就不显眼了）。
    // 与 `remindIfNotReviewing` 对 CANCELLED 的处理同一取舍。
    //
    // 这一条是本模块自查时补的：第一版对 CANCELLED 也发
    // `DAILY_NOT_PUBLISHED`，因为判断写成了「不是 SCHEDULED 就提醒」。
    if (edition.status === DailyEditionStatus.CANCELLED) {
      return {
        businessDate,
        published: false,
        reason: 'CANCELLED',
        editionNo: null,
        issues: [],
      };
    }

    // `docs/10`：**未审核保持草稿**。到点还没排期就不发，并且要让管理员知道。
    if (edition.status !== DailyEditionStatus.SCHEDULED) {
      await this.notifier.notify({
        type: PublishingNotificationType.DAILY_NOT_PUBLISHED,
        title: `日报 ${businessDate} 未按时发布`,
        body:
          `08:00 到了，但 ${businessDate} 这一期仍是 ${edition.status}（不是 SCHEDULED），` +
          `因此**没有发布**。已审核的期次需先排期才会在 08:00 上线。`,
        targetUrl: dailyAdminUrl(businessDate),
      });

      return {
        businessDate,
        published: false,
        reason: 'NOT_SCHEDULED',
        editionNo: null,
        issues: [],
      };
    }

    const snapshot = await this.repository.snapshot(edition.editionId);
    if (snapshot === null) {
      return {
        businessDate,
        published: false,
        reason: 'NO_EDITION',
        editionNo: null,
        issues: [],
      };
    }

    const preflight = preflightEdition(snapshot);
    if (!preflight.ok) {
      // `docs/10` 的 preflight「只报告不修」：自动挑一条当 LEAD 会让
      // 「发布」变成一个会改变内容的动作。后果是这一期今天发不出去 ——
      // 所以必须让管理员知道**为什么**，否则他只会看到一份没上线的日报。
      await this.notifier.notify({
        type: PublishingNotificationType.DAILY_PREFLIGHT_BLOCKED,
        title: `日报 ${businessDate} 发布前校验未通过`,
        body:
          `发布前校验发现 ${String(preflight.issues.length)} 个问题，因此没有发布：` +
          preflight.issues.map((issue) => issue.message).join('；'),
        targetUrl: dailyAdminUrl(businessDate),
      });

      this.logger.warn(
        {
          businessDate,
          editionId: edition.editionId,
          issueCount: preflight.issues.length,
          reasons: preflight.issues.map((issue) => issue.reason),
        },
        'daily publish blocked by preflight',
      );

      return {
        businessDate,
        published: false,
        reason: 'PREFLIGHT_FAILED',
        editionNo: null,
        issues: preflight.issues,
      };
    }

    const publishedCount = await this.repository.countPublished();
    const marked = await this.repository.markPublished(edition.editionId, {
      // 期号在**发布时间**分配（`docs/10`）：取消的草稿不占号。
      editionNo: publishedCount + 1,
      publishedAt: this.clock.now(),
    });

    if (marked === null) {
      // 在读数与写之间别人先发布了（管理员手动发布 / 另一个实例）。
      // **不是错误** —— 目标状态已经达成。
      return {
        businessDate,
        published: false,
        reason: 'ALREADY_PUBLISHED',
        editionNo: null,
        issues: [],
      };
    }

    this.logger.info(
      { businessDate, editionId: edition.editionId, editionNo: marked.editionNo },
      'daily edition published',
    );

    return {
      businessDate,
      published: true,
      reason: 'PUBLISHED',
      editionNo: marked.editionNo,
      issues: [],
    };
  }
}

/* ------------------------------------------------------------------ */
/* 纯函数                                                              */
/* ------------------------------------------------------------------ */

/** 一次草稿的候选窗口（`[startUtc, endUtc)`，UTC）。 */
export function candidateWindow(businessDate: string): { startUtc: Date; endUtc: Date } {
  // ⚠ `docs/10` 只写了候选要「在业务窗口内」，**没有定义窗口**。
  //
  // 取「该业务日 08:00 之前的 24 小时」（`[D-1 08:00, D 08:00)` 上海时间），
  // 理由：
  //   1. 它与**发布时刻**对齐，因此「一天报一天的事」这个语义是直的 ——
  //      昨天 08:00 之后发生的事情，今天早上发出来；
  //   2. 它是**按业务日固定的**，不随「这一趟调度几点跑」变化。
  //      否则 05:30 与 07:00 两趟会看到两个不同的窗口，
  //      而 07:00 的「刷新」就可能把 05:30 选中的东西刷掉；
  //   3. 它自然地向后滚动：昨天 09:00 的内容不在**昨天**那一期里
  //      （那时还没发生），但会在**今天**这一期里 —— 一天的新闻只上一次报。
  //
  // 已记入 HANDOFF 的设计取舍（契约未定义，此处是取值决定）。
  const endUtc = businessTimeToUtc(businessDate, DAILY_TARGET_PUBLISH_HOUR);
  const startUtc = new Date(endUtc.getTime() - 24 * 60 * 60 * 1000);
  return { startUtc, endUtc };
}

/** 后台那一期的地址（通知的 `targetUrl`，同时用作幂等键）。 */
export function dailyAdminUrl(businessDate: string): string {
  // 相对路径而不是拼 `APP_BASE_URL`：通知是**后台**看的，
  // 而后台的域名与公开站可能不同（`docs/16` 的部署形态）。
  // 相对路径在两种部署下都成立。
  return `/admin/daily/${businessDate}`;
}

/** 07:30 的可读标签（用在通知正文里）。 */
const REVIEW_ALERT_LABEL = '07:30';
