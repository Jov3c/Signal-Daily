/**
 * 六维评分与档位的守卫（`docs/08`）。
 *
 * 重点覆盖三类容易静默出错的地方：
 * 1. **权重和必须为 100** —— 漏改一项会让所有分数整体缩放，且没有任何报错。
 * 2. **整数运算的确定性** —— 浮点会让「同一份数据重算一次排名就变了」。
 * 3. **档位边界** —— `>= 85` 与 `70–84.99` 两种写法必须落在同一条线上。
 */

import { describe, expect, it } from 'vitest';
import {
  SCORE_BANDS,
  SCORE_BAND_THRESHOLDS,
  SCORE_DIMENSIONS,
  SCORE_WEIGHTS,
  computeFinalScore,
  isHighPriority,
  scoreBand,
  scoreContent,
  toContentScoreUpdate,
} from '../src/jobs/ai/scoring';

const ALL = (value: number): Record<(typeof SCORE_DIMENSIONS)[number], number> => ({
  importance: value,
  relevance: value,
  credibility: value,
  novelty: value,
  density: value,
  readValue: value,
});

describe('六维权重', () => {
  it('所有权重之和恰好是 100', () => {
    const sum = SCORE_DIMENSIONS.reduce((acc, dimension) => acc + SCORE_WEIGHTS[dimension], 0);
    expect(sum).toBe(100);
  });

  it('权重与 docs/08 逐项一致', () => {
    expect(SCORE_WEIGHTS).toEqual({
      importance: 25,
      relevance: 20,
      credibility: 20,
      novelty: 15,
      density: 10,
      readValue: 10,
    });
  });

  it('每个维度都有权重（没有漏定义的维度）', () => {
    for (const dimension of SCORE_DIMENSIONS) {
      expect(typeof SCORE_WEIGHTS[dimension]).toBe('number');
    }
  });
});

describe('finalScore 计算', () => {
  it('六维全 100 → 100', () => {
    expect(computeFinalScore(ALL(100))).toBe(100);
  });

  it('六维全 0 → 0', () => {
    expect(computeFinalScore(ALL(0))).toBe(0);
  });

  it('六维全 90 → 90（权重归一）', () => {
    expect(computeFinalScore(ALL(90))).toBe(90);
  });

  it('只有 importance 满分 → 25（权重生效）', () => {
    expect(computeFinalScore({ ...ALL(0), importance: 100 })).toBe(25);
  });

  it('只有 credibility 满分 → 20（权重生效）', () => {
    expect(computeFinalScore({ ...ALL(0), credibility: 100 })).toBe(20);
  });

  it('保留两位小数，且是四舍五入而不是截断', () => {
    // 85.5 * 0.25 = 21.375 → 21.38
    expect(computeFinalScore({ ...ALL(0), importance: 85.5 })).toBe(21.38);
  });

  it('同样的输入永远得到同一个数（整数运算，无浮点漂移）', () => {
    const scores = {
      importance: 87.3,
      relevance: 71.9,
      credibility: 93.1,
      novelty: 64.7,
      density: 55.5,
      readValue: 78.2,
    };
    const first = computeFinalScore(scores);
    for (let index = 0; index < 50; index += 1) {
      expect(computeFinalScore(scores)).toBe(first);
    }
    // 同时确认结果确实落在两位小数以内。
    // ⚠ 这里用 `toFixed(2)` 而不是 `Math.round(first * 100) / 100` ——
    // 后者本身就是一次浮点乘法（`77.9 * 100 = 7790.000000000001`），
    // 拿它当「两位小数」的判据会先把自己算错。
    expect(Number(first.toFixed(2))).toBe(first);
  });

  it('超范围输入被收敛到 [0,100] 而不是溢出', () => {
    expect(computeFinalScore(ALL(105))).toBe(100);
    expect(computeFinalScore(ALL(-3))).toBe(0);
  });

  it('NaN / Infinity 一律收敛为 0，不会被当成满分', () => {
    // ⚠ 这一条是有意取「向下收敛」的：`Infinity` 若是被当成满分，
    // 一个上游返回畸形数字的模型就能把自己的 importance 顶到 100。
    // 宁可让畸形输入得到低分（可见、可查），也不要让它得到高分（静默、有害）。
    expect(computeFinalScore({ ...ALL(0), importance: Number.NaN })).toBe(0);
    expect(computeFinalScore({ ...ALL(0), importance: Number.POSITIVE_INFINITY })).toBe(0);
    expect(computeFinalScore({ ...ALL(0), importance: Number.NEGATIVE_INFINITY })).toBe(0);
  });
});

describe('档位（docs/08 阈值）', () => {
  it('阈值常量与文档一致', () => {
    expect(SCORE_BAND_THRESHOLDS).toEqual({
      TOP_CANDIDATE: 85,
      RECOMMENDED: 70,
      NORMAL: 55,
    });
  });

  it('边界值精确（下界含、上界不含）', () => {
    expect(scoreBand(100)).toBe('TOP_CANDIDATE');
    expect(scoreBand(85)).toBe('TOP_CANDIDATE');
    expect(scoreBand(84.99)).toBe('RECOMMENDED');
    expect(scoreBand(70)).toBe('RECOMMENDED');
    expect(scoreBand(69.99)).toBe('NORMAL');
    expect(scoreBand(55)).toBe('NORMAL');
    expect(scoreBand(54.99)).toBe('LOW');
    expect(scoreBand(0)).toBe('LOW');
  });

  it('档位取值只在契约的四个之内', () => {
    for (const band of SCORE_BANDS) {
      expect(['TOP_CANDIDATE', 'RECOMMENDED', 'NORMAL', 'LOW']).toContain(band);
    }
  });

  it('低分只是「不进高优先审核」，不是删除', () => {
    const result = scoreContent(ALL(10));
    expect(result.band).toBe('LOW');
    expect(isHighPriority(result.band)).toBe(false);
    // 分数仍然被完整算出并返回 —— 没有任何路径会丢掉内容
    expect(result.finalScore).toBe(10);
    expect(Object.keys(toContentScoreUpdate(result))).toContain('finalScore');
  });
});

describe('落库映射', () => {
  it('只映射分数列与 finalScore，不含任何状态或来源字段', () => {
    const update = toContentScoreUpdate(scoreContent(ALL(80)));
    expect(Object.keys(update).sort()).toEqual(
      [
        'credibilityScore',
        'densityScore',
        'finalScore',
        'importanceScore',
        'noveltyScore',
        'readValueScore',
        'relevanceScore',
      ].sort(),
    );
  });

  it('写入的值与计算结果一致（不会写出未量化的中间值）', () => {
    const result = scoreContent({
      importance: 87.34,
      relevance: 70.06,
      credibility: 91.99,
      novelty: 60.5,
      density: 50.04,
      readValue: 79.95,
    });
    const update = toContentScoreUpdate(result);
    expect(update.finalScore).toBe(result.finalScore);
    expect(update.importanceScore).toBe(87.34);
  });
});
