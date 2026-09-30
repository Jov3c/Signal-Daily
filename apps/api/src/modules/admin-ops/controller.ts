/**
 * `admin-ops` 的三个后台只读视图 + 通知已读标记。
 *
 * ```text
 * GET  /api/v1/admin/jobs                    作业运行历史（分页 + 按 jobType/status 筛）
 * GET  /api/v1/admin/notifications           管理员通知（分页 + 按 status 筛）
 * POST /api/v1/admin/notifications/:id/read  标记已读（幂等）
 * GET  /api/v1/admin/ai-usage                AI 用量与成本（最近 N 个业务日）
 * ```
 *
 * ── ⚠ 这四条**不在** `docs/04` 里 ────────────────────────────────────
 * `docs/04` 的 Admin 三节（Source Registry / Review / Event·Evidence）
 * 加上 Agent 07 的 `/admin/dashboard` 覆盖了 Agent 12 九个页面里的六个。
 * **Jobs / Notifications / AI Usage 三页没有任何接口**，而它们的数据是
 * 真实存在的（`job_runs` / `ai_runs` / `admin_notifications` 都有写入方）。
 *
 * 补这四条要动**冻结的 API 契约**（`docs/00`：API URL 是冻结契约，
 * 只有 Agent 00 / 01 / 14 能改）。用户于 2026-09-30 **明确授权**，
 * 已如实记入 `handoffs/CONTRACT_CHANGE_REQUEST-agent-12.md` 第 1 项 ——
 * 包括其中那条 `POST .../read`（任务书没要求，是本模块判断「一个只有
 * 未读徽标、没有已读动作的页面不可用」而加的，请裁决保留与否）。
 *
 * ── 鉴权 ────────────────────────────────────────────────────────────
 * 与 Agent 03 / 07 一致：`AdminOriginGuard` + `AdminGuard`，
 * **先 Origin 再认证**（Origin 是纯内存判断，让跨源请求在付出一次
 * 数据库往返之前就被拒掉）。
 *
 * `AdminOriginGuard` 从 `../admin-review/admin-origin.guard` 复用 ——
 * 那是 07 落地、08 的 featured/daily 也复用的那一份
 * （`modules/sources` 里另有一份更早的 80 行副本，本模块**不**再用它）。
 * 与之配套的 `ADMIN_ORIGIN_CONFIG` provider 必须在自己的模块里提供，
 * 否则模块能编译、能过全部单测，一挂进根模块就**启动即崩**
 * （Agent 08 的 DI 接线测试实测抓过这一条）。
 */

import { Controller, Get, HttpCode, Inject, Param, Post, Query, UseGuards } from '@nestjs/common';
import { envelope } from '@signal/contracts';
import { AdminGuard, CurrentUser, type AuthUser } from '../../common/guards';
import { AdminOriginGuard } from '../admin-review/admin-origin.guard';
import { parseAiUsageQuery, parseJobRunListQuery, parseNotificationListQuery } from './dto/parse';
import { AdminOpsService } from './service';

/** 作业运行历史（`docs/09` 之外的补充视图，见文件头）。 */
@UseGuards(AdminOriginGuard, AdminGuard)
@Controller('admin/jobs')
export class JobsController {
  constructor(@Inject(AdminOpsService) private readonly service: AdminOpsService) {}

  @Get()
  async list(@Query() query: Record<string, unknown>): Promise<unknown> {
    return this.service.listJobRuns(parseJobRunListQuery(query));
  }
}

/** 管理员通知（数据由 Agent 07 的通知扫描写入，本模块只读）。 */
@UseGuards(AdminOriginGuard, AdminGuard)
@Controller('admin/notifications')
export class NotificationsController {
  constructor(@Inject(AdminOpsService) private readonly service: AdminOpsService) {}

  @Get()
  async list(@Query() query: Record<string, unknown>): Promise<unknown> {
    return this.service.listNotifications(parseNotificationListQuery(query));
  }

  /** 标记已读。幂等：已读的返回原行，不改写 `readAt`。 */
  @Post(':id/read')
  @HttpCode(200)
  async markRead(@Param('id') id: string, @CurrentUser() user: AuthUser): Promise<unknown> {
    return envelope(await this.service.markNotificationRead(id, user.id));
  }
}

/** AI 用量与成本（数据由 Agent 06 的 AI 作业写入）。 */
@UseGuards(AdminOriginGuard, AdminGuard)
@Controller('admin/ai-usage')
export class AiUsageController {
  constructor(@Inject(AdminOpsService) private readonly service: AdminOpsService) {}

  @Get()
  async view(@Query() query: Record<string, unknown>): Promise<unknown> {
    return envelope(await this.service.aiUsage(parseAiUsageQuery(query).days));
  }
}
