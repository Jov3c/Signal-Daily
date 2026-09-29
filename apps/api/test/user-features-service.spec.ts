/**
 * 收藏 / 阅读进度 / 偏好的服务层守卫。
 *
 * 覆盖任务书点名的四项：**Bookmark 幂等**、**progress complete**、
 * **偏好校验/同步**，以及「匿名拒绝」（HTTP 层由 `user-features-routes.spec.ts` 覆盖）。
 *
 * ⚠ 测试数据用**中文**与真实形态（§23.4 第 4 问）：
 * 标题、来源名、`lastPosition` 都用真实会出现的内容。
 * Agent 01 的 FULLTEXT 事故（用 ASCII 探针测中文搜索、一直是绿的）是这里的直接教训。
 */

import { describe, expect, it } from 'vitest';
import { ArticleFontSize, UserTheme, isAppError } from '@signal/contracts';
import { BookmarkService } from '../src/modules/bookmarks/service';
import {
  ReadingProgressService,
  COMPLETION_THRESHOLD,
} from '../src/modules/reading-progress/service';
import { UserPreferenceService } from '../src/modules/user-preferences/service';
import {
  InMemoryBookmarkRepository,
  InMemoryReadingProgressRepository,
  InMemoryUserPreferenceRepository,
  fixedClock,
} from './support/user-features-fakes';

/** 上海时间 2026-09-29 09:00（= UTC 01:00）。 */
const NOW = new Date('2026-09-29T01:00:00.000Z');
const LATER = new Date('2026-09-29T02:00:00.000Z');
const USER = '42';

/** 断言一个 AppError 的 code。 */
function expectAppError(error: unknown, code: string): void {
  expect(isAppError(error), `期望 AppError，实际是 ${String(error)}`).toBe(true);
  if (isAppError(error)) expect(error.code).toBe(code);
}

/* ------------------------------------------------------------------ */
/* 收藏                                                                */
/* ------------------------------------------------------------------ */

function bookmarkSetup() {
  const repository = new InMemoryBookmarkRepository();
  repository.seedVisible('100', '101');
  return {
    repository,
    service: new BookmarkService(repository, fixedClock(NOW)),
  };
}

describe('收藏 —— 幂等（docs/11：add/remove 幂等）', () => {
  it('加收藏成功，返回收藏时刻', async () => {
    const { service } = bookmarkSetup();
    const result = await service.add(USER, '100');

    expect(result).toEqual({
      contentId: '100',
      bookmarked: true,
      createdAt: NOW.toISOString(),
    });
  });

  it('⚠ **重复收藏不报错，且 `createdAt` 不刷新**（这是「幂等」的可见证据）', async () => {
    const { service, repository } = bookmarkSetup();

    const first = await service.add(USER, '100');
    // 换一个时钟再收藏一次 —— 时间**必须**还是第一次那个
    const later = new BookmarkService(repository, fixedClock(LATER));
    const second = await later.add(USER, '100');

    expect(second.createdAt).toBe(first.createdAt);
    expect(second.createdAt).toBe(NOW.toISOString());
    expect(second.createdAt).not.toBe(LATER.toISOString());
    // 确实尝试写了两次（不是「因为已存在就提前返回」）
    expect(repository.addCalls).toBe(2);
  });

  it('⚠ **取消收藏幂等**：本来就没收藏也成功（目标状态已达成）', async () => {
    const { service } = bookmarkSetup();

    // 没有收藏过
    await expect(service.remove(USER, '100')).resolves.toEqual({
      contentId: '100',
      bookmarked: false,
    });
    // 收藏两次再取消两次
    await service.add(USER, '100');
    await service.remove(USER, '100');
    await expect(service.remove(USER, '100')).resolves.toMatchObject({ bookmarked: false });
  });

  it('⚠ **取消收藏不检查内容是否可见** —— 内容被撤下后用户仍必须能清理自己的收藏', async () => {
    const { service, repository } = bookmarkSetup();
    await service.add(USER, '100');

    // 模拟内容后来被 Agent 07 撤下
    repository.visibleContent.delete('100');

    await expect(service.remove(USER, '100')).resolves.toMatchObject({ bookmarked: false });
    expect(repository.has(USER, '100')).toBe(false);
  });

  it('⚠ 收藏不可见的内容 → 404 `CONTENT_NOT_VISIBLE`（两种情形同一个响应）', async () => {
    const { service, repository } = bookmarkSetup();

    // 情形一：**根本不存在**
    await expect(service.add(USER, '999')).rejects.toSatisfy((error: unknown) => {
      expectAppError(error, 'CONTENT_NOT_VISIBLE');
      return true;
    });

    // 情形二：**存在但未审核**（从可见集合里去掉）
    // §23 审查的 F6：第一版这条用例的注释写了 101，实际只测了 999 ——
    // 于是「存在但不可见」这条路径**从来没被走到**，而这正是
    //「不暴露内容是否存在」这个设计的核心情形。
    repository.visibleContent.delete('101');
    await expect(service.add(USER, '101')).rejects.toSatisfy((error: unknown) => {
      expectAppError(error, 'CONTENT_NOT_VISIBLE');
      return true;
    });
  });

  it('⚠ 两种「不可见」返回**同一个**码与同一个状态码（不构成存在性探测器）', async () => {
    const { service, repository } = bookmarkSetup();
    repository.visibleContent.delete('101');

    const codes: string[] = [];
    const statuses: number[] = [];
    for (const contentId of ['999', '101']) {
      await service.add(USER, contentId).catch((error: unknown) => {
        if (isAppError(error)) {
          codes.push(String(error.code));
          statuses.push(error.httpStatus);
        }
      });
    }

    // 「不存在」与「存在但被撤下」必须**完全不可区分** —— 否则调用方
    // 可以用这个接口探测某篇内容是否被撤下。
    expect(new Set(codes).size).toBe(1);
    expect(new Set(statuses).size).toBe(1);
    expect(codes[0]).toBe('CONTENT_NOT_VISIBLE');
  });

  it('⚠ 形如合法但**超出 BIGINT 有符号上界**的 id → 404，而不是让驱动抛 500', async () => {
    const { service } = bookmarkSetup();

    await expect(service.add(USER, '18446744073709551615')).rejects.toSatisfy((error: unknown) => {
      // `common/prisma/bigint-id` 缺上界（Agent 03 / 07 已各提过一次），
      // 本模块在自己的边界上收敛 —— 否则这里会变成 500。
      expectAppError(error, 'CONTENT_NOT_VISIBLE');
      return true;
    });
  });
});

describe('收藏 —— 列表与分页', () => {
  it('按收藏时间倒序（最近收藏的在前）', async () => {
    const { service, repository } = bookmarkSetup();
    repository.seedBookmark(USER, '100', new Date('2026-09-29T01:00:00.000Z'));
    repository.seedBookmark(USER, '101', new Date('2026-09-29T02:00:00.000Z'));

    const result = await service.list(USER, { limit: 10 });
    expect(result.rows.map((row) => row.contentId)).toEqual(['101', '100']);
  });

  it('分页：`nextCursor` 只在还有下一页时给出', async () => {
    const { service, repository } = bookmarkSetup();
    // 五条都要可见（列表会过滤掉内容不可见的收藏，见 docs/12）
    repository.seedVisible('102', '103', '104');
    for (let index = 0; index < 5; index += 1) {
      repository.seedBookmark(USER, String(100 + index), new Date(Date.UTC(2026, 8, 29, 1, index)));
    }

    const first = await service.list(USER, { limit: 2 });
    expect(first.rows).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();

    const second = await service.list(USER, { limit: 2, cursor: first.nextCursor as string });
    // 两页不重叠 —— 这是游标分页的核心承诺
    expect(second.rows.map((row) => row.contentId)).not.toEqual(
      first.rows.map((row) => row.contentId),
    );

    const third = await service.list(USER, { limit: 2, cursor: second.nextCursor as string });
    expect(third.rows).toHaveLength(1);
    expect(third.nextCursor).toBeNull();
  });

  it('⚠ **同一毫秒收藏多条也不会漏行或重复**（复合游标的理由）', async () => {
    const { service, repository } = bookmarkSetup();
    // ⚠ 四条都必须是**可见**的 —— 列表会过滤掉内容已不可见的收藏
    //（`docs/12`），否则这里只会有两条，用例测的就不是游标了。
    repository.seedVisible('102', '103');
    const sameInstant = new Date('2026-09-29T01:00:00.000Z');
    for (const contentId of ['100', '101', '102', '103']) {
      repository.seedBookmark(USER, contentId, sameInstant);
    }

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 5; page += 1) {
      const result: { rows: { contentId: string }[]; nextCursor: string | null } =
        await service.list(USER, { limit: 2, ...(cursor === undefined ? {} : { cursor }) });
      seen.push(...result.rows.map((row) => row.contentId));
      if (result.nextCursor === null) break;
      cursor = result.nextCursor;
    }

    // 四条各出现一次 —— 只用 contentId 当游标时这里会漏
    expect([...seen].sort()).toEqual(['100', '101', '102', '103']);
  });

  it('别人的收藏不会出现在我的列表里', async () => {
    const { service, repository } = bookmarkSetup();
    repository.seedBookmark('42', '100', NOW);
    repository.seedBookmark('43', '101', NOW);

    const result = await service.list(USER, { limit: 10 });
    expect(result.rows.map((row) => row.contentId)).toEqual(['100']);
  });

  it('内容已不可见的收藏不出现在列表里（docs/12），但**收藏行保留**', async () => {
    const { service, repository } = bookmarkSetup();
    repository.seedBookmark(USER, '100', NOW);
    repository.seedBookmark(USER, '101', NOW);
    repository.visibleContent.delete('101');

    const result = await service.list(USER, { limit: 10 });
    expect(result.rows.map((row) => row.contentId)).toEqual(['100']);
    // 行还在 —— 内容恢复可见后会重新出现
    expect(repository.has(USER, '101')).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* 阅读进度                                                            */
/* ------------------------------------------------------------------ */

function progressSetup() {
  const repository = new InMemoryReadingProgressRepository();
  repository.seedVisible('100', '101');
  return {
    repository,
    service: new ReadingProgressService(repository, fixedClock(NOW)),
  };
}

const CONTENT_BODY = (progress: number, extra: Record<string, unknown> = {}) => ({
  resourceType: 'CONTENT' as const,
  resourceId: '100',
  progress,
  lastPosition: null,
  ...extra,
});

describe('阅读进度 —— 完成规则（docs/11：>=0.95 可 completed）', () => {
  it('低于阈值不置 completedAt', async () => {
    const { service } = progressSetup();
    const row = await service.upsert(USER, CONTENT_BODY(0.5));
    expect(row.completedAt).toBeNull();
  });

  it('**跨过 0.95 的那一次**置 completedAt', async () => {
    const { service } = progressSetup();
    const row = await service.upsert(USER, CONTENT_BODY(COMPLETION_THRESHOLD));
    expect(row.completedAt).toBe(NOW.toISOString());
  });

  it('⚠ **已完成的不回退** —— 之后读到 0.2 也不清空 completedAt', async () => {
    const { repository, service } = progressSetup();
    await service.upsert(USER, CONTENT_BODY(0.98));

    const later = new ReadingProgressService(repository, fixedClock(LATER));
    const row = await later.upsert(USER, CONTENT_BODY(0.2));

    expect(row.progress).toBe(0.2);
    // 用户已经读完过 —— 「我读过哪些」的答案不该被一次误触抹掉
    expect(row.completedAt).toBe(NOW.toISOString());
  });

  it('⚠ **不覆盖已有的完成时间** —— 重复写 0.98 不会把时间刷成现在', async () => {
    const { repository, service } = progressSetup();
    await service.upsert(USER, CONTENT_BODY(0.98));

    const later = new ReadingProgressService(repository, fixedClock(LATER));
    const row = await later.upsert(USER, CONTENT_BODY(0.99));

    expect(row.completedAt).toBe(NOW.toISOString());
    expect(row.completedAt).not.toBe(LATER.toISOString());
  });

  it('写入是 **upsert** 不是 append（同一份内容只有一行）', async () => {
    const { repository, service } = progressSetup();
    await service.upsert(USER, CONTENT_BODY(0.3));
    await service.upsert(USER, CONTENT_BODY(0.6));

    const row = await repository.find({
      userId: 42n,
      resourceType: 'CONTENT',
      resourceId: 100n,
    });
    expect(row?.progress).toBe(0.6);
  });

  it('`lastPosition` 会落库（中文与 emoji 都保真）', async () => {
    const { service } = progressSetup();
    const position = '第三章 · 第二节 🙂';
    const row = await service.upsert(USER, CONTENT_BODY(0.4, { lastPosition: position }));
    expect(row.lastPosition).toBe(position);
  });

  it('不可见的内容 → 404（不会往库里灌无主的进度行）', async () => {
    const { service } = progressSetup();
    await expect(
      service.upsert(USER, { ...CONTENT_BODY(0.5), resourceId: '999' }),
    ).rejects.toSatisfy((error: unknown) => {
      expectAppError(error, 'CONTENT_NOT_VISIBLE');
      return true;
    });
  });

  it('⚠ 超界 BIGINT 的 `resourceId` → 404（不是让驱动抛 500）', async () => {
    const { service } = progressSetup();
    await expect(
      service.upsert(USER, { ...CONTENT_BODY(0.5), resourceId: '18446744073709551615' }),
    ).rejects.toSatisfy((error: unknown) => {
      expectAppError(error, 'CONTENT_NOT_VISIBLE');
      return true;
    });
  });
});

/* ------------------------------------------------------------------ */
/* 偏好                                                                */
/* ------------------------------------------------------------------ */

function preferenceSetup() {
  const repository = new InMemoryUserPreferenceRepository();
  return {
    repository,
    service: new UserPreferenceService(repository),
  };
}

describe('阅读偏好 —— 读与补建', () => {
  it('已有行时原样返回', async () => {
    const { repository, service } = preferenceSetup();
    repository.seed(USER, { theme: UserTheme.DARK, articleFontSize: ArticleFontSize.LARGE });

    const row = await service.get(USER);
    expect(row).toMatchObject({
      theme: UserTheme.DARK,
      articleFontSize: ArticleFontSize.LARGE,
    });
  });

  it('⚠ 行不存在时**补建默认值**，而不是 404（每个用户都该有偏好）', async () => {
    const { service, repository } = preferenceSetup();
    expect(repository.has(USER)).toBe(false);

    const row = await service.get(USER);

    expect(row).toMatchObject({
      theme: UserTheme.SYSTEM,
      articleFontSize: ArticleFontSize.DEFAULT,
      defaultTranslation: false,
    });
    expect(repository.has(USER)).toBe(true);
  });
});

describe('阅读偏好 —— 同步（部分更新）', () => {
  it('只给一个字段时，其余保持不变', async () => {
    const { repository, service } = preferenceSetup();
    repository.seed(USER, {
      theme: UserTheme.DARK,
      articleFontSize: ArticleFontSize.LARGE,
      defaultTranslation: true,
    });

    const row = await service.update(USER, { theme: UserTheme.LIGHT });

    expect(row.theme).toBe(UserTheme.LIGHT);
    expect(row.articleFontSize).toBe(ArticleFontSize.LARGE);
    expect(row.defaultTranslation).toBe(true);
  });

  it('⚠ **`defaultTranslation: false` 是合法的显式值**，不能被当成「没给」', async () => {
    const { repository, service } = preferenceSetup();
    repository.seed(USER, { defaultTranslation: true });

    const row = await service.update(USER, { defaultTranslation: false });
    expect(row.defaultTranslation).toBe(false);
  });

  it('三个字段可以一次都改', async () => {
    const { repository, service } = preferenceSetup();
    repository.seed(USER);

    const row = await service.update(USER, {
      theme: UserTheme.DARK,
      articleFontSize: ArticleFontSize.SMALL,
      defaultTranslation: true,
    });

    expect(row).toMatchObject({
      theme: UserTheme.DARK,
      articleFontSize: ArticleFontSize.SMALL,
      defaultTranslation: true,
    });
  });

  it('⚠ 更新一个**还没有偏好行**的用户：先补建再改（不让底层抛 P2025 → 500）', async () => {
    const { service, repository } = preferenceSetup();
    expect(repository.has(USER)).toBe(false);

    const row = await service.update(USER, { theme: UserTheme.DARK });

    expect(row.theme).toBe(UserTheme.DARK);
    expect(repository.ensureCalls).toBeGreaterThan(0);
  });

  it('`updatedAt` 会变（客户端据此做「上次同步于」）', async () => {
    const { repository, service } = preferenceSetup();
    repository.seed(USER, { updatedAt: '2026-09-29T00:00:00.000Z' });

    const row = await service.update(USER, { theme: UserTheme.DARK });
    expect(row.updatedAt).not.toBe('2026-09-29T00:00:00.000Z');
  });
});
