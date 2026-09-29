/**
 * 收藏 / 阅读进度 / 偏好的内存替身（单元测试用，不需要 MySQL）。
 *
 * ⚠ 替身必须与真实仓储**同语义**，否则「全绿」只是自证。
 * 与真实实现有关键差异的地方都在下面显式标注 —— Agent 05 的自查记录里有两条
 * 假绿正是替身与真实实现不一致造成的（`??` 吃掉显式 `null`、计数器当时间戳）。
 */

import {
  ArticleFontSize,
  UserTheme,
  type ContentType,
  type SourceKind,
  type SourceTier,
  type SourceType,
} from '@signal/contracts';
import type { BookmarkRepository, BookmarkRow } from '../../src/modules/bookmarks/repository';
import type {
  ReadingProgressRepository,
  ReadingProgressRow,
  UpsertProgressInput,
} from '../../src/modules/reading-progress/repository';
import type { ReadingResourceType } from '../../src/modules/reading-progress/resource-type';
import type {
  PreferencePatch,
  PreferenceRow,
  UserPreferenceRepository,
} from '../../src/modules/user-preferences/repository';

/* ------------------------------------------------------------------ */
/* 收藏                                                                */
/* ------------------------------------------------------------------ */

/** 固定形状的内容预览（字段值与真实来源无关）。 */
function preview(contentId: string): BookmarkRow['content'] {
  return {
    id: contentId,
    type: 'ARTICLE' as ContentType,
    title: `内容 ${contentId}`,
    summary: null,
    originalUrl: `https://example.com/${contentId}`,
    imageUrl: null,
    publishedAt: '2026-09-29T01:00:00.000Z',
    language: 'zh',
    source: {
      id: '7',
      name: '某来源',
      slug: 'some-source',
      type: 'RSS' as SourceType,
      kind: 'MEDIA' as SourceKind,
      tier: 'B' as SourceTier,
      official: false,
    },
  };
}

export class InMemoryBookmarkRepository implements BookmarkRepository {
  /** `${userId}:${contentId}` → 收藏时刻。 */
  private readonly rows = new Map<string, Date>();

  /** 可见内容集合。不在里面 = 不可见（不存在或未审核，**两者故意不可区分**）。 */
  readonly visibleContent = new Set<string>();

  /** `add` 被调用的次数（测幂等时要看「写了几次」）。 */
  addCalls = 0;

  seedVisible(...contentIds: string[]): void {
    for (const contentId of contentIds) this.visibleContent.add(contentId);
  }

  /** 预置一条收藏（用**指定的**时刻，便于断言「幂等没有刷新时间」）。 */
  seedBookmark(userId: string, contentId: string, createdAt: Date): void {
    this.rows.set(`${userId}:${contentId}`, createdAt);
  }

  has(userId: string, contentId: string): boolean {
    return this.rows.has(`${userId}:${contentId}`);
  }

  async isContentVisible(contentId: bigint): Promise<boolean> {
    return this.visibleContent.has(String(contentId));
  }

  async add(input: { userId: bigint; contentId: bigint; now: Date }): Promise<BookmarkRow | null> {
    this.addCalls += 1;
    const key = `${String(input.userId)}:${String(input.contentId)}`;
    if (!this.visibleContent.has(String(input.contentId))) return null;

    // 与真实实现同语义：**已存在时不改 createdAt**（这就是幂等）。
    if (!this.rows.has(key)) this.rows.set(key, input.now);
    return this.find({ userId: input.userId, contentId: input.contentId });
  }

  async remove(input: { userId: bigint; contentId: bigint }): Promise<void> {
    this.rows.delete(`${String(input.userId)}:${String(input.contentId)}`);
  }

  async find(input: { userId: bigint; contentId: bigint }): Promise<BookmarkRow | null> {
    const key = `${String(input.userId)}:${String(input.contentId)}`;
    const createdAt = this.rows.get(key);
    if (createdAt === undefined) return null;
    return {
      contentId: String(input.contentId),
      createdAt: createdAt.toISOString(),
      content: preview(String(input.contentId)),
    };
  }

  async list(input: {
    userId: bigint;
    limit: number;
    cursor?: string;
  }): Promise<{ rows: BookmarkRow[]; nextCursor: string | null }> {
    const userId = String(input.userId);
    const all = [...this.rows.entries()]
      .filter(([key]) => key.startsWith(`${userId}:`))
      .map(([key, createdAt]) => ({ contentId: key.slice(userId.length + 1), createdAt }))
      // ⚠ 与真实实现一致：**列表只显示内容仍可见的收藏**（docs/12）。
      // 收藏**行本身**保留 —— 内容恢复可见后会重新出现。
      .filter((row) => this.visibleContent.has(row.contentId))
      // 全序：createdAt 倒序 + contentId 倒序（与真实实现的 orderBy 一致）
      .sort((a, b) => {
        if (a.createdAt.getTime() !== b.createdAt.getTime()) {
          return b.createdAt.getTime() - a.createdAt.getTime();
        }
        return Number(b.contentId) - Number(a.contentId);
      });

    let start = 0;
    if (input.cursor !== undefined) {
      const separator = input.cursor.indexOf('-');
      const ms = Number(input.cursor.slice(0, separator));
      const contentId = input.cursor.slice(separator + 1);
      const index = all.findIndex(
        (row) => row.createdAt.getTime() === ms && row.contentId === contentId,
      );
      start = index === -1 ? all.length : index + 1;
    }

    const page = all.slice(start, start + input.limit);
    const hasMore = start + input.limit < all.length;
    const last = page.at(-1);
    return {
      rows: page.map((row) => ({
        contentId: row.contentId,
        createdAt: row.createdAt.toISOString(),
        content: preview(row.contentId),
      })),
      nextCursor:
        hasMore && last !== undefined
          ? `${String(last.createdAt.getTime())}-${last.contentId}`
          : null,
    };
  }
}

/* ------------------------------------------------------------------ */
/* 阅读进度                                                            */
/* ------------------------------------------------------------------ */

function progressKey(input: {
  userId: bigint;
  resourceType: ReadingResourceType;
  resourceId: bigint;
}): string {
  return `${String(input.userId)}:${input.resourceType}:${String(input.resourceId)}`;
}

export class InMemoryReadingProgressRepository implements ReadingProgressRepository {
  private readonly rows = new Map<string, ReadingProgressRow>();

  readonly visibleContent = new Set<string>();

  seedVisible(...contentIds: string[]): void {
    for (const contentId of contentIds) this.visibleContent.add(contentId);
  }

  async isResourceVisible(resourceId: bigint): Promise<boolean> {
    return this.visibleContent.has(String(resourceId));
  }

  async find(input: {
    userId: bigint;
    resourceType: ReadingResourceType;
    resourceId: bigint;
  }): Promise<ReadingProgressRow | null> {
    return this.rows.get(progressKey(input)) ?? null;
  }

  async upsert(input: UpsertProgressInput): Promise<ReadingProgressRow> {
    const key = progressKey(input);
    const existing = this.rows.get(key);
    const row: ReadingProgressRow = {
      resourceType: input.resourceType,
      resourceId: String(input.resourceId),
      progress: input.progress,
      lastPosition: input.lastPosition,
      // ⚠ 与真实实现同语义：`null` = **不改这一列**（不是擦掉）。
      // 替身第一版很容易写成 `input.completedAt?.toISOString() ?? null` ——
      // 那会在每次节流更新时把「已完成」擦掉，而测试看不出来。
      completedAt:
        input.completedAt !== null
          ? input.completedAt.toISOString()
          : (existing?.completedAt ?? null),
      // ⚠ 端口里**没有** `now`（真实现的 `updated_at` 由 Prisma 的 `@updatedAt`
      // 维护，见端口注释）—— 替身用自己的时间来模拟它。
      // 第一版让替身读 `input.now`、真实现忽略它，两套语义不同而各自都「测得过」。
      updatedAt: new Date().toISOString(),
    };
    this.rows.set(key, row);
    return row;
  }
}

/* ------------------------------------------------------------------ */
/* 偏好                                                                */
/* ------------------------------------------------------------------ */

export class InMemoryUserPreferenceRepository implements UserPreferenceRepository {
  private readonly rows = new Map<string, PreferenceRow>();

  /** `ensure` 被调用的次数（测「读不存在时补建」）。 */
  ensureCalls = 0;

  seed(userId: string, row: Partial<PreferenceRow> = {}): void {
    this.rows.set(userId, {
      theme: row.theme ?? UserTheme.SYSTEM,
      articleFontSize: row.articleFontSize ?? ArticleFontSize.DEFAULT,
      defaultTranslation: row.defaultTranslation ?? false,
      updatedAt: row.updatedAt ?? '2026-09-29T00:00:00.000Z',
    });
  }

  has(userId: string): boolean {
    return this.rows.has(userId);
  }

  async find(userId: bigint): Promise<PreferenceRow | null> {
    return this.rows.get(String(userId)) ?? null;
  }

  async ensure(userId: bigint): Promise<PreferenceRow> {
    this.ensureCalls += 1;
    const key = String(userId);
    const existing = this.rows.get(key);
    if (existing !== undefined) return existing;

    // 与真实实现同语义：用**数据库默认值**建一行。
    const created: PreferenceRow = {
      theme: UserTheme.SYSTEM,
      articleFontSize: ArticleFontSize.DEFAULT,
      defaultTranslation: false,
      updatedAt: '2026-09-29T00:00:00.000Z',
    };
    this.rows.set(key, created);
    return created;
  }

  async update(userId: bigint, patch: PreferencePatch): Promise<PreferenceRow> {
    const key = String(userId);
    const existing = this.rows.get(key);
    if (existing === undefined) throw new Error(`No preference row for user ${key}`);

    // ⚠ `Object.hasOwn` 而不是 `!== undefined`（更不能用 `??` / `||`）：
    // `defaultTranslation: false` 是一个**合法的显式值**，被当成「没给」
    // 就会让「关掉默认翻译」这个操作静默失效。
    const updated: PreferenceRow = {
      theme: Object.hasOwn(patch, 'theme') ? (patch.theme ?? existing.theme) : existing.theme,
      articleFontSize: Object.hasOwn(patch, 'articleFontSize')
        ? (patch.articleFontSize ?? existing.articleFontSize)
        : existing.articleFontSize,
      defaultTranslation: Object.hasOwn(patch, 'defaultTranslation')
        ? (patch.defaultTranslation ?? existing.defaultTranslation)
        : existing.defaultTranslation,
      updatedAt: '2026-09-29T01:00:00.000Z',
    };
    this.rows.set(key, updated);
    return updated;
  }
}

/** 一个可控时钟。 */
export function fixedClock(instant: Date): { now(): Date } {
  return { now: () => instant };
}
