/**
 * Auth 模块的请求校验与响应 DTO。
 *
 * 归属说明：按 `docs/18`，跨 app DTO 应在 `packages/contracts`；
 * 该包是 Agent 00 冻结区，因此响应类型先落在模块内，
 * 并已提交 `handoffs/CONTRACT_CHANGE_REQUEST-agent-02.md` 请求后续提升，
 * 供 Agent 12 / 13 复用。
 *
 * 校验方式：**手写**而不是 class-validator。
 * 理由：本模块的入参只有 email / code / code+state 三种，手写能精确控制
 * 「归一化、长度上限、未知字段处理」，且不引入两个新依赖。
 * 下游若要 class-validator，可自行添加，不影响这里。
 */

import type { MeDto } from '../../users/dto/me.dto';

/* ------------------------------------------------------------------ */
/* Responses                                                           */
/* ------------------------------------------------------------------ */

/** `POST /auth/email/request-code`。 */
export type RequestCodeResponse = {
  /** 恒为 true —— **不透露该邮箱是否已注册**（防账号枚举）。 */
  sent: true;
  expiresInSeconds: number;
};

/** `POST /auth/email/verify` 与 `POST /auth/refresh`。 */
export type AuthSessionResponse = {
  user: MeDto;
  accessTokenExpiresInSeconds: number;
};

/** `POST /auth/logout`。 */
export type LogoutResponse = {
  loggedOut: true;
};

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

export type ParseResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };

/** 邮箱长度上限（RFC 5321 的 254）。 */
export const MAX_EMAIL_LENGTH = 254;

/** 够用且不过度严格的邮箱形状。 */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** OTP 必须是 6 位数字。 */
const OTP_CODE_PATTERN = /^\d{6}$/;

function asRecord(body: unknown): Record<string, unknown> | null {
  return typeof body === 'object' && body !== null && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : null;
}

/** 解析并校验 email。返回归一化后的值（trim + 小写）。 */
function parseEmail(raw: unknown, errors: string[]): string | null {
  if (typeof raw !== 'string') {
    errors.push('email must be a string');
    return null;
  }
  const value = raw.trim().toLowerCase();
  if (value === '' || value.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(value)) {
    errors.push('email must be a valid email address');
    return null;
  }
  // 拒绝 CR/LF 等控制字符：邮箱会进入邮件头，换行可能被用来注入额外头部。
  if (hasControlCharacter(value)) {
    errors.push('email must not contain control characters');
    return null;
  }
  return value;
}

/**
 * 是否含 ASCII 控制字符（含 CR / LF / NUL / DEL）。
 *
 * 用显式码点判断而不是正则字符类：正则写控制字符范围可读性差，
 * 而且容易在转义层被改坏。
 */
function hasControlCharacter(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** `POST /auth/email/request-code` 的 body。 */
export function parseRequestCodeBody(body: unknown): ParseResult<{ email: string }> {
  const record = asRecord(body);
  if (record === null) return { ok: false, errors: ['body must be a JSON object'] };

  const errors: string[] = [];
  const email = parseEmail(record.email, errors);
  if (email === null || errors.length > 0) return { ok: false, errors };

  return { ok: true, value: { email } };
}

/** `POST /auth/email/verify` 的 body。 */
export function parseVerifyCodeBody(body: unknown): ParseResult<{ email: string; code: string }> {
  const record = asRecord(body);
  if (record === null) return { ok: false, errors: ['body must be a JSON object'] };

  const errors: string[] = [];
  const email = parseEmail(record.email, errors);

  const rawCode = record.code;
  let code: string | null = null;
  if (typeof rawCode !== 'string') {
    errors.push('code must be a string');
  } else {
    const trimmed = rawCode.trim();
    if (!OTP_CODE_PATTERN.test(trimmed)) {
      errors.push('code must be exactly 6 digits');
    } else {
      code = trimmed;
    }
  }

  if (email === null || code === null || errors.length > 0) return { ok: false, errors };
  return { ok: true, value: { email, code } };
}

/**
 * 读取 GitHub 在回调里带回的错误标记（如 `error=access_denied`）。
 * 与 `parseGithubCallbackQuery` 分开：取消授权时没有 `code`，
 * 不能把「用户取消」当成「参数非法」。
 */
export function readProviderError(query: unknown): string | null {
  const record = asRecord(query);
  const value = record?.error;
  return typeof value === 'string' && value !== '' ? value : null;
}

/** `GET /auth/github/callback` 的 query（正常回调分支）。 */
export function parseGithubCallbackQuery(
  query: unknown,
): ParseResult<{ code: string; state: string }> {
  const record = asRecord(query);
  if (record === null) return { ok: false, errors: ['query must be an object'] };

  const errors: string[] = [];
  const code = typeof record.code === 'string' && record.code !== '' ? record.code : null;
  const state = typeof record.state === 'string' && record.state !== '' ? record.state : null;
  if (code === null) errors.push('code is required');
  if (state === null) errors.push('state is required');

  if (code === null || state === null) return { ok: false, errors };
  return { ok: true, value: { code, state } };
}
