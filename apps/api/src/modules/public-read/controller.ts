/**
 * 公开读控制器（`docs/04` 的 Public 段，**不含** `/featured` 与 `/daily/*`）。
 *
 * ```text
 * GET /api/v1/today
 * GET /api/v1/contents/:id
 * GET /api/v1/contents/:id/evidence
 * GET /api/v1/x?cursor=&category=&personId=
 * GET /api/v1/people
 * GET /api/v1/people/:slug
 * GET /api/v1/topics
 * GET /api/v1/topics/:slug
 * GET /api/v1/sources/:slug
 * ```
 *
 * ── ⚠ `GET /featured` 与 `GET /daily/*` **不在这里** ────────────────
 * 它们由 **Agent 08** 实现（`FeaturedModule` / `DailyModule`）。
 * 本模块**不重做**也不转调 —— 两条路由并存会被 Nest 以「先注册的赢」处理，
 * 于是出现「哪一份在生效」的问题。它们各自的控制器已经是那两条路由的所有者。
 *
 * ── 鉴权：**没有** ──────────────────────────────────────────────────
 * 这些是游客可读的（`docs/00` 的「游客能力」）。整个文件里
 * **一个 `@UseGuards` 都不该有** —— 有一条守卫测试盯着这件事。
 *
 * ⚠ 路由声明顺序：`contents/:id/evidence` 必须在 `contents/:id` **之前**吗？
 * **不需要** —— Nest 匹配的是完整路径段数，`/contents/1/evidence` 与
 * `/contents/1` 段数不同，不会互相吃掉。
 *（这与 Agent 08 的 `/daily/archive` vs `/daily/:date` 不同：
 * 那两条**同为两段**，所以才必须靠顺序。）
 * 但 `people` / `topics` 这些「前缀即完整路径」的，与 `people/:slug`
 * 段数不同，同样不冲突。
 */

import { Controller, Get, Inject, Param, Query } from '@nestjs/common';
import { envelope, cursorEnvelope } from '@signal/contracts';
import { PublicReadService } from './service';
import { parseEmbeddedLimit, parseXFeedQuery } from './dto';

@Controller()
export class PublicReadController {
  constructor(@Inject(PublicReadService) private readonly service: PublicReadService) {}

  /** 今日视图。 */
  @Get('today')
  async today(): Promise<unknown> {
    return envelope(await this.service.today());
  }

  /**
   * 内容详情。
   *
   * `docs/04` 的硬要求：**必须**返回原文/翻译、source、originalUrl、
   * topics、author、以及 `evidenceSummary`
   *（`independentSourceCount` / `primarySource` / `hasOfficialConfirmation`）。
   */
  @Get('contents/:id')
  async content(@Param('id') id: string): Promise<unknown> {
    return envelope(await this.service.content(id));
  }

  /** 公开证据链（默认隐藏仅内部调试的 Evidence —— 见仓储层的字段白名单）。 */
  @Get('contents/:id/evidence')
  async contentEvidence(@Param('id') id: string): Promise<unknown> {
    return envelope(await this.service.contentEvidence(id));
  }

  /** X 动态（只由后台白名单决定，不看任何用户偏好）。 */
  @Get('x')
  async x(@Query() query: Record<string, unknown>): Promise<unknown> {
    const parsed = parseXFeedQuery(query);
    const result = await this.service.x(parsed);
    return cursorEnvelope(result.rows, result.nextCursor);
  }

  @Get('people')
  async people(): Promise<unknown> {
    return envelope(await this.service.people());
  }

  @Get('people/:slug')
  async person(
    @Param('slug') slug: string,
    @Query() query: Record<string, unknown>,
  ): Promise<unknown> {
    return envelope(await this.service.person(slug, parseEmbeddedLimit(query)));
  }

  @Get('topics')
  async topics(): Promise<unknown> {
    return envelope(await this.service.topics());
  }

  @Get('topics/:slug')
  async topic(
    @Param('slug') slug: string,
    @Query() query: Record<string, unknown>,
  ): Promise<unknown> {
    return envelope(await this.service.topic(slug, parseEmbeddedLimit(query)));
  }

  @Get('sources/:slug')
  async source(
    @Param('slug') slug: string,
    @Query() query: Record<string, unknown>,
  ): Promise<unknown> {
    return envelope(await this.service.source(slug, parseEmbeddedLimit(query)));
  }
}
