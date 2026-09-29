/**
 * 分数档位 —— `docs/08` 的阈值。
 *
 * ```text
 * >= 85        一级候选
 * 70 – 84.99   推荐
 * 55 – 69.99   普通
 * < 55         默认不进入高优先审核列表
 * ```
 *
 * ── ⚠ 这是同一套阈值的**第二份实现** ────────────────────────────────
 * 第一份在 Agent 06 的 `apps/worker/src/jobs/ai/scoring.ts`，
 * 那边用它算 `finalScore` 与档位并落进 `ai_analysis`。
 *
 * 本模块**不能 import 它**：`apps/worker/src/**` 不在 `apps/api` 的
 * tsconfig 引用图里，跨 app import 会直接触发 `TS6059`
 *（Agent 04 在提取 `packages/source-core` 时踩过同一个坑）。
 *
 * 因此这里是一份**逐条对齐**的实现，`apps/api/test/admin-review-scoring.spec.ts`
 * 里有守卫钉住阈值与 `docs/08` 一致。**已提 CCR**，建议 Agent 14 把
 * 「分数档位」提到共享包（与 Agent 04 提取 source-core 同一思路），
 * 让 06 与 07 共用同一份。
 */

/** 档位取值（与 Agent 06 的 `SCORE_BANDS` 一致）。 */
export const SCORE_BANDS = ['TOP_CANDIDATE', 'RECOMMENDED', 'NORMAL', 'LOW'] as const;
export type ScoreBand = (typeof SCORE_BANDS)[number];

/** 阈值下界（含）。 */
export const SCORE_BAND_THRESHOLDS: Readonly<Record<Exclude<ScoreBand, 'LOW'>, number>> = {
  TOP_CANDIDATE: 85,
  RECOMMENDED: 70,
  NORMAL: 55,
};

/**
 * 由 `finalScore` 得到档位。
 *
 * 边界是**下界含、上界不含**：85.00 是 TOP_CANDIDATE，84.99 是 RECOMMENDED
 *（`docs/08` 写的是 `>=85` / `70–84.99`，两种写法必须落在同一条线上）。
 */
export function scoreBand(finalScore: number): ScoreBand {
  if (finalScore >= SCORE_BAND_THRESHOLDS.TOP_CANDIDATE) return 'TOP_CANDIDATE';
  if (finalScore >= SCORE_BAND_THRESHOLDS.RECOMMENDED) return 'RECOMMENDED';
  if (finalScore >= SCORE_BAND_THRESHOLDS.NORMAL) return 'NORMAL';
  return 'LOW';
}

/** `docs/08`：`< 55` 默认不进入高优先审核列表（但**不删除**）。 */
export function isHighPriority(band: ScoreBand): boolean {
  return band !== 'LOW';
}
