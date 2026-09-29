/**
 * Agent 08 — 精选（Featured）的公开面。
 *
 * 下游（Agent 10 的公开 API 聚合、Agent 12 的后台、Agent 14）只应从本文件
 * import，不要深入子目录 —— 子目录里的文件是实现细节。
 */

/* 模块与服务 */
export { FeaturedModule } from './module';
export { FeaturedService, FEATURED_LOGGER, type FeaturedClock } from './service';

/* 持久化端口（下游要 override 时用） */
export {
  FEATURED_CLOCK,
  FEATURED_REPOSITORY,
  type CreateFeaturedInput,
  type FeaturedEdits,
  type FeaturedRepository,
  type FeaturedRow,
  type UpdateFeaturedInput,
} from './repository';

/* 请求校验（Agent 12 组装表单时复用同一套规则） */
export {
  MAX_FEATURED_LIMIT,
  parseCreateFeaturedBody,
  parseFeaturedListQuery,
  parseUpdateFeaturedBody,
  type FeaturedListQuery,
} from './dto';

/* 字段上限 */
export { MAX_CUSTOM_SUMMARY_LENGTH, MAX_CUSTOM_TITLE_LENGTH, clampChars } from './limits';
