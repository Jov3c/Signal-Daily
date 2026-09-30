/**
 * 公开读的查询参数解析。
 *
 * 手写校验（与 Agent 02/03/07/08/09 同一取舍）。
 *
 * ⚠ 公开读的校验比后台**宽松**是刻意的：这些接口没有鉴权，
 * 一个畸形的 `limit` 不该给攻击者一个「让服务器返回 400」的廉价手段 ——
 * 但**也不能静默忽略**（用户会以为自己筛过了）。所以：
 *
 * - `limit` 越界 / 非法 → **夹到边界 / 用默认值**（不报错）；
 * - `cursor` 非法 → **报错**（静默忽略会让用户以为翻到了下一页，
 *   而实际上看到的还是第一页）；
 * - 枚举型筛选（`category`）→ 不校验取值，交给 SQL（查不到就是空列表）。
 */

import { AppError, DEFAULT_CURSOR_LIMIT, PlatformErrorCode } from '@signal/contracts';

/** 一次公开列表最多返回多少条。 */
export const MAX_PUBLIC_LIMIT = 50;

/** `/people/:slug` 这类详情页内嵌的内容条数上限。 */
export const MAX_EMBEDDED_CONTENT_LIMIT = 30;

export function invalid(errors: string[]): AppError {
  return new AppError({
    code: PlatformErrorCode.VALIDATION_FAILED,
    httpStatus: 400,
    safeMessage: 'Request validation failed',
    details: { fields: errors },
  });
}

/** 解析 `limit`：非法或越界一律收敛，**不报错**。 */
export function parseLimit(value: unknown, fallback: number, max: number): number {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, max);
}

/** 解析 `cursor`：非法**报错**（见文件头）。 */
export function parseCursor(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !/^\d{1,20}$/.test(value)) {
    throw invalid(['cursor: must be an opaque cursor returned by this endpoint']);
  }
  return value;
}

export type XFeedQuery = {
  limit: number;
  cursor?: string;
  category?: string;
  personId?: string;
};

/**
 * `GET /x` 的查询参数。
 *
 * ⚠ **没有**任何「当前用户」维度的参数 —— `docs/04`：
 * 「不存在用户 follow/subscription 参数」。`category` 与 `personId`
 * 都是**后台维护的元数据**筛选，不是用户偏好。
 */
export function parseXFeedQuery(query: Record<string, unknown>): XFeedQuery {
  const cursor = parseCursor(query['cursor']);

  return {
    limit: parseLimit(query['limit'], DEFAULT_CURSOR_LIMIT, MAX_PUBLIC_LIMIT),
    ...(cursor === undefined ? {} : { cursor }),
    ...(typeof query['category'] === 'string' && query['category'] !== ''
      ? { category: query['category'] }
      : {}),
    ...(typeof query['personId'] === 'string' && query['personId'] !== ''
      ? { personId: query['personId'] }
      : {}),
  };
}

/** 详情页内嵌内容的条数。 */
export function parseEmbeddedLimit(query: Record<string, unknown>): number {
  return parseLimit(query['limit'], 12, MAX_EMBEDDED_CONTENT_LIMIT);
}
