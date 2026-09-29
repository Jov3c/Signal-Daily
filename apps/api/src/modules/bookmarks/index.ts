/**
 * Agent 09 — 收藏（Bookmarks）的公开面。
 *
 * 下游（Agent 13 的前台、Agent 14）只应从本文件 import，
 * 不要深入子目录 —— 子目录里的文件是实现细节。
 */

/* 模块与服务 */
export { BookmarksModule } from './module';
export { BookmarkService, type AddBookmarkResult, type RemoveBookmarkResult } from './service';

/* 持久化端口（下游要 override 时用） */
export {
  BOOKMARK_CLOCK,
  BOOKMARK_REPOSITORY,
  type BookmarkRepository,
  type BookmarkRow,
  type BookmarkedContent,
} from './repository';

/* 游标编解码（Agent 10 若要把收藏并进统一列表，用同一套，别自己发明） */
export { decodeBookmarkCursor, encodeBookmarkCursor } from './prisma-bookmarks.repository';

/* 请求校验 */
export { MAX_BOOKMARK_LIMIT, parseBookmarkListQuery, type BookmarkListQuery } from './dto';

/* id 收敛（对 `common/prisma/bigint-id` 的**上界**补充，见文件头说明） */
export { MAX_BINDABLE_ID, toBookmarkContentId } from './bigint-id';
