/**
 * Event Cluster 的守卫 —— `docs/07` 的主来源优先级与归属判定。
 *
 * 两条性质最重要：
 * 1. **主来源必须唯一且确定** —— 同一批数据两次跑出同一个主来源，
 *    否则前台「这个事件的主稿是哪一篇」会随处理顺序漂移；
 * 2. **归属只看相似度，不看正文措辞** —— 「像不像」是文字问题，
 *    「是不是官方」是来源问题，两者不能混。
 */

import { describe, expect, it } from 'vitest';
import { SourceKind, SourceTier } from '@signal/contracts';
import {
  PRIMARY_SOURCE_RANKS,
  pickPrimaryContent,
  primarySourceRank,
  type PrimaryCandidate,
} from '../src/jobs/content/cluster/priority';
import {
  EVENT_RELATION,
  EVENT_STATUS_ACTIVE,
  canonicalTitleOf,
  decideEventAssignment,
} from '../src/jobs/content/cluster/event-cluster';
import type { NearDuplicateMatch } from '../src/jobs/content/dedup/similarity';

const source = (over: Partial<{ tier: SourceTier; kind: SourceKind; official: boolean }> = {}) => ({
  tier: over.tier ?? SourceTier.C,
  kind: over.kind ?? SourceKind.MEDIA,
  official: over.official ?? false,
});

describe('主来源优先级（docs/07 的 5 档）', () => {
  it('第 1 档：官方直接发布（official=true 或 tier=S）', () => {
    expect(primarySourceRank(source({ official: true }))).toBe(1);
    expect(primarySourceRank(source({ tier: SourceTier.S }))).toBe(1);
  });

  it('第 2 档：当事人 / 原作者（kind=PERSON）', () => {
    expect(primarySourceRank(source({ tier: SourceTier.A, kind: SourceKind.PERSON }))).toBe(2);
  });

  it('第 3 档：核心开发者（kind=DEVELOPER）', () => {
    expect(primarySourceRank(source({ tier: SourceTier.A, kind: SourceKind.DEVELOPER }))).toBe(3);
  });

  it('第 4 档：高质量媒体 / 社区（tier=B 或 kind=MEDIA/COMMUNITY）', () => {
    expect(primarySourceRank(source({ tier: SourceTier.B }))).toBe(4);
    expect(primarySourceRank(source({ tier: SourceTier.A, kind: SourceKind.MEDIA }))).toBe(4);
    expect(primarySourceRank(source({ kind: SourceKind.COMMUNITY }))).toBe(4);
  });

  it('第 5 档：普通二手媒体（tier=C 且非上述身份）', () => {
    expect(primarySourceRank(source({ tier: SourceTier.C, kind: SourceKind.TREND }))).toBe(5);
  });

  it('政府公告归第 1 档（docs/22 的 S 档定义含直接事实来源）', () => {
    expect(primarySourceRank(source({ tier: SourceTier.B, kind: SourceKind.GOVERNMENT }))).toBe(1);
  });

  it('**官方优先于一切**：即使是 tier=C 的官方账号也排第 1', () => {
    expect(primarySourceRank(source({ tier: SourceTier.C, official: true }))).toBe(1);
  });

  it('档位取值落在 1–5 内（穷尽性）', () => {
    for (const tier of Object.values(SourceTier)) {
      for (const kind of Object.values(SourceKind)) {
        for (const official of [true, false]) {
          const rank = primarySourceRank({ tier, kind, official });
          expect(PRIMARY_SOURCE_RANKS).toContain(rank);
        }
      }
    }
  });
});

describe('选出主来源', () => {
  const at = (iso: string) => new Date(iso);

  it('档位高的胜出', () => {
    const picked = pickPrimaryContent([
      { contentId: '1', source: source({ tier: SourceTier.C }), createdAt: at('2026-01-01') },
      { contentId: '2', source: source({ official: true }), createdAt: at('2026-01-02') },
    ]);
    expect(picked).toBe('2');
  });

  it('同档位时**更早进入事件**的胜出', () => {
    const picked = pickPrimaryContent([
      { contentId: '1', source: source({ tier: SourceTier.B }), createdAt: at('2026-01-02') },
      { contentId: '2', source: source({ tier: SourceTier.B }), createdAt: at('2026-01-01') },
    ]);
    expect(picked).toBe('2');
  });

  it('档位与时间都并列时按 id **数值**决胜（确定性）', () => {
    const same = { tier: SourceTier.B };
    const time = at('2026-01-01');
    const forward = pickPrimaryContent([
      { contentId: '10', source: source(same), createdAt: time },
      { contentId: '9', source: source(same), createdAt: time },
    ]);
    const backward = pickPrimaryContent([
      { contentId: '9', source: source(same), createdAt: time },
      { contentId: '10', source: source(same), createdAt: time },
    ]);
    expect(forward).toBe('9');
    expect(backward).toBe('9');
  });

  it('**结果与输入顺序无关**（打乱顺序得到同一个主来源）', () => {
    const candidates: PrimaryCandidate[] = [
      { contentId: '3', source: source({ tier: SourceTier.C }), createdAt: at('2026-01-03') },
      { contentId: '1', source: source({ official: true }), createdAt: at('2026-01-01') },
      { contentId: '2', source: source({ tier: SourceTier.A }), createdAt: at('2026-01-02') },
    ];
    const orders = [candidates, [...candidates].reverse(), [candidates[1]!, candidates[2]!, candidates[0]!]];
    const picked = orders.map((order) => pickPrimaryContent(order));
    expect(new Set(picked).size).toBe(1);
    expect(picked[0]).toBe('1');
  });

  it('空候选 → null', () => {
    expect(pickPrimaryContent([])).toBeNull();
  });
});

describe('归属判定', () => {
  /** 造一条匹配。 */
  const match = (contentId: string, score: number): NearDuplicateMatch => ({
    contentId,
    sourceId: '7',
    score,
    sameSource: false,
  });

  it('相似内容已在某事件里 → 加入该事件', () => {
    const decision = decideEventAssignment(
      { contentId: '100' },
      [match('50', 0.8)],
      [{ eventId: '900', contentIds: ['50'] }],
    );
    expect(decision).toEqual({
      action: 'join',
      eventId: '900',
      viaContentId: '50',
      viaScore: 0.8,
      alreadyMember: false,
    });
  });

  it('相似内容都不在任何事件里 → 新建', () => {
    const decision = decideEventAssignment(
      { contentId: '100' },
      [match('50', 0.9)],
      [{ eventId: '900', contentIds: ['999'] }],
    );
    expect(decision.action).toBe('create');
  });

  it('多个事件都命中时，取**相似度最高**的那条所在的', () => {
    const decision = decideEventAssignment(
      { contentId: '100' },
      [match('50', 0.4), match('60', 0.9)],
      [
        { eventId: '900', contentIds: ['50'] },
        { eventId: '901', contentIds: ['60'] },
      ],
    );
    expect(decision).toEqual({
      action: 'join',
      eventId: '901',
      viaContentId: '60',
      viaScore: 0.9,
      alreadyMember: false,
    });
  });

  it('相似度并列时取 eventId 数值最小的（确定性）', () => {
    const forward = decideEventAssignment(
      { contentId: '100' },
      [match('50', 0.8), match('60', 0.8)],
      [
        { eventId: '10', contentIds: ['50'] },
        { eventId: '9', contentIds: ['60'] },
      ],
    );
    const backward = decideEventAssignment(
      { contentId: '100' },
      [match('60', 0.8), match('50', 0.8)],
      [
        { eventId: '9', contentIds: ['60'] },
        { eventId: '10', contentIds: ['50'] },
      ],
    );
    // 字典序下 '10' < '9'，数值上 9 < 10 —— 必须按数值
    expect(forward).toMatchObject({ eventId: '9' });
    expect(backward).toMatchObject({ eventId: '9' });
  });

  it('**自己已经在某个事件里 → 幂等返回该事件**（不重复聚合）', () => {
    const decision = decideEventAssignment(
      { contentId: '100' },
      [],
      [{ eventId: '900', contentIds: ['100'] }],
    );
    expect(decision).toEqual({
      action: 'join',
      eventId: '900',
      viaContentId: '100',
      viaScore: 1,
      alreadyMember: true,
    });
  });

  it('无匹配、无事件 → 新建', () => {
    expect(decideEventAssignment({ contentId: '100' }, [], []).action).toBe('create');
  });

  it('**归属只看相似度，不看来源属性** —— 传入里根本没有来源字段', () => {
    // 这条断言的是**接口形状**：`decideEventAssignment` 拿不到 tier/official，
    // 所以「因为它是官方所以归到那个事件」这种逻辑在类型上就写不出来。
    const decision = decideEventAssignment(
      { contentId: '100' },
      [match('50', 0.8)],
      [{ eventId: '900', contentIds: ['50'] }],
    );
    expect(decision.action).toBe('join');
    expect(Object.keys(decision).sort()).toEqual([
      'action',
      'alreadyMember',
      'eventId',
      'viaContentId',
      'viaScore',
    ]);
  });
});

describe('常量与标题', () => {
  it('EventContent.relation 的两个取值', () => {
    expect(EVENT_RELATION.PRIMARY).toBe('primary');
    expect(EVENT_RELATION.RELATED).toBe('related');
  });

  it('Event.status 用常量而不是散落的字面量', () => {
    expect(EVENT_STATUS_ACTIVE).toBe('ACTIVE');
  });

  it('canonicalTitle 超长被按码点截断（不劈开 emoji）', () => {
    const title = canonicalTitleOf('🚀'.repeat(600));
    expect(Array.from(title).length).toBe(500);
    expect(Buffer.from(title, 'utf8').toString('utf8')).toBe(title);
  });

  it('canonicalTitle 不超长时原样返回', () => {
    expect(canonicalTitleOf('Anthropic 发布评测报告')).toBe('Anthropic 发布评测报告');
  });
});
