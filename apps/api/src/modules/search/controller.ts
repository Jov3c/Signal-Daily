/**
 * 搜索控制器（`docs/04` 的 `GET /search?q=`）。
 *
 * ── ⚠ 为什么搜索**不缓存**（`docs/12` 的缓存键清单里没有它）───────
 * `docs/12` 列了 8 个缓存键（today / featured / daily / x / people /
 * topics / content / evidence），**没有 search**。
 * 本模块照办，不自己发明一个键：
 *
 * - 搜索词是**无界的用户输入**，缓存它等于给 Redis 开一个可以被
 *   无限灌入的键空间（每次不同的 `q` 都是一个新键）；
 * - 而搜索的代价（FULLTEXT + ngram）本来就在可接受范围内。
 *
 * ── 可见性 ──────────────────────────────────────────────────────────
 * 「search internal exclusion」（任务书的必测项）：搜索结果
 * **只**包含 `APPROVED` 的内容 —— 过滤发生在仓储的 SQL 里。
 */

import { Controller, Get, Inject, Query } from '@nestjs/common';
import { PUBLIC_READ_REPOSITORY, type PublicReadRepository } from '../public-read/repository';
import { parseSearchQuery } from './dto';

@Controller('search')
export class SearchController {
  constructor(@Inject(PUBLIC_READ_REPOSITORY) private readonly repository: PublicReadRepository) {}

  /**
   * 全文搜索。
   *
   * 响应形状 `{data: PublicContent[], meta: {total, limit, offset}}` ——
   * 用 offset 分页而不是 cursor：FULLTEXT 的相关度排序**没有稳定的游标字段**
   *（相关度是算出来的，不是某一列），硬做游标只能把相关度当游标存下来，
   * 那比 offset 更脆。
   *
   * **已提 CCR**：`docs/04` 只写了 `GET /search?q=`，没给分页与封套形状。
   */
  @Get()
  async search(@Query() query: Record<string, unknown>): Promise<unknown> {
    const parsed = parseSearchQuery(query);
    // ⚠ dto 用的是 HTTP 层的名字（`q`，`docs/04` 的查询参数名），
    // 仓储用的是领域层的名字（`query`）。这里显式转一次 ——
    // 让两边各自用自己的词汇，而不是为了省一行把 `q` 泄漏到仓储端口上。
    const result = await this.repository.search({
      query: parsed.q,
      limit: parsed.limit,
      offset: parsed.offset,
    });

    return {
      data: result.rows,
      meta: { total: result.total, limit: parsed.limit, offset: parsed.offset },
    };
  }
}
