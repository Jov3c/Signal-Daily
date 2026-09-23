import { describe, expect, it } from 'vitest';
import {
  AppError,
  DomainErrorCode,
  PlatformErrorCode,
  defaultHttpStatusForCode,
  isAppError,
  isValidErrorCode,
  notFoundError,
  toApiErrorBody,
  validationError,
} from '../index';

describe('Error Code 规则（docs/05 / docs/15）', () => {
  it('合法 code 形如 DOMAIN_REASON', () => {
    expect(isValidErrorCode('SOURCE_NOT_FOUND')).toBe(true);
    expect(isValidErrorCode('AUTH_OTP_REPLAY')).toBe(true);
    expect(isValidErrorCode('SOURCE')).toBe(false);
    expect(isValidErrorCode('source_not_found')).toBe(false);
    expect(isValidErrorCode('SOURCE__NOT_FOUND')).toBe(false);
    expect(isValidErrorCode('SOURCE-NOT-FOUND')).toBe(false);
  });

  it('未知错误统一 INTERNAL_ERROR', () => {
    expect(PlatformErrorCode.INTERNAL_ERROR).toBe('INTERNAL_ERROR');
  });

  it('文档中已具名的业务码保留原样', () => {
    expect(DomainErrorCode.SOURCE_NOT_FOUND).toBe('SOURCE_NOT_FOUND');
  });

  it('按 code 推断默认 HTTP status', () => {
    expect(defaultHttpStatusForCode(PlatformErrorCode.VALIDATION_FAILED)).toBe(400);
    expect(defaultHttpStatusForCode(PlatformErrorCode.UNAUTHORIZED)).toBe(401);
    expect(defaultHttpStatusForCode(PlatformErrorCode.FORBIDDEN)).toBe(403);
    expect(defaultHttpStatusForCode(PlatformErrorCode.CONFLICT)).toBe(409);
    expect(defaultHttpStatusForCode(PlatformErrorCode.RATE_LIMITED)).toBe(429);
    expect(defaultHttpStatusForCode(PlatformErrorCode.INTERNAL_ERROR)).toBe(500);
    expect(defaultHttpStatusForCode('SOURCE_NOT_FOUND')).toBe(404);
    expect(defaultHttpStatusForCode('TOTALLY_UNKNOWN')).toBe(500);
  });
});

describe('AppError', () => {
  it('携带 code / httpStatus / safeMessage / details', () => {
    const error = notFoundError(DomainErrorCode.SOURCE_NOT_FOUND, 'Source not found');
    expect(error).toBeInstanceOf(AppError);
    expect(isAppError(error)).toBe(true);
    expect(error.code).toBe('SOURCE_NOT_FOUND');
    expect(error.httpStatus).toBe(404);
    expect(error.safeMessage).toBe('Source not found');
    expect(error.details).toBeNull();
  });

  it('序列化为统一错误响应体', () => {
    const error = notFoundError(DomainErrorCode.SOURCE_NOT_FOUND, 'Source not found');
    expect(error.toApiErrorBody('req_123')).toEqual({
      error: {
        code: 'SOURCE_NOT_FOUND',
        message: 'Source not found',
        requestId: 'req_123',
        details: null,
      },
    });
  });

  it('validationError 使用 VALIDATION_FAILED', () => {
    const error = validationError('slug must be unique', { field: 'slug' });
    expect(error.code).toBe('VALIDATION_FAILED');
    expect(error.httpStatus).toBe(400);
    expect(error.details).toEqual({ field: 'slug' });
  });

  it('内部异常不得外泄：非 AppError 一律降级为 INTERNAL_ERROR', () => {
    const body = toApiErrorBody(new Error('mysql://signal:sup3rsecret@db:3306 boom'), 'req_9');
    expect(body.error.code).toBe('INTERNAL_ERROR');
    expect(body.error.message).toBe('Internal server error');
    expect(JSON.stringify(body)).not.toContain('sup3rsecret');
  });

  it('toApiErrorBody 对 AppError 保留原始安全信息', () => {
    const body = toApiErrorBody(validationError('bad input'), 'req_10');
    expect(body.error.code).toBe('VALIDATION_FAILED');
    expect(body.error.message).toBe('bad input');
  });
});
