/**
 * Admin Source Registry 控制器。
 *
 * 路由**精确等于** `docs/04-api-contract.md` 的 8 条（有测试枚举 express
 * 路由表做守卫，多一条即红）：
 *
 * ```
 * GET    /api/v1/admin/sources
 * POST   /api/v1/admin/sources
 * GET    /api/v1/admin/sources/:id
 * PATCH  /api/v1/admin/sources/:id
 * POST   /api/v1/admin/sources/:id/enable
 * POST   /api/v1/admin/sources/:id/disable
 * POST   /api/v1/admin/sources/:id/test
 * POST   /api/v1/admin/sources/:id/fetch-now
 * ```
 *
 * ── 鉴权 ─────────────────────────────────────────────────────────
 * 整个控制器套 `AdminOriginGuard` + `AdminGuard`（`docs/14`：
 * 「Admin endpoint 强制 auth + role」+「敏感 Admin mutation 进行 Origin check」）。
 * 未认证 → 401；已认证但非 ADMIN → 403；变更类请求带了不匹配的 `Origin` → 403。
 * 授权按**库里的当前角色**判定，因此撤权立刻生效（Agent 02 的实现）。
 *
 * `docs/09` 要求的「X 账号 Filter/Tab」不需要新端点：
 * `GET /admin/sources?type=X_USER` 就是它。
 */

import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AppError, PlatformErrorCode, envelope } from '@signal/contracts';
import { AdminGuard } from '../../common/guards';
import { AdminOriginGuard } from './admin-origin.guard';
import {
  parseCreateSourceBody,
  parseSourceListQuery,
  parseUpdateSourceBody,
  type SourceDto,
} from './dto/source.dto';
import { SourcesService } from './service';

/** 入参校验失败的统一抛出。`details.fields` 只含字段名与原因。 */
function invalid(errors: string[]): AppError {
  return new AppError({
    code: PlatformErrorCode.VALIDATION_FAILED,
    httpStatus: 400,
    safeMessage: 'Request validation failed',
    details: { fields: errors },
  });
}

/**
 * 守卫顺序是刻意的：**先 Origin 校验，再认证**。
 *
 * `AdminOriginGuard` 是纯内存判断（不查库），放在前面可以让跨源请求
 * 在付出一次数据库往返之前就被拒掉。代价是「匿名 + Origin 不匹配」会返回
 * 403 而不是 401 —— 那不泄露任何信息（只说明来源不对），可以接受。
 */
@UseGuards(AdminOriginGuard, AdminGuard)
@Controller('admin/sources')
export class SourcesController {
  // ⚠ 显式 @Inject：不要依赖 emitDecoratorMetadata（见 di-wiring.spec.ts）。
  constructor(@Inject(SourcesService) private readonly sources: SourcesService) {}

  @Get()
  async list(@Query() query: unknown): Promise<{
    data: SourceDto[];
    meta: { page: number; pageSize: number; total: number; totalPages: number };
  }> {
    const parsed = parseSourceListQuery(query);
    if (!parsed.ok) throw invalid(parsed.errors);

    const result = await this.sources.list(parsed.value);
    return {
      data: result.items,
      meta: {
        page: parsed.value.page,
        pageSize: parsed.value.pageSize,
        total: result.total,
        totalPages: Math.ceil(result.total / parsed.value.pageSize),
      },
    };
  }

  @Post()
  @HttpCode(201)
  async create(@Body() body: unknown): Promise<{ data: SourceDto }> {
    const parsed = parseCreateSourceBody(body);
    if (!parsed.ok) throw invalid(parsed.errors);
    return envelope(await this.sources.create(parsed.value));
  }

  @Get(':id')
  async detail(@Param('id') id: string): Promise<{ data: SourceDto }> {
    return envelope(await this.sources.get(id));
  }

  @Patch(':id')
  async patch(@Param('id') id: string, @Body() body: unknown): Promise<{ data: SourceDto }> {
    const parsed = parseUpdateSourceBody(body);
    if (!parsed.ok) throw invalid(parsed.errors);
    return envelope(await this.sources.update(id, parsed.value));
  }

  @Post(':id/enable')
  @HttpCode(200)
  async enable(@Param('id') id: string): Promise<{ data: SourceDto }> {
    return envelope(await this.sources.enable(id));
  }

  @Post(':id/disable')
  @HttpCode(200)
  async disable(@Param('id') id: string): Promise<{ data: SourceDto }> {
    return envelope(await this.sources.disable(id));
  }

  /**
   * 探测一次。**成功与失败都返回 200** —— 详见 `source-tester.ts` 的说明。
   * 只有「这个来源根本不存在」才是 404。
   */
  @Post(':id/test')
  @HttpCode(200)
  async test(@Param('id') id: string) {
    return envelope(await this.sources.test(id));
  }

  /** 立刻入队一次采集。Redis 不可用时 503 `SOURCE_ENQUEUE_FAILED`。 */
  @Post(':id/fetch-now')
  @HttpCode(202)
  async fetchNow(@Param('id') id: string) {
    return envelope(await this.sources.fetchNow(id));
  }
}
