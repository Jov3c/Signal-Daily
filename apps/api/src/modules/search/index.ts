/**
 * Agent 10 — 搜索（Search）的公开面。
 *
 * ⚠ 搜索**复用** `PublicReadModule` 的仓储（可见性口径必须一致），
 * 所以下游要覆写仓储时请覆写 `PUBLIC_READ_REPOSITORY`（从
 * `modules/public-read` 导出），而不是在这里找。
 */

export { SearchModule } from './module';
export { SearchController } from './controller';
export {
  MAX_QUERY_LENGTH,
  MAX_SEARCH_LIMIT,
  MIN_QUERY_LENGTH,
  parseSearchQuery,
  type SearchQuery,
} from './dto';
