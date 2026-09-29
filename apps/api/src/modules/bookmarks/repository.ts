/**
 * `BookmarkRepository` 端口 —— 收藏的持久化契约。
 *
 * 端口化的理由与 Agent 02/03/07 一致：单元测试用内存替身完整验服务层行为
 * （幂等、可见性过滤、分页），真实 SQL 语义由 `bookmarks-db.integration.spec.ts`
 * 在真库上跑一遍。
 *
 * ⚠ 只写 `bookmarks`，对 `contents` / `sources` 只**读**。
 */

import type { ContentType, SourceKind, SourceTier, SourceType } from '@signal/contracts';

/** 注入 token。 */
export const BOOKMARK_REPOSITORY = 'BOOKMARK_REPOSITORY';

/** 注入 token：可注入时钟（`createdAt` 必须可断言）。 */
export const BOOKMARK_CLOCK = 'BOOKMARK_CLOCK';

/** 收藏项里带出的内容预览 —— 收藏页要能画出卡片。 */
export type BookmarkedContent = {
  id: string;
  type: ContentType;
  title: string;
  summary: string | null;
  originalUrl: string;
  imageUrl: string | null;
  publishedAt: string | null;
  language: string;
  source: {
    id: string;
    name: string;
    slug: string;
    type: SourceType;
    kind: SourceKind;
    tier: SourceTier;
    official: boolean;
  };
};

export type BookmarkRow = {
  contentId: string;
  /** 收藏时刻（ISO）。**重复收藏返回的是最初那次的时间** —— 幂等的可见证据。 */
  createdAt: string;
  content: BookmarkedContent | null;
};

export interface BookmarkRepository {
  /**
   * 该内容是否**对外可见**（`docs/12`：不得返回 REJECTED / internal candidate）。
   *
   * 只有可见的内容能被收藏。返回 `false` 的内容对调用方等同于「不存在」——
   * 这样接口不会变成一个「某 id 是否存在/是否被撤下」的探测器。
   */
  isContentVisible(contentId: bigint): Promise<boolean>;

  /**
   * 加收藏。**幂等**：已存在时不改 `createdAt`，返回原来那一行。
   *
   * 返回 `null` 表示内容不可见（调用方转 404）。
   */
  add(input: { userId: bigint; contentId: bigint; now: Date }): Promise<BookmarkRow | null>;

  /** 取消收藏。**幂等**：本来就没有也返回 `true`（删除的目标状态已达成）。 */
  remove(input: { userId: bigint; contentId: bigint }): Promise<void>;

  /** 列表（按收藏时间倒序，cursor 分页）。 */
  list(input: {
    userId: bigint;
    limit: number;
    cursor?: string;
  }): Promise<{ rows: BookmarkRow[]; nextCursor: string | null }>;

  /** 某一条收藏（用于幂等响应）。 */
  find(input: { userId: bigint; contentId: bigint }): Promise<BookmarkRow | null>;
}
