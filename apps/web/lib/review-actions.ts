/**
 * 审核动作名 —— **纯常量**，放在 `.ts` 里而不是元件文件里。
 *
 * ⚠ 两个理由：
 *
 * 1. **单条与批量的动作名不一样，这是最容易写错的一处**：
 *
 * ```text
 * 单条（后端 REVIEW_ACTIONS）  APPROVE_FEATURED / APPROVE_DAILY / APPROVE_BOTH / DEFER / REJECT
 * 批量（后端 BULK_REVIEW_ACTIONS）                                      DEFER / REJECT
 * ```
 *
 *    两者都叫 `DEFER` / `REJECT`（**不是** `DEFERRED` / `REJECTED` ——
 *    后者是 `EditorialReviewStatus` 的取值，是**结果**的过去式）。
 *    把状态名当动作名发出去，后端会以 400 拒绝，而那只有运行时才看得见。
 *
 * 2. 常量放在 `.ts` 里，测试就能**直接 import 它**去和后端的 dto 比对
 *   （`apps/web/test/contract-parity.spec.ts`）。放在 `.tsx` 元件文件里的话，
 *    根 vitest 配置跑不动 JSX（`tsconfig` 里 `jsx: preserve`），
 *    那条守卫就只能靠读文本 —— 而「读文本」是它要防的那类脆弱做法。
 */

/** 批量允许的两个动作（`docs/09`：「批量只允许 Reject/Defer」）。 */
export const BULK_REVIEW_ACTIONS = ['DEFER', 'REJECT'] as const;

export type BulkReviewAction = (typeof BULK_REVIEW_ACTIONS)[number];

/** 单条决策的五个动作（`docs/09` 的五个审核动作），顺序即界面顺序。 */
export const REVIEW_DECISIONS = [
  { action: 'APPROVE_FEATURED', label: '通过 · 进精选' },
  { action: 'APPROVE_DAILY', label: '通过 · 进日报' },
  { action: 'APPROVE_BOTH', label: '通过 · 两者都要' },
  { action: 'DEFER', label: '搁置' },
  { action: 'REJECT', label: '拒绝' },
] as const;
