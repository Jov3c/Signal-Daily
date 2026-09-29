/**
 * 阅读偏好控制器（`docs/04` 的 User 段）。
 *
 * ```text
 * GET /api/v1/me/preferences
 * PUT /api/v1/me/preferences
 * ```
 *
 * ── ⚠ 这个路径前缀是 `me/`，而 `GET /me` 属 Agent 02 ────────────────
 * 两个控制器声明不同的前缀（`me` vs `me/preferences`），Nest 的路由表
 * 不会冲突 —— Agent 02 的 HANDOFF 也明确「`GET/PUT /me/preferences`
 * 属你的范围」。它那条「Auth 模块只有 7 条路由」的断言读的是它自己那套
 * 测试应用，不会误伤本模块。
 *
 * 套 `AuthGuard`（`docs/11`：偏好是登录用户的个人数据）。
 */

import { Body, Controller, Get, Inject, Put, UseGuards } from '@nestjs/common';
import { envelope } from '@signal/contracts';
import { AuthGuard, CurrentUser, type AuthUser } from '../../common/guards';
import { UserPreferenceService } from './service';
import { parseUpdatePreferencesBody } from './dto';

@UseGuards(AuthGuard)
@Controller('me/preferences')
export class UserPreferenceController {
  constructor(@Inject(UserPreferenceService) private readonly service: UserPreferenceService) {}

  /** 读偏好。行不存在时用数据库默认值补建（见 service 的说明）。 */
  @Get()
  async get(@CurrentUser() user: AuthUser): Promise<unknown> {
    return envelope(await this.service.get(user.id));
  }

  /**
   * 改偏好（**部分更新**）。
   *
   * 用 `PUT`（`docs/04` 的字面写法）但语义是「部分更新」：
   * 没给的键不动。这与「PUT 应当整体替换」的严格语义有出入 ——
   * 已记入 HANDOFF 的设计取舍；`docs/04` 定的是路径与动词，不是语义细节。
   */
  @Put()
  async update(@Body() body: unknown, @CurrentUser() user: AuthUser): Promise<unknown> {
    const parsed = parseUpdatePreferencesBody(body);
    return envelope(await this.service.update(user.id, parsed));
  }
}
