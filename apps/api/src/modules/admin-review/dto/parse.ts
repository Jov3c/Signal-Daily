/**
 * 请求解析与校验。
 *
 * 与 Agent 02 / 03 同一取舍：**手写**而不是 class-validator。
 * 三个理由在这里同样成立：
 * 1. `PATCH` 语义要区分「字段没给」与「字段给了 null」；
 * 2. 手写能把**所有**错误一次收齐再返回，而不是遇到第一个就退出；
 * 3. 校验规则本身就是契约（`docs/04` / `docs/09`），写在代码里比写在装饰器里好读。
 */

import {
  AppError,
  EditorialReviewStatus,
  EvidenceType,
  MAX_PAGE_SIZE,
  PlatformErrorCode,
} from '@signal/contracts';
import { REVIEW_LIST_DEFAULTS } from './review.dto';
import {
  BULK_REVIEW_ACTIONS,
  REVIEW_ACTIONS,
  type AddEvidenceInput,
  type BulkReviewInput,
  type ReviewDecisionInput,
  type ReviewListQuery,
  type UpdateEvidenceInput,
} from './review.dto';

/** 校验失败的统一抛出。`details.fields` 只含字段名与原因（不回显值）。 */
function invalid(errors: string[]): AppError {
  return new AppError({
    code: PlatformErrorCode.VALIDATION_FAILED,
    httpStatus: 400,
    safeMessage: 'Request validation failed',
    details: { fields: errors },
  });
}

/** 解析正整数；缺省时用默认值，越界时夹到边界（**不报错** —— 分页参数不值得 400）。 */
function parsePositiveInt(value: unknown, fallback: number, max: number): number {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, max);
}

/** 解析可选数字（非法值 → 报错，因为它是**筛选条件**，静默忽略会让管理员看到错误的结果集）。 */
function parseOptionalNumber(value: unknown, field: string, errors: string[]): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = Number(value);
  if (Number.isNaN(parsed)) {
    errors.push(`${field}: must be a number`);
    return undefined;
  }
  return parsed;
}

/** 审核队列的查询参数。 */
export function parseReviewListQuery(query: Record<string, unknown>): ReviewListQuery {
  const errors: string[] = [];

  const status = parseOptionalStatus(query['status'], errors);
  const minScore = parseOptionalNumber(query['minScore'], 'minScore', errors);
  if (minScore !== undefined && (minScore < 0 || minScore > 100)) {
    errors.push('minScore: must be between 0 and 100');
  }

  if (errors.length > 0) throw invalid(errors);

  return {
    page: parsePositiveInt(query['page'], REVIEW_LIST_DEFAULTS.page, Number.MAX_SAFE_INTEGER),
    pageSize: parsePositiveInt(query['pageSize'], REVIEW_LIST_DEFAULTS.pageSize, MAX_PAGE_SIZE),
    ...(status === undefined ? {} : { status }),
    ...(minScore === undefined ? {} : { minScore }),
    ...(typeof query['sourceId'] === 'string' && query['sourceId'] !== ''
      ? { sourceId: query['sourceId'] }
      : {}),
    ...(typeof query['eventId'] === 'string' && query['eventId'] !== ''
      ? { eventId: query['eventId'] }
      : {}),
  };
}

function parseOptionalStatus(value: unknown, errors: string[]): EditorialReviewStatus | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const allowed = Object.values(EditorialReviewStatus) as string[];
  if (typeof value !== 'string' || !allowed.includes(value)) {
    errors.push(`status: must be one of ${allowed.join(', ')}`);
    return undefined;
  }
  return value as EditorialReviewStatus;
}

/** 单条审核决策的请求体。 */
export function parseDecisionBody(body: unknown): ReviewDecisionInput {
  const errors: string[] = [];
  const record = asRecord(body, errors);

  const action = record['action'];
  if (typeof action !== 'string' || !(REVIEW_ACTIONS as readonly string[]).includes(action)) {
    errors.push(`action: must be one of ${REVIEW_ACTIONS.join(', ')}`);
  }

  const note = record['note'];
  if (note !== undefined && note !== null && typeof note !== 'string') {
    errors.push('note: must be a string or null');
  }

  if (errors.length > 0) throw invalid(errors);

  return {
    action: action as ReviewDecisionInput['action'],
    note: typeof note === 'string' ? note : null,
  };
}

/** 批量审核的请求体（`docs/09`：**只允许 DEFERRED / REJECTED**）。 */
export function parseBulkBody(body: unknown): BulkReviewInput {
  const errors: string[] = [];
  const record = asRecord(body, errors);

  const action = record['action'];
  if (typeof action !== 'string' || !(BULK_REVIEW_ACTIONS as readonly string[]).includes(action)) {
    // ⚠ 错误信息要说清「为什么」—— 批量不支持 Approve 是**产品决定**，
    // 不是参数写错了。管理员看到这句才知道该逐条操作。
    errors.push(
      `action: bulk review only allows ${BULK_REVIEW_ACTIONS.join(' / ')} ` +
        `(approvals must be decided one by one)`,
    );
  }

  const contentIds = record['contentIds'];
  if (!Array.isArray(contentIds) || contentIds.length === 0) {
    errors.push('contentIds: must be a non-empty array');
  } else if (contentIds.length > MAX_BULK_SIZE) {
    errors.push(`contentIds: at most ${MAX_BULK_SIZE} per request`);
  } else if (!contentIds.every((id): id is string => typeof id === 'string' && id !== '')) {
    errors.push('contentIds: every entry must be a non-empty string');
  }

  const note = record['note'];
  if (note !== undefined && note !== null && typeof note !== 'string') {
    errors.push('note: must be a string or null');
  }

  if (errors.length > 0) throw invalid(errors);

  return {
    contentIds: contentIds as string[],
    action: action as BulkReviewInput['action'],
    note: typeof note === 'string' ? note : null,
  };
}

/** 单次批量的上限 —— 再多就该分批，而不是让一个请求跑几分钟。 */
export const MAX_BULK_SIZE = 100;

/** 人工新增证据的请求体。 */
export function parseAddEvidenceBody(body: unknown): AddEvidenceInput {
  const errors: string[] = [];
  const record = asRecord(body, errors);

  const url = record['url'];
  // ⚠ URL 的**安全性**校验在 `evidence.service.ts` 里（scheme 白名单），
  // 这里只判「有没有给」—— 职责分开，错误信息也更准。
  if (typeof url !== 'string' || url.trim() === '') {
    errors.push('url: must be a non-empty string');
  }

  const evidenceType = record['evidenceType'];
  const allowedTypes = Object.values(EvidenceType) as string[];
  if (typeof evidenceType !== 'string' || !allowedTypes.includes(evidenceType)) {
    errors.push(`evidenceType: must be one of ${allowedTypes.join(', ')}`);
  }

  const title = record['title'];
  if (title !== undefined && title !== null && typeof title !== 'string') {
    errors.push('title: must be a string or null');
  }

  const publishedAt = record['publishedAt'];
  if (publishedAt !== undefined && publishedAt !== null && typeof publishedAt !== 'string') {
    errors.push('publishedAt: must be an ISO date-time string or null');
  }

  const contentId = record['contentId'];
  if (contentId !== undefined && contentId !== null && typeof contentId !== 'string') {
    errors.push('contentId: must be a string or null');
  }

  if (errors.length > 0) throw invalid(errors);

  return {
    url: url as string,
    evidenceType: evidenceType as EvidenceType,
    title: typeof title === 'string' ? title : null,
    publishedAt: typeof publishedAt === 'string' ? publishedAt : null,
    contentId: typeof contentId === 'string' ? contentId : null,
  };
}

/** 修改证据的请求体（`PATCH` 语义：区分「没给」与「给了 null」）。 */
export function parseUpdateEvidenceBody(body: unknown): UpdateEvidenceInput {
  const errors: string[] = [];
  const record = asRecord(body, errors);

  const evidenceType = record['evidenceType'];
  if (evidenceType !== undefined) {
    const allowedTypes = Object.values(EvidenceType) as string[];
    if (typeof evidenceType !== 'string' || !allowedTypes.includes(evidenceType)) {
      errors.push(`evidenceType: must be one of ${allowedTypes.join(', ')}`);
    }
  }

  const title = record['title'];
  if (title !== undefined && title !== null && typeof title !== 'string') {
    errors.push('title: must be a string or null');
  }

  const url = record['url'];
  if (url !== undefined && (typeof url !== 'string' || url.trim() === '')) {
    errors.push('url: must be a non-empty string');
  }

  if (Object.keys(record).length === 0) {
    errors.push('body: at least one of evidenceType / title / url must be provided');
  }

  if (errors.length > 0) throw invalid(errors);

  return {
    // `Object.hasOwn` 而不是 `!== undefined`：要让「显式传 null」能把标题清空。
    ...(Object.hasOwn(record, 'evidenceType') ? { evidenceType: evidenceType as EvidenceType } : {}),
    ...(Object.hasOwn(record, 'title') ? { title: typeof title === 'string' ? title : null } : {}),
    ...(Object.hasOwn(record, 'url') ? { url: url as string } : {}),
  };
}

/** 请求体必须是对象。 */
function asRecord(body: unknown, errors: string[]): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    errors.push('body: must be a JSON object');
    if (errors.length > 0) throw invalid(errors);
  }
  return body as Record<string, unknown>;
}
