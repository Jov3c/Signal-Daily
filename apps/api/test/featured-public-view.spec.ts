/**
 * `toPublicFeatured()` 的守卫 —— `GET /featured` 的**字段白名单**。
 *
 * ── 守的是哪次事故 ──────────────────────────────────────────────────
 * 2026-10-01 之前，`GET /featured` 是**原样返回仓储的行**的，于是
 * `content.pipelineStatus` / `content.reviewStatus` / `content.publishFeatured`
 * 这三个**编辑台内部状态直接出现在公开响应里** —— 不登录、一条 `curl` 就能看到
 * 某条内容的内部审核状态。
 *
 * 前端 `apps/web/lib/types.ts` 早就记着这件事（它刻意不声明那三个字段），
 * 并把它写进了 `CONTRACT_CHANGE_REQUEST-agent-13.md` 第 2 项。
 *
 * ── 这个文件真正守的不是「那三个字段没了」────────────────────────────
 * 而是「**将来新增的内部字段不会自动泄漏**」。
 *
 * 光断言「不返回那三个」是**向后看**的：编辑台明天再加一个 `internalNote`，
 * 那条断言照样绿。所以这里断言的是**形状本身** ——
 * `toPublicFeatured` 的输出键必须**恰好等于**白名单，
 * 多一个少一个都红。
 */

import { describe, expect, it } from 'vitest';
import { ContentPipelineStatus } from '@signal/contracts';
import { toPublicFeatured, type PublicFeatured } from '../src/modules/featured/public-view';
import type { FeaturedRow } from '../src/modules/featured/repository';

/** 一条**带全部内部字段**的仓储行 —— 正是投影层要拦下的形状。 */
function fullRow(extra: Record<string, unknown> = {}): FeaturedRow {
  return {
    contentId: '42',
    customTitle: '自定义标题',
    customSummary: '自定义摘要',
    sortWeight: 3,
    publishedAt: '2026-10-01T00:00:00.000Z',
    active: true,
    content: {
      title: '原标题',
      summary: '原摘要',
      originalUrl: 'https://example.com/a',
      imageUrl: null,
      publishedAt: '2026-09-30T00:00:00.000Z',
      pipelineStatus: ContentPipelineStatus.APPROVED,
      reviewStatus: 'APPROVED',
      publishFeatured: true,
      sourceName: '某来源',
      ...extra,
    },
  } as unknown as FeaturedRow;
}

/** 白名单 —— 与 `public-view.ts` 里那个类型逐字对应。 */
const EXPECTED_TOP_KEYS = [
  'active',
  'content',
  'contentId',
  'customSummary',
  'customTitle',
  'publishedAt',
  'sortWeight',
] as const;

const EXPECTED_CONTENT_KEYS = [
  'imageUrl',
  'originalUrl',
  'publishedAt',
  'sourceName',
  'summary',
  'title',
] as const;

describe('toPublicFeatured：公开响应只含白名单字段', () => {
  it('⚠ 顶层键**恰好**是白名单 —— 多一个就红', () => {
    const out = toPublicFeatured(fullRow());
    expect(Object.keys(out).sort()).toEqual([...EXPECTED_TOP_KEYS].sort());
  });

  it('⚠ `content` 的键**恰好**是白名单 —— 多一个就红', () => {
    const out = toPublicFeatured(fullRow());
    expect(Object.keys(out.content).sort()).toEqual([...EXPECTED_CONTENT_KEYS].sort());
  });

  it('⚠ 三个内部状态确实不在输出里（这次事故的现场）', () => {
    const out = toPublicFeatured(fullRow()) as unknown as Record<string, unknown>;
    const content = out['content'] as Record<string, unknown>;

    expect(content).not.toHaveProperty('pipelineStatus');
    expect(content).not.toHaveProperty('reviewStatus');
    expect(content).not.toHaveProperty('publishFeatured');
    // 整个响应里都不该出现这些值 —— 连序列化后也不该有。
    expect(JSON.stringify(out)).not.toContain('APPROVED');
  });

  it('⚠ 给上游行**塞一个未知的内部字段**，它不会出现在输出里', () => {
    // 这条模拟「编辑台明天给 FeaturedRow 加了个内部字段」。
    // 白名单投影让它**默认不外泄** —— 这正是投影层存在的理由。
    const out = toPublicFeatured(fullRow({ internalNote: '内部备注', reviewerId: '7' }));
    const serialized = JSON.stringify(out);

    expect(serialized).not.toContain('内部备注');
    expect(serialized).not.toContain('reviewerId');
    expect(Object.keys(out.content).sort()).toEqual([...EXPECTED_CONTENT_KEYS].sort());
  });

  it('白名单里的字段值被**原样**带出去（投影不是把数据抹掉）', () => {
    const out: PublicFeatured = toPublicFeatured(fullRow());
    expect(out).toEqual({
      contentId: '42',
      customTitle: '自定义标题',
      customSummary: '自定义摘要',
      sortWeight: 3,
      publishedAt: '2026-10-01T00:00:00.000Z',
      active: true,
      content: {
        title: '原标题',
        summary: '原摘要',
        originalUrl: 'https://example.com/a',
        imageUrl: null,
        publishedAt: '2026-09-30T00:00:00.000Z',
        sourceName: '某来源',
      },
    });
  });
});
