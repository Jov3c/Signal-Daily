/**
 * 全局异常过滤器 —— 把任何异常收敛成 `docs/02` 的统一错误封套。
 *
 * ```json
 * {"error":{"code":"SOURCE_NOT_FOUND","message":"Source not found","requestId":"req_xxx","details":null}}
 * ```
 *
 * 归属：Agent 02 落地（`/me` 与 Auth 的错误响应必须符合契约）。
 * 以 `APP_FILTER` 注册，因此对**所有**控制器生效；Agent 14 请勿重复注册。
 *
 * 安全（docs/14）：
 *   - 非 AppError 一律降级为 `INTERNAL_ERROR`，绝不外泄内部异常信息。
 *   - **只记录 method / url / status / code / requestId**，绝不记录请求体 ——
 *     请求体里带着 OTP 明文与 refresh token。
 */

import {
  Catch,
  HttpException,
  Injectable,
  type ArgumentsHost,
  type ExceptionFilter,
  Inject,
} from '@nestjs/common';
import {
  PlatformErrorCode,
  REQUEST_ID_HEADER,
  isAppError,
  type ErrorCodeValue,
} from '@signal/contracts';
import { serializeError, type Logger } from '@signal/logger';
import { APP_LOGGER } from '../logger/app-logger';
import type { HttpRequestLike } from './http-types';
import { resolveRequestId } from './request-id';

/** 过滤器需要的最小响应能力（express 的 `res` 结构上满足）。 */
export type MutableHttpResponse = {
  setHeader(name: string, value: string | string[]): unknown;
  status(code: number): unknown;
  end(body?: string): unknown;
};

type MappedError = {
  httpStatus: number;
  code: ErrorCodeValue;
  message: string;
  details: unknown | null;
};

/** 状态码 → 平台错误码。只覆盖平台级语义，业务码必须由 AppError 显式携带。 */
const STATUS_TO_PLATFORM_CODE: Readonly<Record<number, ErrorCodeValue>> = {
  400: PlatformErrorCode.VALIDATION_FAILED,
  401: PlatformErrorCode.UNAUTHORIZED,
  403: PlatformErrorCode.FORBIDDEN,
  404: PlatformErrorCode.NOT_FOUND,
  409: PlatformErrorCode.CONFLICT,
  413: PlatformErrorCode.VALIDATION_FAILED,
  415: PlatformErrorCode.VALIDATION_FAILED,
  429: PlatformErrorCode.RATE_LIMITED,
};

/**
 * 状态码 → 对外的安全文案（不回显框架原始 message）。
 *
 * ⚠ 413 / 415 目前复用 `VALIDATION_FAILED`：`docs/05` 没有为它们定义平台码，
 * 而 Agent 02 无权往 `PlatformErrorCode` 里加值（那是 Agent 00 的注册表）。
 * 已提交 `handoffs/CONTRACT_CHANGE_REQUEST-agent-02.md` 请求补
 * `PAYLOAD_TOO_LARGE` / `UNSUPPORTED_MEDIA_TYPE`；在那之前
 * **状态码本身是对的**（不再把「请求体过大」报成 500）。
 */
const STATUS_MESSAGE: Readonly<Record<number, string>> = {
  400: 'Request validation failed',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Resource not found',
  409: 'Conflict',
  413: 'Request body too large',
  415: 'Unsupported media type',
  429: 'Too many requests',
};

/**
 * 把任意异常映射为对外错误。
 * 导出以便单元测试直接断言映射规则，无需起 HTTP。
 */
export function mapExceptionToApiError(exception: unknown): MappedError {
  if (isAppError(exception)) {
    return {
      httpStatus: exception.httpStatus,
      code: exception.code,
      message: exception.safeMessage,
      details: exception.details,
    };
  }

  if (exception instanceof HttpException) {
    const httpStatus = exception.getStatus();
    return {
      httpStatus,
      code: STATUS_TO_PLATFORM_CODE[httpStatus] ?? PlatformErrorCode.INTERNAL_ERROR,
      message: STATUS_MESSAGE[httpStatus] ?? 'Internal server error',
      details: httpStatus === 400 ? validationFieldDetails(exception) : null,
    };
  }

  // body-parser / http-errors 抛出的**客户端错误**：它们带数值 status，
  // 但不是 Nest 的 HttpException（例如 PayloadTooLargeError）。
  // 不识别就会被降级成 500 —— 既误导客户端，又会污染 5xx 告警。
  const clientStatus = numericClientStatus(exception);
  if (clientStatus !== null) {
    return {
      httpStatus: clientStatus,
      code: STATUS_TO_PLATFORM_CODE[clientStatus] ?? PlatformErrorCode.VALIDATION_FAILED,
      message: STATUS_MESSAGE[clientStatus] ?? 'Request rejected',
      details: null,
    };
  }

  return {
    httpStatus: 500,
    code: PlatformErrorCode.INTERNAL_ERROR,
    message: 'Internal server error',
    details: null,
  };
}

/**
 * 读取 `err.status` / `err.statusCode`，只接受 4xx。
 * 5xx 一律走 INTERNAL_ERROR，绝不把上游/框架的内部错误直接透出。
 */
function numericClientStatus(exception: unknown): number | null {
  if (typeof exception !== 'object' || exception === null) return null;
  const candidate =
    (exception as { status?: unknown }).status ??
    (exception as { statusCode?: unknown }).statusCode;
  if (typeof candidate !== 'number' || !Number.isInteger(candidate)) return null;
  return candidate >= 400 && candidate <= 499 ? candidate : null;
}

/**
 * 只把「字段级校验文案」放进 details，且只接受字符串数组。
 * 其余形态（对象、含 value 的结构）一律丢弃，避免把输入值回显出去。
 */
function validationFieldDetails(exception: HttpException): unknown | null {
  const response = exception.getResponse();
  if (typeof response !== 'object' || response === null) return null;
  const message = (response as { message?: unknown }).message;
  if (!Array.isArray(message)) return null;

  const fields = message.filter((item): item is string => typeof item === 'string');
  if (fields.length !== message.length || fields.length === 0) return null;
  return { fields };
}

/** 只保留路径，丢掉查询串与 hash。 */
export function pathForLog(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  const cut = url.search(/[?#]/);
  return cut === -1 ? url : url.slice(0, cut);
}

@Catch()
@Injectable()
export class AppErrorFilter implements ExceptionFilter {
  constructor(@Inject(APP_LOGGER) private readonly logger: Logger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const req = http.getRequest<HttpRequestLike>();
    const res = http.getResponse<MutableHttpResponse>();

    const requestId = resolveRequestId(req);
    const mapped = mapExceptionToApiError(exception);

    res.setHeader(REQUEST_ID_HEADER, requestId);
    res.setHeader('content-type', 'application/json; charset=utf-8');

    const logFields = {
      requestId,
      method: req.method,
      // ⚠ 必须是**去掉查询串**的路径：`docs/14` 要求不记录 OAuth code，
      // 而 `/auth/github/callback?code=...&state=...` 的 code 就在 query 里。
      // 记完整 URL 等于把一次性凭据写进日志。
      url: pathForLog(req.url),
      status: mapped.httpStatus,
      errorCode: mapped.code,
    };

    if (mapped.httpStatus >= 500) {
      this.logger.error({ ...logFields, err: serializeError(exception) }, 'request failed');
    } else {
      // 4xx 是正常业务流（验证码错误、限流），用 warn 而不是 error，避免噪声淹没真故障。
      this.logger.warn(logFields, 'request rejected');
    }

    res.status(mapped.httpStatus);
    res.end(
      JSON.stringify({
        error: {
          code: mapped.code,
          message: mapped.message,
          requestId,
          details: mapped.details,
        },
      }),
    );
  }
}
