/**
 * Signal 统一错误契约 — Error Code 规则 + AppError。
 *
 * 对应 `docs/15-observability-error.md` 与 `docs/05` 的「统一 DOMAIN_REASON，禁止同义错误码」。
 *
 * ── 命名规则（Frozen） ───────────────────────────────────────────────
 *   1. 形如 `DOMAIN_REASON`，全大写 SNAKE_CASE。
 *   2. DOMAIN 用模块实体名（SOURCE / CONTENT / EVENT / DAILY / AUTH / ...）。
 *   3. REASON 用具体原因（NOT_FOUND / DUPLICATE_SLUG / URL_NOT_ALLOWED / ...）。
 *   4. 一个语义只能有一个 code。严禁 `SOURCE_MISSING` / `SOURCE_NOT_EXIST`
 *      这类与 `SOURCE_NOT_FOUND` 同义的码。
 *   5. 未知错误一律 `INTERNAL_ERROR`，不得外泄内部异常信息。
 *
 * ── 所有权 ─────────────────────────────────────────────────────────
 *   - 平台级 code 由 Agent 00 维护（见 PlatformErrorCode）。
 *   - 模块级 code 由模块 Owner 按上述规则追加到本文件；
 *     追加前请确认没有同义 code 已存在。
 *   - Agent 00 只预置了文档中已明确出现的业务码（`SOURCE_NOT_FOUND`），
 *     其余业务码留给对应模块 Owner，以免语义冲突。
 */

import type { ApiErrorBody, RequestId } from './api';

/** 合法的 Error Code 形状：`DOMAIN_REASON`。 */
export const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9]*(_[A-Z0-9]+)+$/;

/** 判断字符串是否符合 Error Code 命名规则。 */
export function isValidErrorCode(code: string): boolean {
  return ERROR_CODE_PATTERN.test(code);
}

/* ------------------------------------------------------------------ */
/* Platform error codes                                                */
/* ------------------------------------------------------------------ */

/**
 * 平台级错误码（跨模块通用）。Agent 00 Owner。
 */
export const PlatformErrorCode = {
  /** 入参校验失败。 */
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  /** 未认证。 */
  UNAUTHORIZED: 'UNAUTHORIZED',
  /** 已认证但无权限（例如非 ADMIN 访问 /admin/*）。 */
  FORBIDDEN: 'FORBIDDEN',
  /** 通用 404。优先使用更具体的 `DOMAIN_NOT_FOUND`。 */
  NOT_FOUND: 'NOT_FOUND',
  /** 资源状态冲突。 */
  CONFLICT: 'CONFLICT',
  /** 触发限流。 */
  RATE_LIMITED: 'RATE_LIMITED',
  /** 未知错误统一出口，不返回内部细节。 */
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type PlatformErrorCodeValue = (typeof PlatformErrorCode)[keyof typeof PlatformErrorCode];

/**
 * 文档中已明确出现的业务错误码。
 * 其余业务码由各模块 Owner 按命名规则追加。
 */
export const DomainErrorCode = {
  /** docs/02 示例；Agent 03 Source Registry 使用。 */
  SOURCE_NOT_FOUND: 'SOURCE_NOT_FOUND',

  /* ---- Agent 02 — Auth / Users（docs/11 / docs/14 / tasks/agent-02-auth.md） ---- */

  /** 验证码不正确。 */
  AUTH_OTP_INVALID: 'AUTH_OTP_INVALID',
  /** 验证码已过期（超过 10 分钟）。 */
  AUTH_OTP_EXPIRED: 'AUTH_OTP_EXPIRED',
  /** 验证码已被使用过 —— 重放。 */
  AUTH_OTP_ALREADY_USED: 'AUTH_OTP_ALREADY_USED',
  /** refresh token 未知 / 已过期。 */
  AUTH_SESSION_INVALID: 'AUTH_SESSION_INVALID',
  /**
   * refresh token 对应的 Session 已被撤销。
   * 出现在「提交一个已轮换掉的 refresh token」时 —— 视为凭据泄露，
   * 实现会连带撤销该用户的全部 Session。
   */
  AUTH_SESSION_REVOKED: 'AUTH_SESSION_REVOKED',
  /** OAuth state 缺失 / 签名不合法 / 已过期 / 与 Cookie 不匹配。 */
  AUTH_OAUTH_STATE_INVALID: 'AUTH_OAUTH_STATE_INVALID',
  /** 与 GitHub 换取 token / 拉取用户资料失败。 */
  AUTH_OAUTH_EXCHANGE_FAILED: 'AUTH_OAUTH_EXCHANGE_FAILED',
  /** 未配置 GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET。 */
  AUTH_GITHUB_NOT_CONFIGURED: 'AUTH_GITHUB_NOT_CONFIGURED',
  /**
   * 生产环境没有可用的邮件通道（SMTP_* 未配置），无法投递 OTP。
   * 刻意不静默降级：宁可登录不可用，也不能把验证码打进日志。
   */
  AUTH_MAIL_NOT_CONFIGURED: 'AUTH_MAIL_NOT_CONFIGURED',
  /** 用户已被管理员禁用。 */
  AUTH_ACCOUNT_DISABLED: 'AUTH_ACCOUNT_DISABLED',

  /** 用户不存在。 */
  USER_NOT_FOUND: 'USER_NOT_FOUND',
} as const;

export type DomainErrorCodeValue = (typeof DomainErrorCode)[keyof typeof DomainErrorCode];

/** 任意合法错误码：平台码、已登记业务码，或模块按规则自定的 DOMAIN_REASON 字符串。 */
export type ErrorCodeValue = PlatformErrorCodeValue | DomainErrorCodeValue | (string & {});

/* ------------------------------------------------------------------ */
/* HTTP status mapping                                                 */
/* ------------------------------------------------------------------ */

/** 平台码 → HTTP status 的默认映射。业务码由模块自行决定 status。 */
export const PLATFORM_ERROR_HTTP_STATUS: Readonly<Record<PlatformErrorCodeValue, number>> = {
  VALIDATION_FAILED: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
};

/** 所有以 `_NOT_FOUND` 结尾的业务码默认 404。 */
export const DEFAULT_NOT_FOUND_HTTP_STATUS = 404;

/** 根据错误码推断默认 HTTP status。 */
export function defaultHttpStatusForCode(code: string): number {
  // 必须用 Object.hasOwn 而不是 `in`：`in` 会命中原型链，
  // 例如 `'constructor' in {...}` 为 true，会让 httpStatus 变成函数。
  if (Object.hasOwn(PLATFORM_ERROR_HTTP_STATUS, code)) {
    return PLATFORM_ERROR_HTTP_STATUS[code as PlatformErrorCodeValue];
  }
  if (code.endsWith('_NOT_FOUND')) return DEFAULT_NOT_FOUND_HTTP_STATUS;
  if (code.endsWith('_CONFLICT') || code.endsWith('_DUPLICATE_SLUG')) return 409;
  if (code.endsWith('_FORBIDDEN')) return 403;
  return 500;
}

/* ------------------------------------------------------------------ */
/* AppError                                                            */
/* ------------------------------------------------------------------ */

/**
 * 统一应用错误。`docs/15`：`code, httpStatus, safeMessage, details?`
 *
 * `safeMessage` 是**可以**返回给客户端的信息。
 * 任何内部异常原文必须放进 `cause`，不得进入 `safeMessage`。
 */
export class AppError extends Error {
  readonly code: ErrorCodeValue;
  readonly httpStatus: number;
  readonly safeMessage: string;
  readonly details: unknown | null;

  constructor(params: {
    code: ErrorCodeValue;
    safeMessage: string;
    httpStatus?: number;
    details?: unknown;
    cause?: unknown;
  }) {
    super(params.safeMessage, params.cause === undefined ? undefined : { cause: params.cause });
    this.name = 'AppError';
    this.code = params.code;
    this.safeMessage = params.safeMessage;
    this.httpStatus = params.httpStatus ?? defaultHttpStatusForCode(params.code);
    this.details = params.details ?? null;
    Error.captureStackTrace?.(this, AppError);
  }

  /** 序列化为统一错误响应体。 */
  toApiErrorBody(requestId: RequestId): ApiErrorBody {
    return {
      error: {
        code: this.code,
        message: this.safeMessage,
        requestId,
        details: this.details,
      },
    };
  }
}

/** 类型守卫。 */
export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}

/** 便捷构造：已知业务码的 not found。 */
export function notFoundError(code: ErrorCodeValue, safeMessage: string): AppError {
  return new AppError({ code, safeMessage, httpStatus: 404 });
}

/** 便捷构造：入参校验失败。 */
export function validationError(safeMessage: string, details?: unknown): AppError {
  return new AppError({
    code: PlatformErrorCode.VALIDATION_FAILED,
    safeMessage,
    details,
  });
}

/**
 * 把任意 unknown 异常收敛为对外安全的统一错误响应体。
 * 非 AppError 一律降级为 `INTERNAL_ERROR`，不泄漏内部信息。
 */
export function toApiErrorBody(error: unknown, requestId: RequestId): ApiErrorBody {
  if (isAppError(error)) {
    return error.toApiErrorBody(requestId);
  }
  return {
    error: {
      code: PlatformErrorCode.INTERNAL_ERROR,
      message: 'Internal server error',
      requestId,
      details: null,
    },
  };
}
