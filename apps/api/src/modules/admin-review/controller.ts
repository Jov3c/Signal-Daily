/**
 * Admin 审核后端控制器。
 *
 * 路由**精确等于** `docs/04-api-contract.md` 的 Admin Review 与 Admin Event / Evidence
 * 两节，外加 `docs/09` 要求的 Dashboard：
 *
 * ```text
 * GET    /api/v1/admin/review
 * GET    /api/v1/admin/review/:contentId
 * POST   /api/v1/admin/review/:contentId/decision
 * POST   /api/v1/admin/review/bulk
 *
 * GET    /api/v1/admin/events/:eventId/evidence
 * POST   /api/v1/admin/events/:eventId/evidence
 * PATCH  /api/v1/admin/events/:eventId/evidence/:evidenceId
 * DELETE /api/v1/admin/events/:eventId/evidence/:evidenceId
 * POST   /api/v1/admin/events/:eventId/evidence/:evidenceId/set-primary
 *
 * GET    /api/v1/admin/dashboard
 * ```
 *
 * ── 鉴权 ────────────────────────────────────────────────────────────
 * 整个控制器套 `AdminOriginGuard` + `AdminGuard`（`docs/14`）。
 * 未认证 → 401；已认证但非 ADMIN → 403；变更类请求带不匹配 `Origin` → 403。
 * 授权按**库里的当前角色**判定，撤权立刻生效（Agent 02 的实现）。
 *
 * 守卫顺序与 Agent 03 一致：**先 Origin 再认证** —— Origin 是纯内存判断，
 * 让跨源请求在付出一次数据库往返之前就被拒掉。
 */

import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { envelope } from '@signal/contracts';
import { AdminGuard, CurrentUser, type AuthUser } from '../../common/guards';
import { AdminOriginGuard } from './admin-origin.guard';
import { EvidenceService } from './evidence.service';
import { NotificationService } from './notification.service';
import { ReviewService } from './review.service';
import { ADMIN_REVIEW_CLOCK, type AdminReviewClock } from './clock';
import { parseAddEvidenceBody, parseBulkBody, parseDecisionBody, parseReviewListQuery, parseUpdateEvidenceBody } from './dto/parse';

/**
 * 审核队列与决策。
 *
 * `docs/09` 的五个审核动作由 `POST :contentId/decision` 承载
 * （`action` 字段区分），批量只允许 Defer / Reject。
 */
@UseGuards(AdminOriginGuard, AdminGuard)
@Controller('admin/review')
export class ReviewController {
  constructor(
    @Inject(ReviewService) private readonly service: ReviewService,
    @Inject(ADMIN_REVIEW_CLOCK) private readonly clock: AdminReviewClock,
  ) {}

  /** 审核队列。默认 `finalScore DESC, publishedAt DESC`（`docs/09`）。 */
  @Get()
  async list(@Query() query: Record<string, unknown>): Promise<unknown> {
    const parsed = parseReviewListQuery(query);
    const result = await this.service.list(parsed);
    // 分页封套：`{data, meta:{page,pageSize,total,totalPages}}`（与 Agent 03 一致）。
    return { data: result.data, meta: result.meta };
  }

  /** 审核详情（`docs/09` 的「必须同时看到」清单）。 */
  @Get(':contentId')
  async detail(@Param('contentId') contentId: string): Promise<unknown> {
    return envelope(await this.service.detail(contentId));
  }

  /** 单条决策：Approve Featured / Approve Daily / Both / Defer / Reject。 */
  @Post(':contentId/decision')
  @HttpCode(200)
  async decide(
    @Param('contentId') contentId: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
  ): Promise<unknown> {
    const input = parseDecisionBody(body);
    return envelope(
      await this.service.decide(contentId, input.action, input.note ?? null, user.id, this.clock.now()),
    );
  }

  /** 批量决策 —— **只允许 Defer / Reject**（`docs/09`）。 */
  @Post('bulk')
  @HttpCode(200)
  async bulk(@Body() body: unknown, @CurrentUser() user: AuthUser): Promise<unknown> {
    const input = parseBulkBody(body);
    return envelope(
      await this.service.bulk(input.contentIds, input.action, input.note ?? null, user.id, this.clock.now()),
    );
  }
}

/**
 * 证据链的人工纠正（`docs/09`）。
 *
 * 单独一个控制器而不是塞进 ReviewController：`docs/04` 把它们归在
 * 「Admin Event / Evidence」一节，路径前缀也不同（`admin/events/...`）。
 */
@UseGuards(AdminOriginGuard, AdminGuard)
@Controller('admin/events')
export class EvidenceController {
  constructor(@Inject(EvidenceService) private readonly service: EvidenceService) {}

  @Get(':eventId/evidence')
  async list(@Param('eventId') eventId: string): Promise<unknown> {
    return envelope(await this.service.list(eventId));
  }

  /** 人工增加一个 Evidence URL（`docs/09`）。 */
  @Post(':eventId/evidence')
  @HttpCode(201)
  async add(
    @Param('eventId') eventId: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
  ): Promise<unknown> {
    const input = parseAddEvidenceBody(body);
    return envelope(await this.service.add(eventId, input, user.id));
  }

  /** 修改 Evidence type / 标题 / URL（`docs/09`）。 */
  @Patch(':eventId/evidence/:evidenceId')
  async update(
    @Param('eventId') eventId: string,
    @Param('evidenceId') evidenceId: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
  ): Promise<unknown> {
    const input = parseUpdateEvidenceBody(body);
    return envelope(await this.service.update(eventId, evidenceId, input, user.id));
  }

  /** 删除错误 Evidence（`docs/09`）。 */
  @Delete(':eventId/evidence/:evidenceId')
  async remove(
    @Param('eventId') eventId: string,
    @Param('evidenceId') evidenceId: string,
    @CurrentUser() user: AuthUser,
  ): Promise<unknown> {
    return envelope(await this.service.remove(eventId, evidenceId, user.id));
  }

  /** 设置 Primary（`docs/09`）。 */
  @Post(':eventId/evidence/:evidenceId/set-primary')
  @HttpCode(200)
  async setPrimary(
    @Param('eventId') eventId: string,
    @Param('evidenceId') evidenceId: string,
    @CurrentUser() user: AuthUser,
  ): Promise<unknown> {
    return envelope(await this.service.setPrimary(eventId, evidenceId, user.id));
  }
}

/** Dashboard（`docs/09` 的「Dashboard」一节）。 */
@UseGuards(AdminOriginGuard, AdminGuard)
@Controller('admin/dashboard')
export class DashboardController {
  constructor(
    @Inject(ReviewService) private readonly reviews: ReviewService,
    @Inject(NotificationService) private readonly notifications: NotificationService,
    @Inject(ADMIN_REVIEW_CLOCK) private readonly clock: AdminReviewClock,
  ) {}

  /**
   * 后台首页的数字。
   *
   * ⚠ 顺带**跑一次通知扫描**（幂等）—— 这样本地开发不必额外起一个定时器，
   * 管理员一打开后台就会看到最新的告警。定时器仍然存在（见 `module.ts`），
   * 这里只是让它不是唯一路径。**已记入 HANDOFF**：这是一种「读操作带副作用」
   * 的设计，之所以可接受是因为扫描是幂等的、失败也不影响响应。
   */
  @Get()
  async dashboard(): Promise<unknown> {
    const now = this.clock.now();
    const stats = await this.reviews.dashboard(now);
    await this.notifications.scan().catch(() => undefined);
    return envelope(stats);
  }
}
