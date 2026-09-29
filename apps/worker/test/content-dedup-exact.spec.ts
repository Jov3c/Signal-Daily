/**
 * `pickExactDuplicate` 的守卫 —— 纯函数，只判「哪条是正本」。
 *
 * 判重本身不难，难的是**正本选择的确定性**：
 * 同一批数据跑两次必须给出同一个正本，否则「谁被标成重复」会随查询顺序漂移，
 * 而下游（审核队列、事件聚合）会因此看到不一致的结果。
 */

import { describe, expect, it } from 'vitest';
import {
  pickExactDuplicate,
  type DedupCandidate,
} from '../src/jobs/content/dedup/exact';

const HASH = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);

/** 造一个候选。`at` 是入库时刻（毫秒），越大越晚。 */
function candidate(
  rawItemId: string,
  overrides: Partial<DedupCandidate> & { at?: number } = {},
): DedupCandidate {
  return {
    contentId: overrides.contentId ?? `c-${rawItemId}`,
    rawItemId,
    contentHash: overrides.contentHash === undefined ? HASH : overrides.contentHash,
    sourceId: overrides.sourceId ?? '7',
    createdAt: new Date(overrides.at ?? 1_000),
  };
}

const probe = (rawItemId: string, contentHash: string | null = HASH) => ({
  rawItemId,
  contentHash,
});

describe('基本判定', () => {
  it('hash 相同且不是自己 → 判为重复', () => {
    const verdict = pickExactDuplicate(probe('43'), [candidate('42')], '9');
    expect(verdict.duplicate).toBe(true);
  });

  it('hash 不同 → 不是重复', () => {
    const verdict = pickExactDuplicate(probe('43'), [candidate('42', { contentHash: OTHER })], '9');
    expect(verdict.duplicate).toBe(false);
  });

  it('候选为空 → 不是重复', () => {
    expect(pickExactDuplicate(probe('43'), [], '9')).toEqual({
      duplicate: false,
      reason: 'no-candidate',
    });
  });

  it('自己不在候选里（rawItemId 相同一律跳过）', () => {
    const verdict = pickExactDuplicate(probe('42'), [candidate('42')], '7');
    expect(verdict.duplicate).toBe(false);
  });
});

describe('没有 hash 时不判重', () => {
  it('probe 没有 hash → 直接不判（不退回模糊比较）', () => {
    expect(pickExactDuplicate(probe('43', null), [candidate('42')], '9')).toEqual({
      duplicate: false,
      reason: 'no-hash',
    });
  });

  it('probe 的 hash 是空串 → 同上', () => {
    expect(pickExactDuplicate(probe('43', ''), [candidate('42')], '9').duplicate).toBe(false);
  });

  it('候选里有 hash 为 null 的 → 它不参与匹配', () => {
    const verdict = pickExactDuplicate(probe('43'), [candidate('42', { contentHash: null })], '9');
    expect(verdict.duplicate).toBe(false);
  });
});

describe('正本选择（确定性）', () => {
  it('取 createdAt 最早的那条', () => {
    const verdict = pickExactDuplicate(
      probe('99'),
      [candidate('50', { at: 5_000 }), candidate('10', { at: 1_000 }), candidate('70', { at: 3_000 })],
      '9',
    );
    if (!verdict.duplicate) throw new Error('unreachable');
    expect(verdict.canonicalRawItemId).toBe('10');
  });

  it('createdAt 相同时取 rawItemId **数值**最小的（字典序陷阱）', () => {
    // 字典序下 '10' < '9'，而数值上 9 < 10。
    // 用字典序会选错正本 —— 这个错误在数据上不会报错，只会让正本不稳定。
    const forward = pickExactDuplicate(
      probe('99'),
      [candidate('10', { at: 1_000 }), candidate('9', { at: 1_000 })],
      '9',
    );
    const backward = pickExactDuplicate(
      probe('99'),
      [candidate('9', { at: 1_000 }), candidate('10', { at: 1_000 })],
      '9',
    );

    if (!forward.duplicate || !backward.duplicate) throw new Error('unreachable');
    expect(forward.canonicalRawItemId).toBe('9');
    // 顺序不同也必须给出同一个正本
    expect(backward.canonicalRawItemId).toBe(forward.canonicalRawItemId);
  });

  it('三条同 hash：正本稳定（打乱输入顺序结果一致）', () => {
    const all = [
      candidate('3', { at: 3_000, contentId: 'c3' }),
      candidate('1', { at: 1_000, contentId: 'c1' }),
      candidate('2', { at: 2_000, contentId: 'c2' }),
    ];
    const orders = [
      all,
      [all[2]!, all[0]!, all[1]!],
      [all[1]!, all[2]!, all[0]!],
    ];

    const canonicals = orders.map((order) => {
      const verdict = pickExactDuplicate(probe('99'), order, '9');
      if (!verdict.duplicate) throw new Error('unreachable');
      return verdict.canonicalContentId;
    });

    expect(new Set(canonicals).size).toBe(1);
    expect(canonicals[0]).toBe('c1');
  });

  it('createdAt 不同时按时间，不看 id 大小', () => {
    // id 小但入库晚 ≠ 正本
    const verdict = pickExactDuplicate(
      probe('99'),
      [candidate('10', { at: 9_000 }), candidate('50', { at: 1_000 })],
      '9',
    );
    if (!verdict.duplicate) throw new Error('unreachable');
    expect(verdict.canonicalRawItemId).toBe('50');
  });
});

describe('同源 / 跨源', () => {
  it('跨源重复 → sameSource = false', () => {
    const verdict = pickExactDuplicate(probe('43'), [candidate('42', { sourceId: '7' })], '9');
    if (!verdict.duplicate) throw new Error('unreachable');
    expect(verdict.sameSource).toBe(false);
  });

  it('同源重复 → sameSource = true', () => {
    const verdict = pickExactDuplicate(probe('43'), [candidate('42', { sourceId: '7' })], '7');
    if (!verdict.duplicate) throw new Error('unreachable');
    expect(verdict.sameSource).toBe(true);
  });
});

describe('脏数据不抛错', () => {
  it('时间不同时，**先入库的就是正本**，与 id 好不好看无关', () => {
    // ⚠ 这一条纠正了一个曾经写错的注释：早先版本声称
    // 「脏 id 会被排到最后，正本永远不会是一条 id 畸形的记录」——
    // 而 `isEarlier()` 先比时间，那个保证只在时间**相同**时才成立。
    // 「谁先入库」是事实，不该因为 id 解不出来就被推翻。
    const verdict = pickExactDuplicate(
      probe('99'),
      [candidate('not-a-number', { at: 1_000 }), candidate('5', { at: 2_000 })],
      '9',
    );
    if (!verdict.duplicate) throw new Error('unreachable');
    expect(verdict.canonicalRawItemId).toBe('not-a-number');
  });

  it('时间相同时，数值合法的 id 胜过脏 id（确定性平局规则）', () => {
    const verdict = pickExactDuplicate(
      probe('99'),
      [candidate('abc', { at: 1_000 }), candidate('5', { at: 1_000 })],
      '9',
    );
    if (!verdict.duplicate) throw new Error('unreachable');
    expect(verdict.canonicalRawItemId).toBe('5');
  });

  it('两个都是脏 id、时间也相同 → 结果确定（不抛错、顺序无关）', () => {
    const forward = pickExactDuplicate(
      probe('99'),
      [candidate('bbb', { at: 1_000 }), candidate('aaa', { at: 1_000 })],
      '9',
    );
    const backward = pickExactDuplicate(
      probe('99'),
      [candidate('aaa', { at: 1_000 }), candidate('bbb', { at: 1_000 })],
      '9',
    );
    if (!forward.duplicate || !backward.duplicate) throw new Error('unreachable');
    expect(forward.canonicalRawItemId).toBe(backward.canonicalRawItemId);
  });

  it('id 是空串时不抛错', () => {
    expect(() => pickExactDuplicate(probe('99'), [candidate('')], '9')).not.toThrow();
  });

  it('超长数字 id 不抛错', () => {
    expect(() =>
      pickExactDuplicate(probe('99'), [candidate('9'.repeat(40))], '9'),
    ).not.toThrow();
  });
});
