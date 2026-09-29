/**
 * 收藏控制器（`docs/04` 的 User 段）。
 *
 * ```text
 * POST   /api/v1/bookmarks/:contentId
 * DELETE /api/v1/bookmarks/:contentId
 * GET    /api/v1/bookmarks
 * ```
 *
 * 与 `docs/04` 逐字一致；`apps/api/test/bookmarks-routes.spec.ts` 有守卫
 *（多一条即红）。
 *
 * ── 鉴权 ────────────────────────────────────────────────────────────
 * 整个控制器套 `AuthGuard`（`docs/11`：收藏是**登录用户**的能力）。
 * 未登录 → 401 `UNAUTHORIZED`。匿名访问**不可能**漏过去：
 * 守卫在控制器层，不在方法层 —— 后者漏一个方法就是一个洞。
 *
 * ⚠ **没有 `/subscriptions/*`**（规则 §13）：本模块只有上面三条路由，
 * 且仓库里有一条静态守卫扫描全项目确认没有任何订阅路由/表名。
 */

import {
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { envelope, cursorEnvelope } from '@signal/contracts';
import { AuthGuard, CurrentUser, type AuthUser } from '../../common/guards';
import { BookmarkService } from './service';
import { parseBookmarkListQuery } from './dto';

@UseGuards(AuthGuard)
@Controller('bookmarks')
export class BookmarkController {
  constructor(@Inject(BookmarkService) private readonly service: BookmarkService) {}

  /**
   * 加收藏。**幂等** —— 重复调用 200，`createdAt` 仍是第一次的时间。
   *
   * 用 `@HttpCode(200)` 而不是 `201`：本接口的核心语义是幂等，
   * 而 201 会让「这次真的创建了」与「早就收藏过了」看起来不一样 ——
   * 前端据此弹提示就会在双击时误报。
   */
  @Post(':contentId')
  @HttpCode(200)
  async add(
    @Param('contentId') contentId: string,
    @CurrentUser() user: AuthUser,
  ): Promise<unknown> {
    return envelope(await this.service.add(user.id, contentId));
  }

  /** 取消收藏。**幂等** —— 本来就没收藏也返回 200。 */
  @Delete(':contentId')
  async remove(
    @Param('contentId') contentId: string,
    @CurrentUser() user: AuthUser,
  ): Promise<unknown> {
    return envelope(await this.service.remove(user.id, contentId));
  }

  /** 我的收藏（按收藏时间倒序，cursor 分页）。 */
  @Get()
  async list(
    @Query() query: Record<string, unknown>,
    @CurrentUser() user: AuthUser,
  ): Promise<unknown> {
    const parsed = parseBookmarkListQuery(query);
    const result = await this.service.list(user.id, parsed);
    return cursorEnvelope(result.rows, result.nextCursor);
  }
}
