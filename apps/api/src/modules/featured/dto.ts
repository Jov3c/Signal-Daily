/**
 * 精选的请求校验。
 *
 * 手写校验（与 Agent 02/03/07 同一取舍）：能把**所有**错误一次收齐，
 * 且「字段没给」与「字段给了 null」的区别可以显式表达 —— `PATCH` 需要它。
 */

import { DEFAULT_CURSOR_LIMIT, PlatformErrorCode, type AppError } from '@signal/contracts';

/** 列表一次最多返回多少条。 */
export const MAX_FEATURED_LIMIT = 50;

export type FeaturedListQuery = {
  topicSlug?: string;
  contentType?: string;
  limit: number;
  cursor?: string;
};

type Invalid = (errors: string[]) => AppError;

function asRecord(body: unknown, invalid: Invalid): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw invalid(['body: must be a JSON object']);
  }
  return body as Record<string, unknown>;
}

/** 列表查询参数。 */
export function parseFeaturedListQuery(
  query: Record<string, unknown>,
  invalid: Invalid,
): FeaturedListQuery {
  const errors: string[] = [];

  const limitRaw = query['limit'];
  let limit: number = DEFAULT_CURSOR_LIMIT;
  if (limitRaw !== undefined && limitRaw !== '') {
    const parsed = Number(limitRaw);
    if (!Number.isInteger(parsed) || parsed < 1) errors.push('limit: must be a positive integer');
    else limit = Math.min(parsed, MAX_FEATURED_LIMIT);
  }

  const cursor = query['cursor'];
  if (cursor !== undefined && (typeof cursor !== 'string' || !/^\d{1,20}$/.test(cursor))) {
    errors.push('cursor: must be a decimal string');
  }

  if (errors.length > 0) throw invalid(errors);

  return {
    limit,
    ...(typeof query['topic'] === 'string' && query['topic'] !== ''
      ? { topicSlug: query['topic'] }
      : {}),
    ...(typeof query['type'] === 'string' && query['type'] !== ''
      ? { contentType: query['type'] }
      : {}),
    ...(typeof cursor === 'string' ? { cursor } : {}),
  };
}

/** 加入精选的请求体。 */
export function parseCreateFeaturedBody(
  body: unknown,
  invalid: Invalid,
): {
  contentId: string;
  customTitle: string | null;
  customSummary: string | null;
  sortWeight: number;
} {
  const record = asRecord(body, invalid);
  const errors: string[] = [];

  const contentId = record['contentId'];
  if (typeof contentId !== 'string' || !/^\d{1,20}$/.test(contentId)) {
    errors.push('contentId: must be a decimal string');
  }

  const customTitle = record['customTitle'];
  if (customTitle !== undefined && customTitle !== null && typeof customTitle !== 'string') {
    errors.push('customTitle: must be a string or null');
  }

  const customSummary = record['customSummary'];
  if (customSummary !== undefined && customSummary !== null && typeof customSummary !== 'string') {
    errors.push('customSummary: must be a string or null');
  }

  const sortWeight = record['sortWeight'];
  if (sortWeight !== undefined) {
    if (!Number.isInteger(sortWeight)) errors.push('sortWeight: must be an integer');
  }

  if (errors.length > 0) throw invalid(errors);

  return {
    contentId: contentId as string,
    customTitle: typeof customTitle === 'string' ? customTitle : null,
    customSummary: typeof customSummary === 'string' ? customSummary : null,
    sortWeight: typeof sortWeight === 'number' ? sortWeight : 0,
  };
}

/**
 * 修改精选项。
 *
 * ⚠ **不接受** `originalUrl` / `publishedAt` / `sourceId` —— `docs/10` 明令
 * 「禁止改：原始来源、originalUrl、原发布时间」。传了会被当成未知键**拒绝**
 *（而不是静默忽略：静默忽略会让管理员以为自己改成功了）。
 */
export function parseUpdateFeaturedBody(
  body: unknown,
  invalid: Invalid,
): {
  customTitle?: string | null;
  customSummary?: string | null;
  sortWeight?: number;
  active?: boolean;
} {
  const record = asRecord(body, invalid);
  const errors: string[] = [];

  const FORBIDDEN_KEYS = ['originalUrl', 'publishedAt', 'sourceId', 'source', 'contentId'];
  const offenders = FORBIDDEN_KEYS.filter((key) => Object.hasOwn(record, key));
  if (offenders.length > 0) {
    // `docs/10` 的硬约束 —— 说清「为什么」而不是只说「不支持」。
    errors.push(
      `${offenders.join(', ')}: not editable here — docs/10 forbids changing the original ` +
        `source, originalUrl or publish time`,
    );
  }

  const customTitle = record['customTitle'];
  if (customTitle !== undefined && customTitle !== null && typeof customTitle !== 'string') {
    errors.push('customTitle: must be a string or null');
  }

  const customSummary = record['customSummary'];
  if (customSummary !== undefined && customSummary !== null && typeof customSummary !== 'string') {
    errors.push('customSummary: must be a string or null');
  }

  const sortWeight = record['sortWeight'];
  if (sortWeight !== undefined && !Number.isInteger(sortWeight)) {
    errors.push('sortWeight: must be an integer');
  }

  const active = record['active'];
  if (active !== undefined && typeof active !== 'boolean') {
    errors.push('active: must be a boolean');
  }

  const hasEditable =
    Object.hasOwn(record, 'customTitle') ||
    Object.hasOwn(record, 'customSummary') ||
    Object.hasOwn(record, 'sortWeight') ||
    Object.hasOwn(record, 'active');
  if (!hasEditable && offenders.length === 0) {
    errors.push('body: at least one of customTitle / customSummary / sortWeight / active');
  }

  if (errors.length > 0) throw invalid(errors);

  return {
    ...(Object.hasOwn(record, 'customTitle')
      ? { customTitle: typeof customTitle === 'string' ? customTitle : null }
      : {}),
    ...(Object.hasOwn(record, 'customSummary')
      ? { customSummary: typeof customSummary === 'string' ? customSummary : null }
      : {}),
    ...(sortWeight === undefined ? {} : { sortWeight: sortWeight as number }),
    ...(active === undefined ? {} : { active: active as boolean }),
  };
}

export { PlatformErrorCode };
