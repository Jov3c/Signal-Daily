/**
 * Agent 09 — 阅读偏好（User Preferences）的公开面。
 */

/* 模块与服务 */
export { UserPreferencesModule } from './module';
export { UserPreferenceService } from './service';

/* 持久化端口 */
export {
  USER_PREFERENCE_REPOSITORY,
  type PreferencePatch,
  type PreferenceRow,
  type UserPreferenceRepository,
} from './repository';

/* 请求校验（Agent 13 的「设置」页复用同一套规则与常量） */
export {
  PREFERENCE_KEYS,
  invalid,
  parseUpdatePreferencesBody,
  type UpdatePreferencesBody,
} from './dto';
