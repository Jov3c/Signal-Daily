/**
 * `public-view.ts` 的守卫 —— 对外投影层。
 *
 * ── 为什么值得单独测（§23 独立审查的 P3-2）──────────────────────────
 * 它是**前台唯一会看到的那一层**，而它的职责是**减法**：
 * 把后台的 `editionId` / `status` / `scheduledAt` / `pipelineStatus`
 * 挡在外面。减法写错的后果是**静默泄漏** ——
 * 没有任何测试会因为「多了一个字段」而变红，除非有人专门为它写断言。
 * （`docs/14`：不把后台 debug 信息搬给用户。）
 *
 * 这些用例的形状刻意是「**断言某个键不存在**」——
 * 那条断言正是「以后给编辑台加一个内部字段」时唯一的护栏：
 * 加了字段而忘了在投影里挡掉，这里会红。
 */

import { describe, expect, it } from 'vitest';
import {
  ContentPipelineStatus,
  ContentType,
  DailyDisplayStyle,
  DailySectionType,
} from '@signal/contracts';
import { toArchiveEntry, toPublicEdition } from '../src/modules/daily/public-view';
import type { EditionDetail, EditionRow } from '../src/modules/daily/repository';

/** 一期的详情（含一条正常条目、一条自定义标题条目、一条内容已被删除的条目）。 */
function detail(): EditionDetail {
  return {
    edition: {
      editionId: '42',
      businessDate: '2026-09-29',
      editionNo: 7,
      status: 'PUBLISHED' as EditionRow['status'],
      headline: '今天的信号',
      scheduledAt: '2026-09-29T00:00:00.000Z',
      publishedAt: '2026-09-29T00:00:05.000Z',
    },
    sections: [
      {
        sectionId: 's1',
        type: DailySectionType.FRONT_PAGE,
        title: '首页',
        sortOrder: 0,
        items: [
          {
            contentId: '100',
            displayStyle: DailyDisplayStyle.LEAD,
            sortOrder: 0,
            customHeadline: null,
            customExcerpt: null,
            content: {
              title: '内容自己的标题',
              summary: '内容自己的摘要',
              originalUrl: 'https://example.com/100',
              imageUrl: 'https://example.com/100.png',
              publishedAt: '2026-09-28T12:00:00.000Z',
              type: ContentType.ARTICLE,
              pipelineStatus: ContentPipelineStatus.APPROVED,
              source: {
                name: 'Anthropic 官方博客',
                slug: 'anthropic-blog',
                kind: 'OFFICIAL',
                tier: 'S',
                official: true,
              },
            },
          },
          {
            contentId: '101',
            displayStyle: DailyDisplayStyle.STANDARD,
            sortOrder: 1,
            customHeadline: '编辑改过的标题',
            customExcerpt: '编辑写的一段引言。',
            content: {
              title: '原始标题',
              summary: '原始摘要',
              originalUrl: 'https://example.com/101',
              imageUrl: null,
              publishedAt: null,
              type: ContentType.X_POST,
              pipelineStatus: ContentPipelineStatus.APPROVED,
              source: {
                name: '某人的 X',
                slug: 'x-someone',
                kind: 'PERSON',
                tier: 'A',
                official: false,
              },
            },
          },
          {
            // 内容行已被删除（外键本该挡住，但别信任它）
            contentId: '102',
            displayStyle: DailyDisplayStyle.BRIEF,
            sortOrder: 2,
            customHeadline: null,
            customExcerpt: null,
            content: null,
          },
        ],
      },
    ],
  };
}

describe('对外投影：该有的都有', () => {
  it('期级字段（业务日 / 期号 / 期号标签 / 标题 / 发布时间）', () => {
    const view = toPublicEdition(detail());

    expect(view).toMatchObject({
      businessDate: '2026-09-29',
      editionNo: 7,
      editionNoLabel: 'NO.007',
      headline: '今天的信号',
      publishedAt: '2026-09-29T00:00:05.000Z',
    });
  });

  it('未分配期号时标签是 `null`（不是 `NO.000`）', () => {
    const input = detail();
    input.edition.editionNo = null;
    expect(toPublicEdition(input).editionNoLabel).toBeNull();
  });

  it('条目：自定义标题/摘要优先，没有就回落到内容自己的', () => {
    const items = toPublicEdition(detail()).sections[0]?.items ?? [];

    expect(items[0]).toMatchObject({
      contentId: '100',
      headline: '内容自己的标题',
      excerpt: '内容自己的摘要',
    });
    // 编辑改过的那条用编辑的
    expect(items[1]).toMatchObject({
      contentId: '101',
      headline: '编辑改过的标题',
      excerpt: '编辑写的一段引言。',
    });
  });

  it('条目带出 source 的 tier / official（docs/22 的「官方一手」那一行要用）', () => {
    const items = toPublicEdition(detail()).sections[0]?.items ?? [];
    expect(items[0]?.source).toEqual({
      name: 'Anthropic 官方博客',
      slug: 'anthropic-blog',
      kind: 'OFFICIAL',
      tier: 'S',
      official: true,
    });
  });

  it('版块与条目的顺序、类型、展示样式原样带出', () => {
    const view = toPublicEdition(detail());
    expect(view.sections[0]).toMatchObject({
      type: DailySectionType.FRONT_PAGE,
      title: '首页',
      sortOrder: 0,
    });
    expect(view.sections[0]?.items.map((item) => item.displayStyle)).toEqual([
      DailyDisplayStyle.LEAD,
      DailyDisplayStyle.STANDARD,
    ]);
  });
});

describe('对外投影：该没有的一定没有（这一组是防泄漏的护栏）', () => {
  it('⚠ **不泄漏** `editionId` / `status` / `scheduledAt`', () => {
    const view = toPublicEdition(detail()) as unknown as Record<string, unknown>;

    for (const leaked of ['editionId', 'status', 'scheduledAt']) {
      expect(Object.hasOwn(view, leaked), `${leaked} 不该出现在对外投影里`).toBe(false);
    }
  });

  it('⚠ **不泄漏**条目的 `pipelineStatus`（docs/14：不搬后台 debug 信息）', () => {
    const items = toPublicEdition(detail()).sections[0]?.items ?? [];
    for (const item of items) {
      expect(Object.hasOwn(item, 'pipelineStatus')).toBe(false);
      expect(Object.hasOwn(item as unknown as Record<string, unknown>, 'content')).toBe(false);
    }
  });

  it('⚠ 版块的 `sectionId` 也不外泄（对外用 businessDate + 版块类型定位）', () => {
    const section = toPublicEdition(detail()).sections[0] as unknown as Record<string, unknown>;
    expect(Object.hasOwn(section, 'sectionId')).toBe(false);
  });

  it('投影只输出**固定的一组键**（多一个键就会红 —— 这就是护栏）', () => {
    const view = toPublicEdition(detail()) as unknown as Record<string, unknown>;
    expect(Object.keys(view).sort()).toEqual([
      'businessDate',
      'editionNo',
      'editionNoLabel',
      'headline',
      'publishedAt',
      'sections',
    ]);

    const item = (toPublicEdition(detail()).sections[0]?.items[0] ?? {}) as unknown as Record<
      string,
      unknown
    >;
    expect(Object.keys(item).sort()).toEqual([
      'contentId',
      'displayStyle',
      'excerpt',
      'headline',
      'imageUrl',
      'originalUrl',
      'publishedAt',
      'sortOrder',
      'source',
      'type',
    ]);
  });
});

describe('内容已被删除的条目', () => {
  it('**被丢掉**，而不是渲染成一个点不动的链接', () => {
    const items = toPublicEdition(detail()).sections[0]?.items ?? [];
    expect(items.map((item) => item.contentId)).toEqual(['100', '101']);
    expect(items.some((item) => item.contentId === '102')).toBe(false);
  });

  it('整段都被删掉时版块仍然存在（只是空）—— 由调用方决定要不要隐藏', () => {
    const input = detail();
    const section = input.sections[0];
    if (section !== undefined) {
      section.items = section.items.filter((item) => item.content === null);
    }
    const view = toPublicEdition(input);
    expect(view.sections).toHaveLength(1);
    expect(view.sections[0]?.items).toEqual([]);
  });
});

describe('归档条目', () => {
  it('只带日历需要的字段（**不含**版块内容）', () => {
    const edition: EditionRow = {
      editionId: '42',
      businessDate: '2026-09-29',
      editionNo: 7,
      status: 'PUBLISHED' as EditionRow['status'],
      headline: '今天的信号',
      scheduledAt: '2026-09-29T00:00:00.000Z',
      publishedAt: '2026-09-29T00:00:05.000Z',
    };

    const entry = toArchiveEntry(edition, 12) as unknown as Record<string, unknown>;

    expect(entry).toMatchObject({
      businessDate: '2026-09-29',
      editionNo: 7,
      editionNoLabel: 'NO.007',
      headline: '今天的信号',
      itemCount: 12,
    });
    // 同样不泄漏内部字段
    for (const leaked of ['editionId', 'status', 'scheduledAt']) {
      expect(Object.hasOwn(entry, leaked), `${leaked} 不该出现在归档条目里`).toBe(false);
    }
    expect(Object.keys(entry).sort()).toEqual([
      'businessDate',
      'editionNo',
      'editionNoLabel',
      'headline',
      'itemCount',
      'publishedAt',
    ]);
  });
});
