/**
 * 阅读进度控制器（`docs/04` 的 User 段）。
 *
 * ```text
 * PUT /api/v1/reading-progress
 * ```
 *
 * ⚠ **只有一条路由**：读进度不是独立接口 —— 「我读到哪了」由内容详情
 * （`GET /contents/:id`，Agent 10）或收藏列表按需带回，
 * 而不是让前端对每篇文章各发一次请求。
 *
 * 套 `AuthGuard`（`docs/11`：进度是登录用户的个人数据）。
 */

import { Body, Controller, Inject, Put, UseGuards } from '@nestjs/common';
import { envelope } from '@signal/contracts';
import { AuthGuard, CurrentUser, type AuthUser } from '../../common/guards';
import { ReadingProgressService } from './service';
import { parseUpsertProgressBody } from './dto';

@UseGuards(AuthGuard)
@Controller('reading-progress')
export class ReadingProgressController {
  constructor(@Inject(ReadingProgressService) private readonly service: ReadingProgressService) {}

  /**
   * 写入进度（upsert）。
   *
   * 用 `PUT`（幂等语义）而不是 `POST`：同一份进度提交两次结果相同 ——
   * `docs/11` 说客户端会**节流更新**，重试与重复提交是常态。
   */
  @Put()
  async upsert(@Body() body: unknown, @CurrentUser() user: AuthUser): Promise<unknown> {
    const parsed = parseUpsertProgressBody(body);
    return envelope(await this.service.upsert(user.id, parsed));
  }
}
