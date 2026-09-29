/**
 * 日报控制器 —— **两个**：Admin 编辑面与 Public 读取面。
 *
 * ⚠ **Admin 路径由本模块定义**：`docs/04` 的 Admin 段只写了
 * 「沿用 v1.0 的 Featured / Daily API」，而 v1.0 **不在本开发包里**
 *（全盘核对过：`01-development-docs` 只有 v1.1）。
 * `contracts/openapi-outline.yaml` 只固定了一条
 * `POST /admin/daily/{date}/publish` —— 本模块与它逐字一致。
 * 其余路径是**本模块的设计决定**，已记入 HANDOFF 并提 CCR
 *（Agent 12 的后台前端按它对接）。
 *
 * ```text
 * GET    /api/v1/admin/daily?year=&month=&status=   期次列表
 * GET    /api/v1/admin/daily/:date                  编辑台详情
 * PUT    /api/v1/admin/daily/:date/sections         整体替换版块与条目
 * POST   /api/v1/admin/daily/:date/schedule         排期
 * POST   /api/v1/admin/daily/:date/publish          立即发布
 * POST   /api/v1/admin/daily/:date/cancel           取消
 *
 * GET    /api/v1/daily/archive?year=&month=         归档（只 PUBLISHED）
 * GET    /api/v1/daily/:date                        已发布的一期
 * ```
 *
 * ── 鉴权 ────────────────────────────────────────────────────────────
 * Admin 面套 `AdminOriginGuard` + `AdminGuard`（`docs/14`），
 * 与 Agent 03 / 07 一致。公开面**不加守卫** —— `docs/00` 的游客能力含「日报」。
 *
 * ⚠ 路由声明顺序：`archive` 必须在 `:date` **之前**。
 * Nest 按声明顺序匹配，反过来的话 `/daily/archive` 会被 `:date` 吃掉，
 * 然后因为 `archive` 不是合法业务日而返回 400 ——
 * 前台看到的是「归档接口坏了」，而不是「路由写反了」。
 */

import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { envelope } from '@signal/contracts';
import { AdminGuard, CurrentUser, type AuthUser } from '../../common/guards';
import { AdminOriginGuard } from '../admin-review/admin-origin.guard';
import { DAILY_CLOCK, type DailyClock } from './clock';
import { DailyService, type EditionSummary } from './service';
import {
  monthRange,
  parseBusinessDate,
  parseOptionalStatus,
  parseScheduleBody,
  parseSectionsBody,
  parseYearMonth,
} from './dto';
import { toArchiveEntry, toPublicEdition } from './public-view';

/** 后台的日报编辑面。 */
@UseGuards(AdminOriginGuard, AdminGuard)
@Controller('admin/daily')
export class AdminDailyController {
  constructor(
    @Inject(DailyService) private readonly service: DailyService,
    @Inject(DAILY_CLOCK) private readonly clock: DailyClock,
  ) {}

  /** 某个月的期次列表。`year` / `month` 缺省为**上海业务时区的当月**。 */
  @Get()
  async list(@Query() query: Record<string, unknown>): Promise<unknown> {
    const range = monthRange(parseYearMonth(query, this.clock.now()));
    const status = parseOptionalStatus(query);
    const rows = await this.service.listMonth({
      ...range,
      ...(status === undefined ? {} : { status }),
    });
    // 后台表格用 `{data, meta}`（`docs/02`：Admin 表格可用 page/pageSize；
    // 一个月的期次最多 31 条，不需要分页，但封套保持与 Agent 03/07 一致）。
    return { data: rows, meta: { ...range, total: rows.length } };
  }

  /** 编辑台详情：版块、条目与内容预览。 */
  @Get(':date')
  async detail(@Param('date') date: string): Promise<unknown> {
    return envelope(await this.service.detail(parseBusinessDate(date)));
  }

  /**
   * 整体替换版块与条目。
   *
   * 用 `PUT`（幂等语义）而不是 `PATCH`：调用方提交的是**完整的**版块结构，
   * 而不是一组增量指令。重复提交同一份内容结果相同。
   */
  @Put(':date/sections')
  async replaceSections(
    @Param('date') date: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
  ): Promise<unknown> {
    const input = parseSectionsBody(body);
    return envelope(await this.service.replaceSections(parseBusinessDate(date), input, user.id));
  }

  /**
   * 排期。
   *
   * ⚠ **不接受自定义时刻**：排期固定使用该业务日的上海 08:00
   *（`docs/10` 的目标发布时刻，契约常量 `DAILY_TARGET_PUBLISH_HOUR`）。
   * 传了 `scheduledAt` 或任何未知字段一律 **400** 并说明原因 ——
   * 第一版接受它却没人读，于是「管理员以为排到了别的时间」。
   * 要立刻发出请走 `POST :date/publish`。
   */
  @Post(':date/schedule')
  @HttpCode(200)
  async schedule(
    @Param('date') date: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
  ): Promise<unknown> {
    parseScheduleBody(body);
    return envelope(await this.service.schedule(parseBusinessDate(date), user.id));
  }

  /** 立即发布。只有 `SCHEDULED` 能发（`docs/10` 的「未审核不发」）。 */
  @Post(':date/publish')
  @HttpCode(200)
  async publish(@Param('date') date: string, @CurrentUser() user: AuthUser): Promise<unknown> {
    return envelope(await this.service.publish(parseBusinessDate(date), user.id));
  }

  /** 取消。`docs/10`：取消草稿不占号。 */
  @Post(':date/cancel')
  @HttpCode(200)
  async cancel(@Param('date') date: string, @CurrentUser() user: AuthUser): Promise<unknown> {
    return envelope(await this.service.cancel(parseBusinessDate(date), user.id));
  }
}

/**
 * 公开读取面（`docs/04` 的 `GET /daily/:date` 与 `GET /daily/archive`）。
 *
 * 游客可读（`docs/00`）。`docs/10`：**未发布的期次对外不存在**，
 * 因此未发布时是 404 而不是「空日报」。
 */
@Controller('daily')
export class PublicDailyController {
  constructor(
    @Inject(DailyService) private readonly service: DailyService,
    @Inject(DAILY_CLOCK) private readonly clock: DailyClock,
  ) {}

  /**
   * 归档。**只返回 PUBLISHED**（`docs/10`：前台日历只展示 PUBLISHED）。
   *
   * ⚠ 必须声明在 `:date` 之前，见文件头。
   */
  @Get('archive')
  async archive(@Query() query: Record<string, unknown>): Promise<unknown> {
    const range = monthRange(parseYearMonth(query, this.clock.now()));
    const rows = await this.service.archive(range);
    return {
      data: rows.map((row: EditionSummary) => toArchiveEntry(row, row.itemCount)),
      meta: { ...range, total: rows.length },
    };
  }

  /** 已发布的一期。 */
  @Get(':date')
  async detail(@Param('date') date: string): Promise<unknown> {
    const detail = await this.service.publishedDetail(parseBusinessDate(date));
    return envelope(toPublicEdition(detail));
  }
}
