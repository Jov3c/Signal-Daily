/**
 * 精选的控制器 —— **两个**：Admin 管理面与 Public 读取面。
 *
 * ⚠ **Admin 路径由本模块定义**：`docs/04` 的 Admin 段只写了
 * 「沿用 v1.0 的 Featured / Daily API」，而 v1.0 不在本包里。
 * 因此下面的路径是**本模块的设计决定**，已记入 HANDOFF 并提 CCR
 *（Agent 10 / 12 需要知道确切形状）。
 *
 * ```text
 * GET    /api/v1/admin/featured            列表（含未上架）
 * POST   /api/v1/admin/featured            加入精选（仅 APPROVED + 勾选 Featured）
 * PATCH  /api/v1/admin/featured/:contentId 自定义标题 / 摘要 / 权重 / 上下架
 * DELETE /api/v1/admin/featured/:contentId 下架（软删除，保留历史）
 *
 * GET    /api/v1/featured                  公开读取（只返回有效项）
 * ```
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
import { AppError, PlatformErrorCode, envelope, cursorEnvelope } from '@signal/contracts';
import { AdminGuard, CurrentUser, type AuthUser } from '../../common/guards';
import { AdminOriginGuard } from '../admin-review/admin-origin.guard';
import { FeaturedService } from './service';
import { parseCreateFeaturedBody, parseFeaturedListQuery, parseUpdateFeaturedBody } from './dto';

/** 入参校验失败。 */
function invalid(errors: string[]): AppError {
  return new AppError({
    code: PlatformErrorCode.VALIDATION_FAILED,
    httpStatus: 400,
    safeMessage: 'Request validation failed',
    details: { fields: errors },
  });
}

/** Admin 管理面。 */
@UseGuards(AdminOriginGuard, AdminGuard)
@Controller('admin/featured')
export class AdminFeaturedController {
  constructor(@Inject(FeaturedService) private readonly service: FeaturedService) {}

  @Get()
  async list(@Query() query: Record<string, unknown>): Promise<unknown> {
    const parsed = parseFeaturedListQuery(query, invalid);
    const result = await this.service.list({ ...parsed, publicOnly: false });
    return cursorEnvelope(result.rows, result.nextCursor);
  }

  /** 加入精选。**只有 APPROVED 且勾选了 Featured 的内容能进**（`docs/10`）。 */
  @Post()
  @HttpCode(201)
  async create(@Body() body: unknown, @CurrentUser() user: AuthUser): Promise<unknown> {
    const parsed = parseCreateFeaturedBody(body, invalid);
    return envelope(await this.service.create(parsed.contentId, parsed, user.id));
  }

  /** 自定义标题 / 摘要 / 权重 / 上下架。**不能改来源、URL、原发布时间**。 */
  @Patch(':contentId')
  async update(
    @Param('contentId') contentId: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
  ): Promise<unknown> {
    const parsed = parseUpdateFeaturedBody(body, invalid);
    return envelope(await this.service.update(contentId, parsed, user.id));
  }

  /** 下架（软删除）。 */
  @Delete(':contentId')
  async deactivate(
    @Param('contentId') contentId: string,
    @CurrentUser() user: AuthUser,
  ): Promise<unknown> {
    return envelope(await this.service.deactivate(contentId, user.id));
  }
}

/**
 * 公开读取面（`docs/04` 的 `GET /featured`）。
 *
 * **不加守卫** —— 游客也能看（`docs/00` 的「游客能力」含精选）。
 * 但 `publicOnly: true` 会过滤掉未上架的、以及内容已被撤下的。
 */
@Controller('featured')
export class PublicFeaturedController {
  constructor(@Inject(FeaturedService) private readonly service: FeaturedService) {}

  @Get()
  async list(@Query() query: Record<string, unknown>): Promise<unknown> {
    const parsed = parseFeaturedListQuery(query, invalid);
    const result = await this.service.list({ ...parsed, publicOnly: true });
    return cursorEnvelope(result.rows, result.nextCursor);
  }
}
