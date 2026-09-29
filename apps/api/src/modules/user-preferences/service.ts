/**
 * `UserPreferenceService` —— 阅读偏好同步。
 *
 * ── `docs/11` ───────────────────────────────────────────────────────
 *
 * > User Preferences 支持：theme（LIGHT/DARK/SYSTEM）、
 * > articleFontSize（SMALL/DEFAULT/LARGE）、defaultTranslation（boolean）
 *
 * > Privacy：不建立广告画像，不保存「兴趣订阅图谱」。
 *
 * ── 关于 Privacy 那一条 ─────────────────────────────────────────────
 * 本模块只有**三个明确字段**，没有 JSON 扩展位、没有自由形式的键值对。
 * 这是刻意的：`docs/03` 说「不使用一个无限扩张的 JSON 代替明确字段；
 * 未来新增偏好通过 migration 增字段」—— schema 已经这么做了，
 * 而这里不再开一个后门（例如 `PUT` 接受任意键）把它破掉。
 */

import { Inject, Injectable } from '@nestjs/common';
import { AppError, PlatformErrorCode } from '@signal/contracts';
import { toBigIntId } from '../../common/prisma/bigint-id';
import { USER_PREFERENCE_REPOSITORY } from './repository';
import type { PreferenceRow, UserPreferenceRepository } from './repository';
import type { UpdatePreferencesBody } from './dto';

@Injectable()
export class UserPreferenceService {
  constructor(
    @Inject(USER_PREFERENCE_REPOSITORY) private readonly repository: UserPreferenceRepository,
  ) {}

  /**
   * 读偏好。
   *
   * ⚠ **不存在时补建**（用数据库默认值），而不是返回 404。
   *
   * 理由：Agent 02 说偏好行在 `findOrCreateByEmail` 建号时自动创建，
   * 所以「读不到」在正常路径上不会发生。但它**可能**发生
   *（OAuth 建号、或将来新增的建号路径漏了这一步、或早期的行被清理过），
   * 而那时候的 404 对前端是不可理解的：**每个用户都应该有偏好**，
   * 没有就用默认值 —— 那本来就是这个字段的语义。
   */
  async get(rawUserId: string): Promise<PreferenceRow> {
    return this.repository.ensure(this.requireUserId(rawUserId));
  }

  /** 部分更新，返回更新后的整行。 */
  async update(rawUserId: string, patch: UpdatePreferencesBody): Promise<PreferenceRow> {
    const userId = this.requireUserId(rawUserId);
    // 先确保行存在 —— `update` 对不存在的行会抛 P2025（→ 500），
    // 而「这个用户还没有偏好行」不该是一个 500。
    await this.repository.ensure(userId);
    return this.repository.update(userId, patch);
  }

  /**
   * 把认证主体的 id 收敛成可绑定的 `bigint`。
   *
   * ⚠ 与 bookmarks / reading-progress 不同，这里**不需要上界检查**：
   * `userId` 来自 `@CurrentUser()`，那是 Agent 02 用一次
   * `sessions` join `users` 从**真实行**读出来的，必然是合法的 BIGINT。
   * 真不可绑定时说明会话数据坏了 —— 那是 401（调用方没做错事），不是 404。
   *
   * 用 `toBigIntId` 而不是 `BigInt()`：后者对畸形字符串抛 `SyntaxError`，
   * 让一个坏会话变成 500。
   */
  private requireUserId(rawUserId: string): bigint {
    const userId = toBigIntId(rawUserId);
    if (userId === null) {
      throw new AppError({
        // ⚠ 用注册表常量而不是字面量：Agent 02 的守卫要求源码里的
        // `code: '...'` 字面量符合 `DOMAIN_REASON` 形状，而 `UNAUTHORIZED`
        // **没有下划线**（平台码不遵守那条命名规则）—— 写成字面量会直接变红。
        code: PlatformErrorCode.UNAUTHORIZED,
        httpStatus: 401,
        safeMessage: 'The authenticated session does not map to a usable user id',
      });
    }
    return userId;
  }
}
