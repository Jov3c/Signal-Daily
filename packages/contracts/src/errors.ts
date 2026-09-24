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

  /* ---- Agent 03 — Source Registry（docs/06 / docs/14 / tasks/agent-03-sources.md） ---- */

  /**
   * slug 已被其它 Source 占用（`sources.slug` 唯一约束）。
   *
   * 注意与 `VALIDATION_FAILED` 的分工：slug **格式**非法是入参校验失败，
   * slug **撞车**才是本码（客户端要做的是换一个 slug，而不是改格式）。
   */
  SOURCE_DUPLICATE_SLUG: 'SOURCE_DUPLICATE_SLUG',
  /**
   * 来源 URL 被 SSRF 规则拒绝。
   *
   * 覆盖：非 http(s) scheme、URL 内嵌凭据、端口 0、
   * 以及指向 loopback / private / link-local / CGNAT / metadata 等地址
   * （含各种伪装写法）。详见 `modules/sources/url-safety`。
   */
  SOURCE_URL_NOT_ALLOWED: 'SOURCE_URL_NOT_ALLOWED',
  /**
   * 与该 SourceType 匹配的 `config` 校验失败。
   *
   * 例如 `X_USER` 缺 `handle`、`MANUAL_URL` 缺 `url`、或出现了该类型未声明的键。
   * 与 `VALIDATION_FAILED` 的分工：后者管 DTO 通用字段（name / slug / tier / ...），
   * 本码只管 `config` 这一个自由结构。
   */
  SOURCE_CONFIG_INVALID: 'SOURCE_CONFIG_INVALID',
  /**
   * 采集任务入队失败（BullMQ / Redis 不可用）。
   *
   * 语义是「服务暂时不可用、可重试」，因此是 503 而不是 500 ——
   * Agent 11 看到这个码应当去查 Redis，而不是查业务代码。
   */
  SOURCE_ENQUEUE_FAILED: 'SOURCE_ENQUEUE_FAILED',

  /* ---- Agent 06 — AI Provider / 翻译 / 分类 / 评分（docs/08 / docs/13 / docs/14） ---- */

  /**
   * `docs/20` 的 AI 配置不完整（缺 `AI_DEFAULT_BASE_URL` 或对应档位的
   * `AI_MODEL_CHEAP|MEDIUM|STRONG`）。
   *
   * **不静默降级**，与 Agent 02 的 `AUTH_MAIL_NOT_CONFIGURED`、
   * Agent 04 的 `SOURCE_FETCH_CREDENTIALS_MISSING` 同一取舍：
   * 没配就是跑不了，如实失败，而不是让内容一直拿不到分却显示一切正常。
   * 不可重试。
   */
  AI_NOT_CONFIGURED: 'AI_NOT_CONFIGURED',
  /**
   * 上游 AI 以 401 / 403 拒绝我们的凭据。
   *
   * 与 Agent 04 的 `SOURCE_FETCH_UNAUTHORIZED` 同一语义，只是主体不同
   * （AI 端点 vs 采集源）。不可重试 —— 重试同一份坏 key 只会把额度烧光，
   * 还可能触发上游账号风控。
   */
  AI_PROVIDER_UNAUTHORIZED: 'AI_PROVIDER_UNAUTHORIZED',
  /**
   * AI 调用的**瞬时**失败：网络错误、超时、429、5xx。
   *
   * 与确定性 4xx 共用本码是刻意的：两者的处置动作相同（去看上游状态与请求形状），
   * 而「要不要重试」由 `AiError.kind` 决定，不需要再用一个错误码区分一次 ——
   * 契约要求「一个语义只能有一个 code」，而「上游这次没答好」就是一个语义。
   */
  AI_REQUEST_FAILED: 'AI_REQUEST_FAILED',
  /**
   * 模型答了，但不是约定的结构（非 JSON / 缺字段 / 有多余字段 / 类型不符）。
   *
   * `docs/13`：schema invalid 只重试 1 次。
   * **多余字段也算失败**是刻意的 —— `docs/08` 要求 AI 不能改写 Source Tier、
   * 不能自称官方，而「模型试图输出这些字段」必须是一次可见的失败，
   * 不能被静默丢弃（静默丢弃 = 看不见的攻击）。
   */
  AI_RESPONSE_INVALID: 'AI_RESPONSE_INVALID',
  /**
   * 该 provider / model 不支持这个任务或请求形状（例如端点不认 `response_format`）。
   *
   * `docs/13`：unsupported 不 retry。管理员要做的是换模型或换端点。
   * 也与「本模块尚未实现该任务」共用本码 —— 对看板而言都是「这个任务没跑成，
   * 而且再试一次也不会成」。
   */
  AI_TASK_UNSUPPORTED: 'AI_TASK_UNSUPPORTED',
  /**
   * 当日 AI 预算已耗尽（`AI_DAILY_BUDGET_USD`，按 Asia/Shanghai 业务日统计），
   * 该任务又不是关键任务，因此暂停到次日。
   *
   * 不可重试 —— 重试只会继续撞同一堵墙。`docs/08`：
   * 「预算 80% 告警 / 100% 非关键任务暂停」；内容与低分都不会被删除，
   * 只是这一轮不做。
   */
  AI_BUDGET_EXCEEDED: 'AI_BUDGET_EXCEEDED',
  /**
   * 任务载荷里的 `contentId` 在库中不存在。
   *
   * 通常是上游传错 id，或内容在入队与执行之间被删掉了。
   * 不可重试：重试同一个不存在的 id 只会得到同样的结果。
   */
  AI_CONTENT_NOT_FOUND: 'AI_CONTENT_NOT_FOUND',
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
