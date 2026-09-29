/**
 * 近似判重的守卫 —— 重点在**中文**。
 *
 * Agent 01 的 FULLTEXT 事故就是「用纯 ASCII 探针测中文功能，一直显示绿」。
 * 这里所有用例都用真实中文正文；ASCII 用例只作为对照。
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SIMILARITY_THRESHOLD,
  MAX_SHINGLES_PER_DOCUMENT,
  findNearDuplicates,
  fingerprint,
  jaccard,
} from '../src/jobs/content/dedup/similarity';

/** 同一事件的两篇中文报道（措辞不同、事实相同）。 */
const SAME_EVENT_A = [
  'Anthropic 发布了新的模型能力评测报告，指出推理成本在 2026 年下降了约 40%。',
  '报告称这一下降主要来自推理优化与硬件迭代，业内普遍认为会加速 Agent 类产品落地。',
].join('');
const SAME_EVENT_B = [
  'Anthropic 发布最新模型能力评测报告，报告指出推理成本在 2026 年下降约 40%。',
  '分析认为成本下降来自推理优化和硬件迭代，将加速 Agent 类产品的落地进程。',
].join('');

/** 完全不同的事件。 */
const OTHER_EVENT = [
  '某开源项目宣布停止维护，作者在仓库 README 里说明了原因是维护成本过高。',
  '社区对该项目的未来走向存在分歧，有人提议 fork 后由社区接管。',
].join('');

describe('指纹：中文（核心）', () => {
  it('中文按字符二元组切分，而不是整句当一个 token', () => {
    const print = fingerprint('推理成本下降');
    expect(print.size).toBeGreaterThan(1);
    expect([...print.shingles]).toContain('c:推理');
    expect([...print.shingles]).toContain('c:成本');
    expect([...print.shingles]).toContain('c:下降');
  });

  it('标点处断开，不跨越标点产生假二元组', () => {
    const print = fingerprint('模型。推理');
    // 「型推」不是词，不该出现
    expect([...print.shingles]).not.toContain('c:型推');
    expect([...print.shingles]).toContain('c:模型');
    expect([...print.shingles]).toContain('c:推理');
  });

  it('同一段文字重复计算得到同一个指纹（确定性）', () => {
    expect([...fingerprint(SAME_EVENT_A).shingles].sort()).toEqual(
      [...fingerprint(SAME_EVENT_A).shingles].sort(),
    );
  });

  it('空 / null → 空指纹（表示「无法比较」，不是「不相似」）', () => {
    expect(fingerprint(null).size).toBe(0);
    expect(fingerprint('').size).toBe(0);
    expect(fingerprint('。，！？').size).toBe(0); // 只有标点
  });

  it('超长文本的指纹被截到上限（成本有界）', () => {
    const huge = '中文内容测试'.repeat(50_000);
    expect(fingerprint(huge).size).toBeLessThanOrEqual(MAX_SHINGLES_PER_DOCUMENT);
  });
});

describe('指纹：拉丁与混排', () => {
  it('拉丁词按词切分', () => {
    const print = fingerprint('OpenAI releases GPT-4');
    expect([...print.shingles]).toContain('w:openai');
    expect([...print.shingles]).toContain('w:gpt-4');
    expect([...print.shingles]).toContain('w:releases');
  });

  it('大小写归一', () => {
    expect([...fingerprint('AI Model').shingles].sort()).toEqual(
      [...fingerprint('ai model').shingles].sort(),
    );
  });

  it('全角字母归一成半角（中文正文里很常见）', () => {
    expect([...fingerprint('ＡＩ 模型').shingles]).toContain('w:ai');
  });

  it('中英混排：两种 shingle 共存', () => {
    const print = fingerprint('Anthropic 发布 Claude 新版本');
    expect([...print.shingles]).toContain('w:anthropic');
    expect([...print.shingles]).toContain('c:发布');
  });
});

describe('Jaccard', () => {
  it('完全相同 → 1', () => {
    const a = fingerprint(SAME_EVENT_A);
    expect(jaccard(a.shingles, a.shingles)).toBe(1);
  });

  it('完全无关 → 接近 0', () => {
    const score = jaccard(fingerprint(SAME_EVENT_A).shingles, fingerprint(OTHER_EVENT).shingles);
    expect(score).not.toBeNull();
    expect(score!).toBeLessThan(0.2);
  });

  it('**同一事件的不同措辞 → 高于阈值**（阈值校准的经验依据）', () => {
    const sameEvent = jaccard(
      fingerprint(SAME_EVENT_A).shingles,
      fingerprint(SAME_EVENT_B).shingles,
    );
    const unrelated = jaccard(
      fingerprint(SAME_EVENT_A).shingles,
      fingerprint(OTHER_EVENT).shingles,
    );

    expect(sameEvent).not.toBeNull();
    expect(unrelated).not.toBeNull();

    // ⚠ 这两条断言一起**钉住了阈值的校准依据**：
    // 实测「同一事件不同措辞」≈0.45、「无关」<0.2，而阈值是 0.35。
    // 若哪天指纹算法被改坏（例如中文退回整句当一个 token），
    // sameEvent 会掉到阈值以下 —— 这条会红。
    expect(sameEvent!).toBeGreaterThanOrEqual(DEFAULT_SIMILARITY_THRESHOLD);
    expect(unrelated!).toBeLessThan(DEFAULT_SIMILARITY_THRESHOLD);

    // 顺带钉住「两侧都留了余量」，避免有人把阈值调到贴着某一边
    expect(sameEvent! - DEFAULT_SIMILARITY_THRESHOLD).toBeGreaterThan(0.05);
    expect(DEFAULT_SIMILARITY_THRESHOLD - unrelated!).toBeGreaterThan(0.05);
  });

  it('任一方指纹为空 → null（无法比较，不是 0）', () => {
    expect(jaccard(fingerprint('中文').shingles, new Set())).toBeNull();
    expect(jaccard(new Set(), new Set())).toBeNull();
  });

  it('对称（jaccard(a,b) === jaccard(b,a)）', () => {
    const a = fingerprint(SAME_EVENT_A).shingles;
    const b = fingerprint(OTHER_EVENT).shingles;
    expect(jaccard(a, b)).toBe(jaccard(b, a));
  });
});

describe('findNearDuplicates', () => {
  const probe = { contentId: '100', sourceId: '7', text: SAME_EVENT_A };

  it('跨源相似 → 进 crossSourceMatches', () => {
    const verdict = findNearDuplicates(probe, [
      { contentId: '200', sourceId: '9', text: SAME_EVENT_B },
    ]);
    expect(verdict.crossSourceMatches).toHaveLength(1);
    expect(verdict.crossSourceMatches[0]).toMatchObject({ contentId: '200', sameSource: false });
    expect(verdict.sameSourceMatches).toHaveLength(0);
  });

  it('同源相似 → 进 sameSourceMatches（两类**分开**，语义不同）', () => {
    const verdict = findNearDuplicates(probe, [
      { contentId: '201', sourceId: '7', text: SAME_EVENT_B },
    ]);
    expect(verdict.sameSourceMatches).toHaveLength(1);
    expect(verdict.crossSourceMatches).toHaveLength(0);
  });

  it('不相似的候选被过滤掉', () => {
    const verdict = findNearDuplicates(probe, [
      { contentId: '300', sourceId: '9', text: OTHER_EVENT },
    ]);
    expect(verdict.crossSourceMatches).toHaveLength(0);
    expect(verdict.sameSourceMatches).toHaveLength(0);
    expect(verdict.comparedCount).toBe(1); // 比较过，只是没过阈值
  });

  it('不会把自己算成自己的近似重复', () => {
    const verdict = findNearDuplicates(probe, [
      { contentId: '100', sourceId: '7', text: SAME_EVENT_A },
    ]);
    expect(verdict.crossSourceMatches).toHaveLength(0);
    expect(verdict.comparedCount).toBe(0);
  });

  it('无法比较的候选**不计入** comparedCount（不是当作 0 相似度）', () => {
    const verdict = findNearDuplicates(probe, [
      { contentId: '400', sourceId: '9', text: null },
      { contentId: '401', sourceId: '9', text: '。，' },
    ]);
    expect(verdict.comparedCount).toBe(0);
  });

  it('多个匹配按相似度降序', () => {
    const verdict = findNearDuplicates(probe, [
      { contentId: '500', sourceId: '9', text: SAME_EVENT_A.slice(0, 60) },
      { contentId: '501', sourceId: '10', text: SAME_EVENT_B },
    ]);
    const scores = verdict.crossSourceMatches.map((m) => m.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });

  it('阈值可调（提高阈值 → 匹配变少）', () => {
    const candidates = [{ contentId: '600', sourceId: '9', text: SAME_EVENT_B }];
    const loose = findNearDuplicates(probe, candidates, DEFAULT_SIMILARITY_THRESHOLD);
    const strict = findNearDuplicates(probe, candidates, 0.95);
    expect(loose.crossSourceMatches.length).toBeGreaterThanOrEqual(strict.crossSourceMatches.length);
    expect(strict.crossSourceMatches).toHaveLength(0);
  });

  it('空候选列表 → 全空，不抛错', () => {
    expect(findNearDuplicates(probe, [])).toEqual({
      crossSourceMatches: [],
      sameSourceMatches: [],
      comparedCount: 0,
    });
  });

  it('**不做任何删除或标记** —— 返回的只是候选（多来源是资产，不是噪声）', () => {
    const verdict = findNearDuplicates(probe, [
      { contentId: '700', sourceId: '9', text: SAME_EVENT_B },
    ]);
    // 返回结构里只有「哪些像」，没有任何「该删谁」的语义
    expect(Object.keys(verdict).sort()).toEqual([
      'comparedCount',
      'crossSourceMatches',
      'sameSourceMatches',
    ]);
  });
});
