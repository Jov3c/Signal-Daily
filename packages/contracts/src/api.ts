/**
 * Signal HTTP API 契约 — 响应封套、分页、ID 与路径常量。
 *
 * 对应 `docs/02-repository-contract.md` 与 `docs/04-api-contract.md` v1.1。
 * Frozen Contract：所有 Agent 必须复用此处形状，不得自建另一套响应格式。
 */

/** API 根路径。禁止新建第二套命名体系。 */
export const API_PREFIX = '/api/v1' as const;

/** 管理后台 API 根路径。 */
export const ADMIN_API_PREFIX = '/api/v1/admin' as const;

/** 贯穿 Web → API → Queue → Worker 的请求追踪头。 */
export const REQUEST_ID_HEADER = 'x-request-id' as const;

/**
 * 数据库主键为 BIGINT UNSIGNED，API 一律序列化为 string，
 * 避免 JS Number 精度丢失。任何返回 id 的 DTO 都必须使用此类型。
 */
export type BigIntId = string;

/** ISO 8601 UTC 时间字符串。 */
export type IsoDateTimeString = string;

/** 上海业务日，格式 `YYYY-MM-DD`。 */
export type BusinessDate = string;

/** 请求追踪 ID，形如 `req_xxx`。 */
export type RequestId = string;

/* ------------------------------------------------------------------ */
/* Envelopes                                                           */
/* ------------------------------------------------------------------ */

/** 成功返回单个对象。 */
export type ApiEnvelope<T> = { data: T };

/** Cursor 分页列表。Public Feed 使用。 */
export type CursorEnvelope<T> = { data: T[]; meta: { nextCursor: string | null } };

/** Admin 表格可用的 page/pageSize 分页元数据。 */
export type OffsetPaginationMeta = {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
};

/** Admin 表格用的分页列表。 */
export type OffsetEnvelope<T> = { data: T[]; meta: OffsetPaginationMeta };

/** 统一错误响应体。 */
export type ApiErrorBody = {
  error: {
    code: string;
    message: string;
    requestId: string;
    details: unknown | null;
  };
};

/** 任一合法 API 响应。 */
export type ApiResponse<T> = ApiEnvelope<T> | CursorEnvelope<T> | OffsetEnvelope<T> | ApiErrorBody;

/** `reference/contracts.ts` 中的名字，保持向后兼容。 */
export type ApiError = ApiErrorBody;

/* ------------------------------------------------------------------ */
/* Request helpers                                                     */
/* ------------------------------------------------------------------ */

/** Cursor 分页公共入参。 */
export type CursorPaginationQuery = {
  cursor?: string | null;
  /** 建议上限由各模块自行约束，默认 20。 */
  limit?: number | null;
};

/** Admin 表格分页公共入参。 */
export type OffsetPaginationQuery = {
  page?: number | null;
  pageSize?: number | null;
};

/** 约定默认分页大小，供各模块复用，避免各处自定常量。 */
export const DEFAULT_CURSOR_LIMIT = 20 as const;
export const DEFAULT_PAGE_SIZE = 20 as const;
export const MAX_PAGE_SIZE = 100 as const;

/**
 * 构建 cursor 分页返回体。
 * 只做形状封装，不涉及任何业务判断。
 */
export function cursorEnvelope<T>(data: T[], nextCursor: string | null): CursorEnvelope<T> {
  return { data, meta: { nextCursor } };
}

/** 构建单对象返回体。 */
export function envelope<T>(data: T): ApiEnvelope<T> {
  return { data };
}
