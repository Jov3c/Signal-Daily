/**
 * 收藏的请求解析与校验。
 *
 * 手写校验（与 Agent 02/03/07/08 同一取舍）：能把**所有**错误一次收齐，
 * 且「字段没给」与「给了 null」的区别可以显式表达。
 */

import { DEFAULT_CURSOR_LIMIT } from '@signal/contracts';
import { invalid } from '../../common/validation';
import { decodeBookmarkCursor } from './prisma-bookmarks.repository';

/**
 * 一次列表最多返回多少条。
 *
 * 取 50：收藏是**个人列表**，用户翻到第 50 条已经很罕见；
 * 而上限存在的意义是「不让一次请求把用户的全部收藏读进内存」。
 */
export const MAX_BOOKMARK_LIMIT = 50;

export type BookmarkListQuery = {
  limit: number;
  cursor?: string;
};

// 本模块原先自带 `invalid` 的副本，现在统一从 `common/validation` 引用；
// 对外仍继续导出，保持既有的导入面不变。
export { invalid };

/**
 * `GET /bookmarks` 的查询参数。
 *
 * `limit` 越界**夹到边界**而不报错（分页参数不值得 400，与 Agent 07 一致）；
 * `cursor` 非法**报错** —— 静默忽略会让用户以为自己翻到了下一页，
 * 而实际上看到的还是第一页。
 */
export function parseBookmarkListQuery(query: Record<string, unknown>): BookmarkListQuery {
  const errors: string[] = [];

  const limitRaw = query['limit'];
  let limit: number = DEFAULT_CURSOR_LIMIT;
  if (limitRaw !== undefined && limitRaw !== null && limitRaw !== '') {
    const parsed = Number(limitRaw);
    if (!Number.isInteger(parsed) || parsed < 1) {
      errors.push('limit: must be a positive integer');
    } else {
      limit = Math.min(parsed, MAX_BOOKMARK_LIMIT);
    }
  }

  const cursor = query['cursor'];
  if (cursor !== undefined && cursor !== null && cursor !== '') {
    // 复合游标 `{createdAtMillis}-{contentId}`（见 `prisma-bookmarks.repository.ts`）。
    //
    // ⚠ 用**仓储的同一个解码器**校验，而不是在这里另写一条正则。
    // 第一版写的是 `/^\d{1,20}-\d{1,20}$/`，它放行了
    // `99999999999999999999-1`（20 位毫秒）—— 而解码器用
    // `Number.isSafeInteger` 拒掉它，于是仓储抛普通 `Error` → **500 而不是 400**
    //（§23 审查的 F2，已用 node 复算确认 throw 发生在任何 DB 调用之前）。
    // 「两个校验器各自表述同一个格式」本身就是这个 bug 的成因。
    if (typeof cursor !== 'string' || decodeBookmarkCursor(cursor) === null) {
      errors.push('cursor: must be an opaque cursor returned by this endpoint');
    }
  }

  if (errors.length > 0) throw invalid(errors);

  return {
    limit,
    ...(typeof cursor === 'string' && cursor !== '' ? { cursor } : {}),
  };
}
