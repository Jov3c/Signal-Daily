/**
 * `BookmarkService` —— 收藏。
 *
 * ── `docs/11` ───────────────────────────────────────────────────────
 *
 * > Bookmark：绑定 Content，add/remove **幂等**。
 *
 * ── ⚠ 「幂等」在这里是两个不同的承诺 ────────────────────────────────
 *
 * | 动作 | 重复调用的结果 |
 * | ---- | -------------- |
 * | `add` | 200，`createdAt` **仍是第一次**的时间（不刷新） |
 * | `remove` | 200，本来就没收藏也算成功（目标状态已达成） |
 *
 * 两条都**不报错**。第一版很容易写成「已经收藏过 → 409」，
 * 但那会让前端的一次双击弹出错误提示 —— 而用户的意图已经达成了。
 *
 * ── ⚠ 收藏的准入与可见性 ────────────────────────────────────────────
 * - **加**收藏要求内容对外可见（`APPROVED`）。不可见 → **404**，
 *   与「不存在」同一个响应 —— 否则本接口会变成一个「某 id 是否被撤下」的探测器。
 * - **取消**收藏**不检查内容状态**：内容后来被撤下时，用户仍然必须能清理自己的收藏。
 *   这两条不对称是刻意的。
 */

import { Inject, Injectable } from '@nestjs/common';
import { AppError, PlatformErrorCode } from '@signal/contracts';
import { toBookmarkContentId } from './bigint-id';
import { BOOKMARK_CLOCK, BOOKMARK_REPOSITORY } from './repository';
import type { BookmarkRepository, BookmarkRow } from './repository';

export interface BookmarkClock {
  now(): Date;
}

/** `add` 的结果（幂等：重复调用得到同样的 `createdAt`）。 */
export type AddBookmarkResult = {
  contentId: string;
  bookmarked: true;
  createdAt: string;
};

/** `remove` 的结果。 */
export type RemoveBookmarkResult = {
  contentId: string;
  bookmarked: false;
};

@Injectable()
export class BookmarkService {
  constructor(
    @Inject(BOOKMARK_REPOSITORY) private readonly repository: BookmarkRepository,
    @Inject(BOOKMARK_CLOCK) private readonly clock: BookmarkClock,
  ) {}

  /**
   * 加收藏。
   *
   * ⚠ **不校验「这个用户存在吗」** —— `userId` 来自 `@CurrentUser()`，
   * 那是 Agent 02 用一次 `sessions` join `users` 查出来的真实主体。
   * 再加一次存在性检查只是多一次往返。
   */
  async add(rawUserId: string, rawContentId: string): Promise<AddBookmarkResult> {
    const userId = toBookmarkContentId(rawUserId);
    const contentId = toBookmarkContentId(rawContentId);
    if (userId === null) throw this.notFound(rawContentId);
    if (contentId === null) throw this.notFound(rawContentId);

    const row = await this.repository.add({ userId, contentId, now: this.clock.now() });
    // `null` = 内容不可见（或不存在）—— 两者对调用方是同一件事。
    if (row === null) throw this.notFound(rawContentId);

    return { contentId: row.contentId, bookmarked: true, createdAt: row.createdAt };
  }

  /**
   * 取消收藏。**幂等**：本来就没收藏也成功。
   *
   * 只校验 id 的形状 —— 一个畸形 id 不可能对应任何收藏，
   * 按「不存在」处理（404）比按「已经成功删除」处理更好排查。
   */
  async remove(rawUserId: string, rawContentId: string): Promise<RemoveBookmarkResult> {
    const userId = toBookmarkContentId(rawUserId);
    const contentId = toBookmarkContentId(rawContentId);
    if (userId === null) throw this.notFound(rawContentId);
    if (contentId === null) throw this.notFound(rawContentId);

    await this.repository.remove({ userId, contentId });
    return { contentId: String(contentId), bookmarked: false };
  }

  /** 列表（按收藏时间倒序）。 */
  async list(
    rawUserId: string,
    input: { limit: number; cursor?: string },
  ): Promise<{ rows: BookmarkRow[]; nextCursor: string | null }> {
    const userId = toBookmarkContentId(rawUserId);
    // `userId` 来自认证主体，理论上必然可绑定；不可绑定说明会话数据坏了，
    // 那是 401 而不是 404（调用方没做错任何事）。
    if (userId === null) {
      throw new AppError({
        // ⚠ 用注册表常量而不是字面量：Agent 02 的守卫要求源码里的
        // `code: '...'` 字面量符合 `DOMAIN_REASON` 形状，而 `UNAUTHORIZED`
        // **没有下划线**（平台码不遵守那条命名规则）—— 写成字面量会直接变红。
        code: PlatformErrorCode.UNAUTHORIZED,
        httpStatus: 401,
        safeMessage: 'The authenticated session does not map to a usable user id',
      });
    }
    return this.repository.list({
      userId,
      limit: input.limit,
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
    });
  }

  private notFound(contentId: string): AppError {
    return new AppError({
      code: 'CONTENT_NOT_VISIBLE',
      httpStatus: 404,
      safeMessage: 'Content not found',
      details: { contentId },
    });
  }
}
