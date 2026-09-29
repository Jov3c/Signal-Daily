/**
 * Agent 09 — 阅读进度（Reading Progress）的公开面。
 */

/* 模块与服务 */
export { ReadingProgressModule } from './module';
export { ReadingProgressService, COMPLETION_THRESHOLD } from './service';

/* 持久化端口 */
export {
  READING_PROGRESS_CLOCK,
  READING_PROGRESS_REPOSITORY,
  type ReadingProgressRepository,
  type ReadingProgressRow,
  type UpsertProgressInput,
} from './repository';

/* 资源类型（V1 的自定取值集合，见 CCR） */
export {
  READING_RESOURCE_TYPES,
  isReadingResourceType,
  type ReadingResourceType,
} from './resource-type';

/* 请求校验（Agent 13 复用同一套规则） */
export {
  MAX_LAST_POSITION_LENGTH,
  clampChars,
  invalid,
  parseUpsertProgressBody,
  type UpsertProgressBody,
} from './dto';

/* id 收敛 */
export { MAX_BINDABLE_ID, toResourceId } from './bigint-id';
