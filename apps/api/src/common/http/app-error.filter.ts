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
  429: PlatformErrorCode.RATE_LIMITED,
};

/** 状态码 → 对外的安全文案（不回显框架原始 message）。 */
const STATUS_MESSAGE: Readonly<Record<number, string>> = {
  400: 'Request validation failed',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Resource not found',
  409: 'Conflict',
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

  return {
    httpStatus: 500,
    code: PlatformErrorCode.INTERNAL_ERROR,
    message: 'Internal server error',
    details: null,
  };
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
      url: req.url,
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
