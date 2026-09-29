/**
 * 阅读偏好的请求解析与校验。
 *
 * ── ⚠ `PUT` 是**部分更新**，所以「键在不在」比「值是什么」更重要 ──────
 * `undefined` = 不改这一项；显式给了值 = 改成它。
 * 这与 Agent 03/07 的 `PATCH` 语义同一取舍，只是这里用 `PUT`
 *（`docs/04` 写的是 `PUT /me/preferences`）。
 *
 * **未知键一律 400**（不是静默忽略）：客户端把 `articleFontsize` 拼错时，
 * 静默忽略会让它以为「保存成功」—— 而用户下次打开发现设置没生效。
 */

import {
  AppError,
  ARTICLE_FONT_SIZES,
  PlatformErrorCode,
  USER_THEMES,
  type ArticleFontSize,
  type UserTheme,
} from '@signal/contracts';

/** 可编辑的三个键（`docs/11`）。 */
export const PREFERENCE_KEYS = ['theme', 'articleFontSize', 'defaultTranslation'] as const;

export type UpdatePreferencesBody = {
  theme?: UserTheme;
  articleFontSize?: ArticleFontSize;
  defaultTranslation?: boolean;
};

export function invalid(errors: string[]): AppError {
  return new AppError({
    code: PlatformErrorCode.VALIDATION_FAILED,
    httpStatus: 400,
    safeMessage: 'Request validation failed',
    details: { fields: errors },
  });
}

/**
 * 解析 `PUT /me/preferences` 的请求体。
 *
 * ⚠ 空体（`{}`）**报错**，不是「成功但什么都没改」：
 * 一次没有任何效果的写入被回报成 200，会让客户端的状态与服务端悄悄分叉。
 */
export function parseUpdatePreferencesBody(body: unknown): UpdatePreferencesBody {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw invalid(['body: must be a JSON object']);
  }
  const record = body as Record<string, unknown>;
  const errors: string[] = [];

  const unknownKeys = Object.keys(record).filter(
    (key) => !(PREFERENCE_KEYS as readonly string[]).includes(key),
  );
  if (unknownKeys.length > 0) {
    errors.push(
      `body: unknown field(s) ${unknownKeys.join(', ')}; ` +
        `allowed: ${PREFERENCE_KEYS.join(', ')}`,
    );
  }

  const theme = record['theme'];
  if (theme !== undefined && !(USER_THEMES as readonly string[]).includes(theme as string)) {
    errors.push(`theme: must be one of ${USER_THEMES.join(', ')}`);
  }

  const fontSize = record['articleFontSize'];
  if (
    fontSize !== undefined &&
    !(ARTICLE_FONT_SIZES as readonly string[]).includes(fontSize as string)
  ) {
    errors.push(`articleFontSize: must be one of ${ARTICLE_FONT_SIZES.join(', ')}`);
  }

  const defaultTranslation = record['defaultTranslation'];
  if (defaultTranslation !== undefined && typeof defaultTranslation !== 'boolean') {
    errors.push('defaultTranslation: must be a boolean');
  }

  const provided = PREFERENCE_KEYS.filter((key) => record[key] !== undefined);
  if (provided.length === 0 && unknownKeys.length === 0) {
    errors.push(`body: at least one of ${PREFERENCE_KEYS.join(', ')} is required`);
  }

  if (errors.length > 0) throw invalid(errors);

  return {
    ...(theme === undefined ? {} : { theme: theme as UserTheme }),
    ...(fontSize === undefined ? {} : { articleFontSize: fontSize as ArticleFontSize }),
    ...(defaultTranslation === undefined
      ? {}
      : { defaultTranslation: defaultTranslation as boolean }),
  };
}
