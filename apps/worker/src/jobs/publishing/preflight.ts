/**
 * 日报发布前校验（`docs/10` 的 Publish Preflight）。
 *
 * 纯函数：输入「这一期的快照」，输出「能不能发布 / 有哪些问题」。
 * 副作用（读库、写状态）留给 service。
 *
 * ── `docs/10` 的原文 ────────────────────────────────────────────────
 * ```text
 * 发布前：
 *   至少一个 LEAD
 *   businessDate 存在
 *   item Content 存在且未 REJECTED
 *   source / originalUrl 完整
 *   section/item sortOrder 无冲突
 * ```
 *
 * 最后一条（sortOrder 无冲突）在**数据库层**由
 * `@@unique([editionId, sortOrder])` 与 `@@unique([sectionId, sortOrder])` 兜底；
 * 这里再做一次是为了**在发布前**给出可读的错误，而不是让发布那一刻抛 P2002。
 *
 * ── ⚠⚠ 本文件有**两份逐字相同的副本**，改一份必须改另一份 ──────────────
 *
 * ```text
 * apps/api/src/modules/daily/preflight.ts        ← 手动发布（管理员点「立即发布」）
 * apps/worker/src/jobs/publishing/preflight.ts   ← 定时发布（08:00 的 daily-publish）
 * ```
 *
 * 为什么不能只有一份：`apps/api/src/**` 与 `apps/worker/src/**` 是两个独立的
 * tsconfig 工程，跨 app import 会触发 `TS6059`（Agent 04 提取
 * `packages/source-core` 时踩过，Agent 07 的 `scoring.ts` 也因此各留一份）。
 * 按 §7 不擅自改公共契约，所以也不把它塞进 `packages/contracts`。
 *
 * 后果**必须被守住**：手动发布与定时发布如果用两套规则，
 * 会出现「管理员点得动、定时跑不动」（或反过来）这种最难查的 bug ——
 * 因为两条路径都「正常工作」。因此有一道**跨 app 的静态守卫**：
 *
 * ```text
 * apps/api/test/daily-preflight-parity.spec.ts
 * ```
 *
 * 它逐行比对两份文件的正文，只允许「模块路径」不同（import 深度不一样）。
 * 改了一份忘了另一份 → 直接变红。
 *
 * ── 为什么问题码叫 `reason` 而不叫 `code` ───────────────────────────
 * `apps/api/test/auth-contract.spec.ts` 有一条静态守卫：源码里任何
 * `code: 'SOMETHING'` 字面量都必须登记进 `packages/contracts` 的错误码注册表。
 * 而 preflight 的问题是**校验结论**，不是 HTTP 错误码 ——
 * 把它们塞进错误码注册表会像 Agent 07 说的一样「让错误码这个概念失去边界」。
 * 所以这里用 `reason`，语义也更准（它是一个理由，不是一次失败的错误码）。
 */

import { DailyDisplayStyle } from '@signal/contracts';

/** 待发布的某一期（从库里读出来的快照）。 */
export type EditionSnapshot = {
  businessDate: string;
  status: string;
  sections: {
    sectionId: string;
    type: string;
    title: string;
    sortOrder: number;
    items: {
      itemId: string;
      contentId: string;
      displayStyle: DailyDisplayStyle;
      sortOrder: number;
      /** 内容本身的状态与必备字段。 */
      contentExists: boolean;
      contentStatus: string | null;
      sourceName: string | null;
      originalUrl: string | null;
    }[];
  }[];
};

/**
 * 问题码（机器可读，供前端定位与文案映射）。
 *
 * 用 `as const` 而不是 enum：它是**本模块的输出值**，不是跨模块契约，
 * 不需要进 `@signal/contracts`。
 */
export const PreflightReason = {
  MISSING_BUSINESS_DATE: 'MISSING_BUSINESS_DATE',
  EMPTY_EDITION: 'EMPTY_EDITION',
  LEAD_REQUIRED: 'LEAD_REQUIRED',
  TOO_MANY_LEADS: 'TOO_MANY_LEADS',
  CONTENT_MISSING: 'CONTENT_MISSING',
  CONTENT_NOT_PUBLISHABLE: 'CONTENT_NOT_PUBLISHABLE',
  SOURCE_MISSING: 'SOURCE_MISSING',
  ORIGINAL_URL_MISSING: 'ORIGINAL_URL_MISSING',
  ITEM_SORT_ORDER_CONFLICT: 'ITEM_SORT_ORDER_CONFLICT',
  SECTION_SORT_ORDER_CONFLICT: 'SECTION_SORT_ORDER_CONFLICT',
} as const;

export type PreflightReasonValue = (typeof PreflightReason)[keyof typeof PreflightReason];

export type PreflightIssue = {
  /** 机器可读的原因（供前端定位）。 */
  reason: PreflightReasonValue;
  message: string;
  /** 出问题的具体对象（section / item）。 */
  target?: Record<string, string>;
};

export type PreflightResult = {
  ok: boolean;
  issues: PreflightIssue[];
};

/** `docs/10`：Lead 只有 1 条。 */
export const MAX_LEAD_ITEMS = 1;

/**
 * 发布前校验。
 *
 * **只报告不修**：`docs/10` 要求「未审核保持草稿」，
 * 自动修复（例如自动挑一条当 Lead）会让「发布」变成一个会改变内容的动作，
 * 而管理员以为它只是「发出去」。
 */
export function preflightEdition(snapshot: EditionSnapshot): PreflightResult {
  const issues: PreflightIssue[] = [];

  if (snapshot.businessDate === '') {
    issues.push({
      reason: PreflightReason.MISSING_BUSINESS_DATE,
      message: 'Edition has no businessDate',
    });
  }

  const items = snapshot.sections.flatMap((section) =>
    section.items.map((item) => ({ section, item })),
  );

  if (items.length === 0) {
    issues.push({ reason: PreflightReason.EMPTY_EDITION, message: 'Edition has no items' });
  }

  // 至少一个 LEAD（`docs/10` 的第一条）。
  const leads = items.filter(({ item }) => item.displayStyle === DailyDisplayStyle.LEAD);
  if (leads.length === 0) {
    issues.push({
      reason: PreflightReason.LEAD_REQUIRED,
      message: 'At least one item must use the LEAD display style',
    });
  } else if (leads.length > MAX_LEAD_ITEMS) {
    issues.push({
      reason: PreflightReason.TOO_MANY_LEADS,
      message: `Only ${MAX_LEAD_ITEMS} LEAD item is allowed (found ${leads.length})`,
    });
  }

  // 逐条检查内容。
  for (const { section, item } of items) {
    const target = { sectionId: section.sectionId, itemId: item.itemId, contentId: item.contentId };

    if (!item.contentExists) {
      issues.push({
        reason: PreflightReason.CONTENT_MISSING,
        message: 'Item references a deleted content',
        target,
      });
      continue;
    }
    // **REJECTED / ARCHIVED 的 Content 会阻断发布**（任务书的「REJECTED 阻断」）。
    if (item.contentStatus === 'REJECTED' || item.contentStatus === 'ARCHIVED') {
      issues.push({
        reason: PreflightReason.CONTENT_NOT_PUBLISHABLE,
        message: `Item content is ${item.contentStatus}`,
        target,
      });
    }
    // 「source / originalUrl 完整」。
    if (item.sourceName === null || item.sourceName === '') {
      issues.push({
        reason: PreflightReason.SOURCE_MISSING,
        message: 'Item content has no source',
        target,
      });
    }
    if (item.originalUrl === null || item.originalUrl === '') {
      issues.push({
        reason: PreflightReason.ORIGINAL_URL_MISSING,
        message: 'Item content has no originalUrl',
        target,
      });
    }
  }

  // sortOrder 冲突 —— DB 层有唯一约束兜底，这里提前给出可读错误。
  for (const section of snapshot.sections) {
    const orders = section.items.map((item) => item.sortOrder);
    if (new Set(orders).size !== orders.length) {
      issues.push({
        reason: PreflightReason.ITEM_SORT_ORDER_CONFLICT,
        message: 'Two items in the same section share a sortOrder',
        target: { sectionId: section.sectionId },
      });
    }
  }
  const sectionOrders = snapshot.sections.map((section) => section.sortOrder);
  if (new Set(sectionOrders).size !== sectionOrders.length) {
    issues.push({
      reason: PreflightReason.SECTION_SORT_ORDER_CONFLICT,
      message: 'Two sections share a sortOrder',
    });
  }

  return { ok: issues.length === 0, issues };
}

/**
 * 发布时的期号分配：`NO.001` 起（`docs/10`）。
 *
 * ⚠ **只在真正发布时占号**（`docs/10`）—— 取消的草稿不占号，
 * 因此期号是「已发布期数 + 1」而不是「本期是第几期」。
 */
export function nextEditionNo(publishedCount: number): number {
  return publishedCount + 1;
}

/** 期号的展示格式（`docs/10`：第一期 `NO.001`）。 */
export function formatEditionNo(editionNo: number): string {
  return `NO.${String(editionNo).padStart(3, '0')}`;
}
