/**
 * `UserPreferenceRepository` 端口 —— 阅读偏好的持久化契约。
 *
 * ⚠ 只读写 `user_preferences`。**不碰 `users`**（那是 Agent 02 的）。
 */

import type { ArticleFontSize, UserTheme } from '@signal/contracts';

/** 注入 token。 */
export const USER_PREFERENCE_REPOSITORY = 'USER_PREFERENCE_REPOSITORY';

/** 一个用户的一行偏好。 */
export type PreferenceRow = {
  theme: UserTheme;
  articleFontSize: ArticleFontSize;
  defaultTranslation: boolean;
  /** ISO 时刻 —— 客户端做「上次同步于」提示要用（`docs/11` 的「同步」）。 */
  updatedAt: string;
};

/** 部分更新：`undefined` = 不改这一项。 */
export type PreferencePatch = {
  theme?: UserTheme;
  articleFontSize?: ArticleFontSize;
  defaultTranslation?: boolean;
};

export interface UserPreferenceRepository {
  /** 读；不存在返回 `null`（由服务层决定要不要补建）。 */
  find(userId: bigint): Promise<PreferenceRow | null>;

  /**
   * 读，不存在则用**数据库默认值**建一行再返回。
   *
   * 幂等：并发下撞上主键冲突就把它读回来（**不是**先查后写）。
   */
  ensure(userId: bigint): Promise<PreferenceRow>;

  /** 部分更新；返回更新后的整行。 */
  update(userId: bigint, patch: PreferencePatch): Promise<PreferenceRow>;
}
