/**
 * 六维评分 —— `docs/08` 的权重与阈值。
 *
 * ```text
 * importance            25%
 * relevance             20%
 * credibility           20%
 * novelty               15%
 * information density   10%
 * read value            10%
 * ```
 *
 * ── 为什么用整数运算而不是直接加权平均 ──────────────────────────────
 * 各维分数落库精度是 `DECIMAL(4,1)`（一位小数），final 是 `DECIMAL(5,2)`。
 * 浮点直接相加会出现 `0.1 + 0.2 = 0.30000000000000004` 这类结果，
 * 于是「内存里算出的分数」与「写进库里的分数」在末位不一致 ——
 * 而 `finalScore` 是 Agent 07 审核列表的排序键、Agent 10 前台的门槛，
 * 末位漂移会让「同一份数据重算一次排名就变了」。
 *
 * 所以全程用整数：分数量化成「十分之一分」的整数（85.0 → 850），
 * 权重是整数百分比，乘积之和再除回去。**结果对同样的输入永远是同一个数**。
 *
 * ── 阈值（docs/08）────────────────────────────────────────────────
 * ```text
 * >= 85        一级候选
 * 70 – 84.99   推荐
 * 55 – 69.99   普通
 * < 55         默认不进入高优先审核列表
 * ```
 * 「低分不删除」—— 本模块从不在任何路径上删内容，档位只是**排序/筛选**用的派生值，
 * 不落库（因此也不需要新增枚举，不触碰公共契约）。
 */

import type { AiTaskType } from '@signal/contracts';

/* ------------------------------------------------------------------ */
/* 权重                                                                */
/* ------------------------------------------------------------------ */

/** 六个维度名。 */
export const SCORE_DIMENSIONS = [
  'importance',
  'relevance',
  'credibility',
  'novelty',
  'density',
  'readValue',
] as const;

export type ScoreDimension = (typeof SCORE_DIMENSIONS)[number];

/**
 * 权重（百分比）。**和必须为 100** —— 有测试直接断言这一点，
 * 因为改权重时漏改一项会让所有分数整体缩放，且没有任何报错。
 */
export const SCORE_WEIGHTS: Readonly<Record<ScoreDimension, number>> = {
  importance: 25,
  relevance: 20,
  credibility: 20,
  novelty: 15,
  density: 10,
  readValue: 10,
};

/** 分数取值范围。 */
export const SCORE_MIN = 0;
export const SCORE_MAX = 100;

/** 各维分数量化步长：落库精度是一位小数。 */
const SCORE_TENTHS_PER_POINT = 10;

/* ------------------------------------------------------------------ */
/* 档位                                                                */
/* ------------------------------------------------------------------ */

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
 * 注意边界是**下界含、上界不含**：85.00 是 TOP_CANDIDATE，84.99 是 RECOMMENDED。
 * `docs/08` 写的是 `>=85` / `70–84.99`，两种写法在这里必须一致。
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

/* ------------------------------------------------------------------ */
/* 计算                                                                */
/* ------------------------------------------------------------------ */

/** 六维原始分数（0–100，一位小数）。 */
export type DimensionScores = Readonly<Record<ScoreDimension, number>>;

/** 把分数收敛到合法区间 —— 模型偶尔会给出 105 或 -3。 */
function clampScore(value: number): number {
  if (!Number.isFinite(value)) return SCORE_MIN;
  return Math.min(SCORE_MAX, Math.max(SCORE_MIN, value));
}

/** 量子化到一位小数，避免 `69.99999999` 掉进错误的档位。 */
function quantizeToTenths(value: number): number {
  return Math.round(clampScore(value) * SCORE_TENTHS_PER_POINT);
}

/**
 * 六维加权求和。
 *
 * 全程整数：
 * `finalScore = Σ(分数量化值 × 权重) / (10 × 100)`
 * 结果保留 2 位小数 —— 对齐 `contents.final_score` 的 `DECIMAL(5,2)`。
 */
export function computeFinalScore(scores: DimensionScores): number {
  let weightedSum = 0;
  for (const dimension of SCORE_DIMENSIONS) {
    weightedSum += quantizeToTenths(scores[dimension]) * SCORE_WEIGHTS[dimension];
  }
  // 分母 = 10（量化）× 100（权重是百分比）
  const exact = weightedSum / 1000;
  return Math.round(exact * 100) / 100;
}

/** 一次完整的评分结果。 */
export type ScoreResult = {
  dimensions: DimensionScores;
  finalScore: number;
  band: ScoreBand;
};

/** 计算完整评分（六维 + final + 档位）。 */
export function scoreContent(scores: DimensionScores): ScoreResult {
  const normalized: Record<ScoreDimension, number> = {
    importance: clampScore(scores.importance),
    relevance: clampScore(scores.relevance),
    credibility: clampScore(scores.credibility),
    novelty: clampScore(scores.novelty),
    density: clampScore(scores.density),
    readValue: clampScore(scores.readValue),
  };
  const finalScore = computeFinalScore(normalized);
  return { dimensions: normalized, finalScore, band: scoreBand(finalScore) };
}

/* ------------------------------------------------------------------ */
/* 落库映射                                                            */
/* ------------------------------------------------------------------ */

/**
 * 分数 → `contents` 的列名映射。
 *
 * ⚠ 这张表**只包含分数列**。它刻意不包含 `pipelineStatus` ——
 * 状态机由 Agent 05（流水线 Owner）推进，AI 不碰。
 * 也刻意不包含任何 `sources` 的列 —— `docs/08`：
 * 「AI 不能修改 Source Tier / 不能自己宣布某来源官方」。
 * `ai-score-write-scope.spec.ts` 会断言这一点有牙齿。
 */
export const CONTENT_SCORE_COLUMNS = {
  importance: 'importanceScore',
  relevance: 'relevanceScore',
  credibility: 'credibilityScore',
  novelty: 'noveltyScore',
  density: 'densityScore',
  readValue: 'readValueScore',
} as const satisfies Record<ScoreDimension, string>;

/** 分数结果 → `contents` 更新对象（仅分数列 + finalScore）。 */
export function toContentScoreUpdate(result: ScoreResult): {
  importanceScore: number;
  relevanceScore: number;
  credibilityScore: number;
  noveltyScore: number;
  densityScore: number;
  readValueScore: number;
  finalScore: number;
} {
  return {
    importanceScore: result.dimensions.importance,
    relevanceScore: result.dimensions.relevance,
    credibilityScore: result.dimensions.credibility,
    noveltyScore: result.dimensions.novelty,
    densityScore: result.dimensions.density,
    readValueScore: result.dimensions.readValue,
    finalScore: result.finalScore,
  };
}

/** 该任务是否产出六维分数（用于决定是否写分数列）。 */
export function taskProducesScores(taskType: AiTaskType): boolean {
  // 目前只有 SCORE 产出六维分数；其余任务各自落 AiRun + aiAnalysis。
  return taskType === 'SCORE';
}
