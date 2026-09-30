/**
 * Agent 10 — 公开读（Public Read）的公开面。
 *
 * 下游（Agent 12 的后台若要看公开视图、Agent 14）只应从本文件 import。
 */

/* 模块与服务 */
export { PublicReadModule } from './module';
export {
  PublicReadService,
  PUBLIC_READ_CLOCK,
  TODAY_FEATURED_LIMIT,
  TODAY_FEATURED_MIN_SCORE,
  TODAY_LATEST_LIMIT,
  type PublicReadClock,
  type TodayView,
} from './service';

/* 持久化端口 */
export {
  PUBLIC_READ_REPOSITORY,
  type EvidenceSummaryRow,
  type ListWindow,
  type PublicContentRow,
  type PublicEvidenceRow,
  type PublicPersonRow,
  type PublicReadRepository,
  type PublicSourceRow,
  type PublicTopicRow,
} from './repository';

/* 缓存（Agent 07 / 14 要接「证据被人工修改」的失效，见 cache.ts 文件头） */
export {
  CACHE_PREFIX,
  CONTENT_CACHE_TTL_SECONDS,
  CONTENT_KEY_PREFIX,
  EVIDENCE_KEY_PREFIX,
  InMemoryPublicCache,
  METADATA_CACHE_TTL_SECONDS,
  PUBLIC_CACHE,
  PUBLIC_REDIS_CLIENT,
  RedisPublicCache,
  X_KEY_PREFIX,
  cacheKeys,
  invalidateContent,
  invalidateEventEvidence,
  invalidateMetadata,
  type PublicCache,
  type RedisLike,
} from './cache';

/* 查询参数校验（Agent 13 复用同一套规则） */
export {
  MAX_EMBEDDED_CONTENT_LIMIT,
  MAX_PUBLIC_LIMIT,
  invalid,
  parseCursor,
  parseEmbeddedLimit,
  parseLimit,
  parseXFeedQuery,
  type XFeedQuery,
} from './dto';

/* id 收敛 */
export { MAX_BINDABLE_ID, toPublicReadId } from './bigint-id';
