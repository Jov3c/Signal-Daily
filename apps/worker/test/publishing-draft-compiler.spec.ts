/**
 * 日报草稿编译器的守卫 —— `docs/10` 的 Draft Compiler 与多样性规则。
 *
 * 编译器是**纯函数**，所以这一组测试没有替身、没有库、没有 Redis：
 * 输入候选、断言版块结构。这是本模块最值得测的一块 ——
 * 它是「日报长什么样」的**全部规则**所在。
 *
 * ⚠ 测试数据用中文（§23.4 第 4 问）：标题、来源名都是真实形态。
 * 关键词归类是**按中文与英文双写**的规则，用纯 ASCII 探针测不出中文那条分支。
 */

import { describe, expect, it } from 'vitest';
import { ContentType, DailyDisplayStyle, DailySectionType } from '@signal/contracts';
import {
  DEFAULT_SECTIONS,
  DraftNoteReason,
  FRONT_PAGE_SIZE,
  X_VOICES_MAX,
  compareCandidates,
  compileDraft,
  displayStyleFor,
  sectionForCandidate,
} from '../src/jobs/publishing/draft-compiler';
import { makeCandidate } from './support/publishing-fakes';

/** 取某个版块的条目 contentId 列表。 */
function itemsOf(draft: ReturnType<typeof compileDraft>, type: DailySectionType): string[] {
  return (
    draft.sections.find((section) => section.type === type)?.items.map((i) => i.contentId) ?? []
  );
}

/** 全部 LEAD 条目的 contentId。 */
function leadsOf(draft: ReturnType<typeof compileDraft>): string[] {
  return draft.sections.flatMap((section) =>
    section.items
      .filter((item) => item.displayStyle === DailyDisplayStyle.LEAD)
      .map((i) => i.contentId),
  );
}

describe('版块归类（docs/10 的七个默认版块）', () => {
  it('中文与英文关键词都能归到 AI', () => {
    expect(sectionForCandidate(makeCandidate({ title: '一个新的模型训练方法' }))).toBe(
      DailySectionType.AI,
    );
    expect(sectionForCandidate(makeCandidate({ title: 'A new LLM benchmark' }))).toBe(
      DailySectionType.AI,
    );
  });

  it('开发 / 科技 / 产品各自归位', () => {
    expect(sectionForCandidate(makeCandidate({ title: '开源框架发布 release' }))).toBe(
      DailySectionType.DEVELOPMENT,
    );
    expect(sectionForCandidate(makeCandidate({ title: '新一代 GPU 芯片' }))).toBe(
      DailySectionType.TECH,
    );
    expect(sectionForCandidate(makeCandidate({ title: '某公司产品上线并公布定价' }))).toBe(
      DailySectionType.PRODUCT,
    );
  });

  it('特征都不命中 → BRIEFS（兜底，不是丢弃）', () => {
    expect(sectionForCandidate(makeCandidate({ title: '一则简短的行业消息' }))).toBe(
      DailySectionType.BRIEFS,
    );
  });

  it('X 帖子一律进 X_VOICES（不受关键词影响）', () => {
    expect(
      sectionForCandidate(
        makeCandidate({ title: '模型训练 GPU 芯片 产品定价', contentType: ContentType.X_POST }),
      ),
    ).toBe(DailySectionType.X_VOICES);
  });

  it('⚠ 归类顺序：先判最具体的，否则任何提到「发布」的都会被归到 PRODUCT', () => {
    // 「发布了新模型」同时命中 AI（模型）与 PRODUCT（发布）——
    // AI 必须赢，因为它是更具体的特征。
    expect(sectionForCandidate(makeCandidate({ title: '发布了新模型' }))).toBe(DailySectionType.AI);
  });
});

describe('展示样式与 Lead 唯一性（docs/10：Lead 只有 1 条）', () => {
  it('FRONT_PAGE[0] 是 LEAD，其他版块的第一条是 MAJOR', () => {
    expect(displayStyleFor(DailySectionType.FRONT_PAGE, 0)).toBe(DailyDisplayStyle.LEAD);
    expect(displayStyleFor(DailySectionType.AI, 0)).toBe(DailyDisplayStyle.MAJOR);
  });

  it('任何非 FRONT_PAGE 版块的第 0 条都**不会**是 LEAD —— 结构性保证', () => {
    for (const definition of DEFAULT_SECTIONS) {
      if (definition.type === DailySectionType.FRONT_PAGE) continue;
      expect(displayStyleFor(definition.type, 0)).not.toBe(DailyDisplayStyle.LEAD);
    }
  });

  it('编译出来的草稿**恰好一条 LEAD**，且它来自分数最高的候选', () => {
    const draft = compileDraft([
      makeCandidate({ contentId: '1', title: '低分消息', finalScore: 40 }),
      makeCandidate({ contentId: '2', title: '高分模型发布', finalScore: 95 }),
      makeCandidate({ contentId: '3', title: '中等新闻', finalScore: 70 }),
    ]);

    expect(leadsOf(draft)).toEqual(['2']);
    expect(itemsOf(draft, DailySectionType.FRONT_PAGE)).toEqual(['2']);
  });
});

describe('同 Event 默认 1 条 Primary（docs/10）', () => {
  it('非主稿被丢弃，并记下原因', () => {
    const draft = compileDraft([
      makeCandidate({ contentId: '1', eventId: 'e1', isEventPrimary: true, finalScore: 90 }),
      makeCandidate({ contentId: '2', eventId: 'e1', isEventPrimary: false, finalScore: 99 }),
    ]);

    expect(itemsOf(draft, DailySectionType.FRONT_PAGE)).toEqual(['1']);
    expect(draft.notes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ contentId: '2', reason: DraftNoteReason.NOT_EVENT_PRIMARY }),
      ]),
    );
  });

  it('同一事件即使有多条「主稿」也只留一条', () => {
    const draft = compileDraft([
      makeCandidate({ contentId: '1', eventId: 'e1', isEventPrimary: true, finalScore: 90 }),
      makeCandidate({ contentId: '2', eventId: 'e1', isEventPrimary: true, finalScore: 80 }),
    ]);
    const all = draft.sections.flatMap((s) => s.items.map((i) => i.contentId));
    expect(all).toEqual(['1']);
    expect(draft.notes.map((n) => n.reason)).toContain(DraftNoteReason.DUPLICATE_EVENT);
  });

  it('没有事件的候选不受影响', () => {
    const draft = compileDraft([
      makeCandidate({ contentId: '1', eventId: null }),
      makeCandidate({ contentId: '2', eventId: null }),
    ]);
    expect(draft.sections.flatMap((s) => s.items)).toHaveLength(2);
  });
});

describe('X_VOICES 上限（docs/10：默认 5–10 条）', () => {
  it(`最多 ${String(X_VOICES_MAX)} 条，多余的丢弃并记原因`, () => {
    // ⚠ 加一条**非 X** 的锚点：否则会走「全 X 时把最高分顶上头条」的兜底，
    // X_VOICES 就只剩 9 条，这条用例就变成在测兜底而不是在测上限。
    const candidates = [
      makeCandidate({ contentId: 'anchor', title: '一篇模型报道', finalScore: 99 }),
      ...Array.from({ length: X_VOICES_MAX + 4 }, (_unused, index) =>
        makeCandidate({
          contentId: String(200 + index),
          contentType: ContentType.X_POST,
          title: `推文 ${String(index)}`,
          finalScore: 90 - index,
        }),
      ),
    ];

    const draft = compileDraft(candidates);
    expect(itemsOf(draft, DailySectionType.X_VOICES)).toHaveLength(X_VOICES_MAX);
    expect(draft.notes.filter((n) => n.reason === DraftNoteReason.X_VOICES_CAP)).toHaveLength(4);
  });

  it('保留的是**分数最高**的那些（不是先来的那些）', () => {
    const candidates = [
      makeCandidate({ contentId: 'anchor', title: '一篇模型报道', finalScore: 100 }),
      ...Array.from({ length: X_VOICES_MAX + 1 }, (_unused, index) =>
        makeCandidate({
          contentId: String(300 + index),
          contentType: ContentType.X_POST,
          title: `推文 ${String(index)}`,
          // 最后一个分数最高
          finalScore: index === X_VOICES_MAX ? 99 : 50,
        }),
      ),
    ];

    const draft = compileDraft(candidates);
    expect(itemsOf(draft, DailySectionType.X_VOICES)).toContain(String(300 + X_VOICES_MAX));
  });

  it('⚠ **全 X 候选的日子也一定有一条 LEAD**（§23 审查的 P3-1）', () => {
    // 没有这条兜底时：FRONT_PAGE 为空 → 没有 LEAD → preflight 报
    // LEAD_REQUIRED → 自动草稿结构性发不出去，每天都得人工干预。
    const draft = compileDraft([
      makeCandidate({
        contentId: '1',
        contentType: ContentType.X_POST,
        title: '推文一',
        finalScore: 90,
      }),
      makeCandidate({
        contentId: '2',
        contentType: ContentType.X_POST,
        title: '推文二',
        finalScore: 80,
      }),
      makeCandidate({
        contentId: '3',
        contentType: ContentType.X_POST,
        title: '推文三',
        finalScore: 70,
      }),
    ]);

    expect(leadsOf(draft)).toHaveLength(1);
    // 顶上头条的是**分数最高**的那条
    expect(leadsOf(draft)).toEqual(['1']);
  });

  it('顶上去的那条**不会同时出现在 X_VOICES**（一条内容只出现一次）', () => {
    const draft = compileDraft([
      makeCandidate({
        contentId: '1',
        contentType: ContentType.X_POST,
        title: '推文一',
        finalScore: 90,
      }),
      makeCandidate({
        contentId: '2',
        contentType: ContentType.X_POST,
        title: '推文二',
        finalScore: 80,
      }),
    ]);

    const all = draft.sections.flatMap((section) => section.items.map((item) => item.contentId));
    expect(all.filter((contentId) => contentId === '1')).toHaveLength(1);
    expect(itemsOf(draft, DailySectionType.FRONT_PAGE)).toEqual(['1']);
    expect(itemsOf(draft, DailySectionType.X_VOICES)).toEqual(['2']);
  });

  it('有非 X 候选时**不**走兜底（头条仍然来自非 X 池）', () => {
    const draft = compileDraft([
      makeCandidate({ contentId: '1', title: '一篇模型报道', finalScore: 95 }),
      makeCandidate({
        contentId: '2',
        contentType: ContentType.X_POST,
        title: '推文',
        finalScore: 99,
      }),
    ]);

    // 即使 X 那条分更高，头条仍然给非 X 那一篇 ——
    // 「X 进 X_VOICES」是 docs/10 的版块设计，兜底只在非 X 池**空**时触发。
    expect(leadsOf(draft)).toEqual(['1']);
    expect(itemsOf(draft, DailySectionType.X_VOICES)).toEqual(['2']);
  });

  it('少于 5 条也照常出（下限是期望值，不是硬约束）', () => {
    const draft = compileDraft([
      makeCandidate({ contentId: 'anchor', title: '一篇模型报道', finalScore: 90 }),
      makeCandidate({ contentId: '1', contentType: ContentType.X_POST, title: '推文一' }),
      makeCandidate({ contentId: '2', contentType: ContentType.X_POST, title: '推文二' }),
    ]);
    expect(itemsOf(draft, DailySectionType.X_VOICES)).toHaveLength(2);
  });
});

describe('来源多样性（单一来源不超过主要条目 25%）', () => {
  it('超额的主要条目被**降级为 STANDARD**，而不是被丢弃', () => {
    // 8 条来自同一个来源 → 主要条目会有 8 条左右，cap = max(1, floor(8*0.25)) = 2
    const candidates = Array.from({ length: 8 }, (_unused, index) =>
      makeCandidate({
        contentId: String(400 + index),
        sourceId: 'same',
        title: `独家消息 ${String(index)}`,
        finalScore: 90 - index,
      }),
    );

    const draft = compileDraft(candidates);
    const all = draft.sections.flatMap((s) => s.items);

    // 一条都没丢
    expect(all).toHaveLength(8);
    // 主要条目（LEAD + MAJOR）不超过 cap
    const major = all.filter(
      (item) =>
        item.displayStyle === DailyDisplayStyle.LEAD ||
        item.displayStyle === DailyDisplayStyle.MAJOR,
    );
    expect(major.length).toBeLessThanOrEqual(2);
    expect(draft.notes.map((n) => n.reason)).toContain(DraftNoteReason.SOURCE_DIVERSITY_DEMOTED);
  });

  it('`LEAD` 永远不会被降级（它是发布前校验的硬要求）', () => {
    const candidates = Array.from({ length: 6 }, (_unused, index) =>
      makeCandidate({
        contentId: String(500 + index),
        sourceId: 'same',
        title: `同一来源 ${String(index)}`,
        finalScore: 90 - index,
      }),
    );

    const draft = compileDraft(candidates);
    expect(leadsOf(draft)).toHaveLength(1);
  });

  it('来源分散时不做任何降级', () => {
    const candidates = Array.from({ length: 6 }, (_unused, index) =>
      makeCandidate({
        contentId: String(600 + index),
        sourceId: `source-${String(index)}`,
        title: `不同来源 ${String(index)}`,
        finalScore: 90 - index,
      }),
    );

    const draft = compileDraft(candidates);
    expect(draft.notes).toEqual([]);
  });
});

describe('确定性（重跑必须得到同一份草稿）', () => {
  it('同分同秒时用 contentId 决胜，且按**数值**比较（不是字符串）', () => {
    const ten = makeCandidate({
      contentId: '10',
      finalScore: 80,
      publishedAt: '2026-09-29T01:00:00.000Z',
    });
    const nine = makeCandidate({
      contentId: '9',
      finalScore: 80,
      publishedAt: '2026-09-29T01:00:00.000Z',
    });

    // 数值降序：id 更大的（通常更新）排在前面。
    // 字符串比较会得出相反的结果（`'9' > '10'`），那不是我们想要的直觉。
    expect(compareCandidates(ten, nine)).toBeLessThan(0);
    expect(compareCandidates(nine, ten)).toBeGreaterThan(0);
  });

  it('非数字的 contentId 也不炸（退回字符串比较）', () => {
    const a = makeCandidate({ contentId: 'abc', finalScore: 80 });
    const b = makeCandidate({ contentId: 'abd', finalScore: 80 });
    expect(() => compareCandidates(a, b)).not.toThrow();
    expect(compareCandidates(a, a)).toBe(0);
  });

  it('分数为 null（还没评分）排最后，但不被丢掉', () => {
    const draft = compileDraft([
      makeCandidate({ contentId: '1', finalScore: null, title: '未评分' }),
      makeCandidate({ contentId: '2', finalScore: 90, title: '已评分' }),
    ]);
    expect(leadsOf(draft)).toEqual(['2']);
    expect(draft.sections.flatMap((s) => s.items).map((i) => i.contentId)).toContain('1');
  });

  it('**打乱输入顺序得到同样的输出**（这是「重跑幂等」的前提）', () => {
    const candidates = [
      makeCandidate({ contentId: '1', title: '模型 A', finalScore: 90 }),
      makeCandidate({ contentId: '2', title: '产品 B', finalScore: 80 }),
      makeCandidate({ contentId: '3', title: '芯片 C', finalScore: 70 }),
      makeCandidate({ contentId: '4', title: '简讯 D', finalScore: 60 }),
    ];

    const forward = compileDraft(candidates);
    const reversed = compileDraft([...candidates].reverse());

    expect(reversed.sections).toEqual(forward.sections);
  });
});

describe('空输入与边界', () => {
  it('没有候选 → 空草稿（不抛异常，由调用方决定「不替换」）', () => {
    const draft = compileDraft([]);
    expect(draft.sections).toEqual([]);
    expect(draft.notes).toEqual([]);
  });

  it('同一个 contentId 出现两次只算一次', () => {
    const draft = compileDraft([
      makeCandidate({ contentId: '1', title: '重复的' }),
      makeCandidate({ contentId: '1', title: '重复的' }),
    ]);
    expect(draft.sections.flatMap((s) => s.items)).toHaveLength(1);
    expect(draft.notes.map((n) => n.reason)).toContain(DraftNoteReason.DUPLICATE_CONTENT);
  });

  it('版块 sortOrder 用 docs/10 的规范序号，与「哪些版块非空」无关', () => {
    // FRONT_PAGE 拿走最高分那条，TECH 拿到剩下那条。
    // 此时 TECH 的 sortOrder 仍然是 4（不是 1）——
    // 这样「AI 排在 PRODUCT 前面」不依赖哪些版块恰好非空。
    const draft = compileDraft([
      makeCandidate({ contentId: '1', title: '头条消息', finalScore: 90 }),
      makeCandidate({ contentId: '2', title: '新一代 GPU 芯片', finalScore: 80 }),
    ]);
    const tech = draft.sections.find((s) => s.type === DailySectionType.TECH);
    expect(tech?.sortOrder).toBe(
      DEFAULT_SECTIONS.findIndex((d) => d.type === DailySectionType.TECH),
    );
  });

  it('只输出非空版块（空版块不出现在草稿里）', () => {
    const draft = compileDraft([
      makeCandidate({ contentId: '1', title: '头条消息', finalScore: 90 }),
      makeCandidate({ contentId: '2', title: '新一代 GPU 芯片', finalScore: 80 }),
    ]);
    expect(draft.sections.map((s) => s.type)).toEqual([
      DailySectionType.FRONT_PAGE,
      DailySectionType.TECH,
    ]);
  });

  it('只有一条候选时，它作为头条独占 FRONT_PAGE（不额外摊到主题版块）', () => {
    const draft = compileDraft([makeCandidate({ contentId: '1', title: '新一代 GPU 芯片' })]);
    expect(draft.sections.map((s) => s.type)).toEqual([DailySectionType.FRONT_PAGE]);
  });
});

describe('FRONT_PAGE 的规模', () => {
  it(`只放 ${String(FRONT_PAGE_SIZE)} 条（头条区，不是收纳所有高分）`, () => {
    const draft = compileDraft(
      Array.from({ length: 6 }, (_unused, index) =>
        makeCandidate({
          contentId: String(700 + index),
          title: `模型 ${String(index)}`,
          finalScore: 90 - index,
        }),
      ),
    );
    expect(itemsOf(draft, DailySectionType.FRONT_PAGE)).toHaveLength(FRONT_PAGE_SIZE);
  });
});
