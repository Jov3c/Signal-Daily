/**
 * `apps/api/src/common/http` 的稳定导出面。
 */

export {
  type AuthUser,
  type HeaderCarrier,
  type HttpRequestLike,
  type HttpResponseLike,
  readHeader,
} from './http-types';
export {
  AppErrorFilter,
  mapExceptionToApiError,
  type MutableHttpResponse,
} from './app-error.filter';
export { REQUEST_ID_PATTERN, generateRequestId, resolveRequestId } from './request-id';
export {
  countCookie,
  parseCookieHeader,
  readCookie,
  readCookieFromHeaders,
  serializeClearedCookie,
  serializeCookie,
  type CookieOptions,
} from './cookies';
