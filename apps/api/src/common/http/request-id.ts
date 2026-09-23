/**
 * 请求追踪 ID。
 *
 * `docs/02` 要求每个错误响应都带 `requestId`，`@signal/contracts` 用
 * `REQUEST_ID_HEADER`（`x-request-id`）贯穿 Web → API → Queue → Worker。
 *
 * ⚠ 安全：`x-request-id` 是**外部可控输入**。它会被回显到响应头与日志里，
 * 因此必须先校验形状再采信；不符合形状的一律丢弃并重新生成，
 * 避免把一个任意字符串（含超长值）灌进日志与响应头。
 */

import { randomBytes } from 'node:crypto';
import { REQUEST_ID_HEADER } from '@signal/contracts';
import { readHeader, type HttpRequestLike } from './http-types';

/** 只接受短、且只含安全字符的 ID。 */
export const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

/** 生成一个新的 requestId。 */
export function generateRequestId(): string {
  return `req_${randomBytes(12).toString('hex')}`;
}

/**
 * 采信调用方传来的 `x-request-id`（形状合法时），否则新生成一个。
 * 幂等：同一个请求对象重复调用返回同一个值。
 */
export function resolveRequestId(req: HttpRequestLike): string {
  if (req.requestId !== undefined) return req.requestId;

  const incoming = readHeader(req, REQUEST_ID_HEADER);
  const id =
    incoming !== undefined && REQUEST_ID_PATTERN.test(incoming) ? incoming : generateRequestId();

  req.requestId = id;
  return id;
}
