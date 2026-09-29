/**
 * 阅读进度的请求解析与校验。
 *
 * ⚠ `docs/04` 只写了 `PUT /reading-progress`，**没有给请求体形状** ——
 * 下面的形状是本模块定义并提了 CCR 的。
 */

import { AppError, PlatformErrorCode } from '@signal/contracts';
import {
  READING_RESOURCE_TYPES,
  isReadingResourceType,
  type ReadingResourceType,
} from './resource-type';

/** `last_position` 是 `VarChar(255)` —— 按**字符**截断（MySQL 数的是字符）。 */
export const MAX_LAST_POSITION_LENGTH = 255;

export type UpsertProgressBody = {
  resourceType: ReadingResourceType;
  resourceId: string;
  progress: number;
  lastPosition: string | null;
};

export function invalid(errors: string[]): AppError {
  return new AppError({
    code: PlatformErrorCode.VALIDATION_FAILED,
    httpStatus: 400,
    safeMessage: 'Request validation failed',
    details: { fields: errors },
  });
}

/** 按**字符**截断（`Array.from` 而不是 `slice`：后者会劈开代理对）。 */
export function clampChars(value: string | null, max: number): string | null {
  if (value === null) return null;
  const codePoints = Array.from(value);
  return codePoints.length <= max ? value : codePoints.slice(0, max).join('');
}

/**
 * 解析 `PUT /reading-progress` 的请求体。
 *
 * ── `progress` 的边界是**闭区间 `[0, 1]`** ──────────────────────────
 * `docs/11`：Reading Progress 0–1。
 * ⚠ 列类型是 `Decimal(5,4)`，它能存到 `9.9999` —— **数据库不会替我们挡住
 * 越界值**。所以 `1.5` 必须在**这一层**被拒，否则库里会出现
 * 「进度 150%」这种下游没法解释的数据。
 *
 * 同样刻意**不接受** `NaN` / `Infinity`：`Number('abc')` 是 `NaN`，
 * 而 `NaN >= 0` 是 `false` —— 用 `Number.isFinite` 而不是比较运算，
 * 否则 `NaN` 会从「不小于 0」这个分支溜进去。
 */
export function parseUpsertProgressBody(body: unknown): UpsertProgressBody {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw invalid(['body: must be a JSON object']);
  }
  const record = body as Record<string, unknown>;
  const errors: string[] = [];

  const resourceTypeRaw = record['resourceType'];
  if (!isReadingResourceType(resourceTypeRaw)) {
    // ⚠ **字符串但不在取值集合里** → 用专门的码，而不是 `VALIDATION_FAILED`。
    //
    // 两种失败是不同的东西：
    //   · `resourceType: 123`（类型错）        → `VALIDATION_FAILED`
    //   · `resourceType: 'EPISODE'`（形状对，但 V1 不支持）→ `READING_RESOURCE_TYPE_UNSUPPORTED`
    // 调用方需要区分「我传错了」与「这个功能还没有」——
    // 后者的正确反应是提示用户，而不是报「请求非法」。
    //
    // ⚠ 这一段是 §23 审查的 **F1** 修复：那个码被登记进冻结契约、
    // 我的 CCR 也声称会返回它，但实现里**从未抛出** ——
    // 一个「注册了却零使用」的码是一份会误导下游的契约表面
    //（与 Agent 08 自查到的 `DAILY_ALREADY_PUBLISHED` 同一个形状）。
    if (typeof resourceTypeRaw === 'string' && resourceTypeRaw !== '') {
      throw new AppError({
        code: 'READING_RESOURCE_TYPE_UNSUPPORTED',
        httpStatus: 400,
        safeMessage: `resourceType '${resourceTypeRaw}' is not supported in V1`,
        details: { supported: [...READING_RESOURCE_TYPES] },
      });
    }
    errors.push(
      `resourceType: must be one of ${READING_RESOURCE_TYPES.join(', ')} ` +
        '(V1 only tracks progress for content)',
    );
  }

  const resourceIdRaw = record['resourceId'];
  if (typeof resourceIdRaw !== 'string' || !/^\d{1,20}$/.test(resourceIdRaw)) {
    errors.push('resourceId: must be a decimal string');
  }

  const progressRaw = record['progress'];
  if (typeof progressRaw !== 'number' || !Number.isFinite(progressRaw)) {
    errors.push('progress: must be a finite number');
  } else if (progressRaw < 0 || progressRaw > 1) {
    errors.push('progress: must be between 0 and 1 (docs/11)');
  }

  const lastPositionRaw = record['lastPosition'];
  if (
    lastPositionRaw !== undefined &&
    lastPositionRaw !== null &&
    typeof lastPositionRaw !== 'string'
  ) {
    errors.push('lastPosition: must be a string or null');
  }

  if (errors.length > 0) throw invalid(errors);

  return {
    resourceType: resourceTypeRaw as ReadingResourceType,
    resourceId: resourceIdRaw as string,
    progress: progressRaw as number,
    lastPosition: clampChars(
      typeof lastPositionRaw === 'string' ? lastPositionRaw : null,
      MAX_LAST_POSITION_LENGTH,
    ),
  };
}
