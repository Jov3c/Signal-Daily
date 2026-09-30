/**
 * `SearchModule` —— 全文搜索（`docs/12` 的 MySQL FULLTEXT）。
 *
 * ⚠ **复用 `PublicReadModule` 的仓储，而不是自己再写一条查询**。
 *
 * 理由不只是「少写代码」：搜索结果的可见性过滤（`APPROVED`）
 * 与公开读**必须**是同一套。两处各写一条 SQL 的话，
 * 「搜索里能搜到、内容页打不开」这种不一致迟早会出现，
 * 而它不会让任何测试变红。
 *
 * `SearchModule` **不注册控制器以外的任何东西** —— 缓存、仓储、时钟
 * 全部来自 `PublicReadModule` 的导出。
 */

import { Module } from '@nestjs/common';
import { PublicReadModule } from '../public-read/module';
import { SearchController } from './controller';

@Module({
  imports: [PublicReadModule],
  controllers: [SearchController],
})
export class SearchModule {}
