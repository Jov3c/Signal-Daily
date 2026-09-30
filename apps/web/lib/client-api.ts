/**
 * API 客户端（**浏览器**那一半）。
 *
 * ⚠ 与 `./api` 的分工：那个跑在服务端、要手动转发 Cookie；
 * 这个跑在浏览器里，**Cookie 由浏览器自己带**（同域 + HttpOnly）。
 * 所以这里用的是**相对路径**（`/api/v1/...`），不拼 `API_BASE_URL` ——
 * 拼了反而会把请求打到另一个源上，而 `SameSite=Lax` 的 Cookie
 * 与 `AdminOriginGuard` 都要求同源。
 *
 * ── 为什么每个失败都要带上 `code` ───────────────────────────────────
 * UI 要按**业务码**分支，不是按状态码。例如收藏失败时
 * `CONTENT_NOT_VISIBLE`（内容被撤下）要提示「这篇已经不可见了」，
 * 而 401 要提示登录 —— 两者可能都是 404 / 401，靠状态码分不出来。
 */

import { API_PREFIX, type ApiErrorBody } from '@signal/contracts';
import type { MeDto, UserPreferences } from './types';

/** 浏览器侧的失败。 */
export class ApiClientError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: unknown,
  ) {
    super(message);
    this.name = 'ApiClientError';
  }

  /** 未登录（`AuthGuard` 的 401）。 */
  get isUnauthorized(): boolean {
    return this.status === 401;
  }
}

type RequestOptions = {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** 附加的查询参数。 */
  query?: Record<string, string | number | undefined>;
};

/**
 * 发一个请求并把结果解开封套。
 *
 * `credentials: 'same-origin'` 是**显式**写的：默认值就是这样，
 * 但把它写出来是在强调「认证完全依赖同域 Cookie」——
 * 也是提醒后来者不要为了图省事改成 `include` 去跨域调。
 */
export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const url = new URL(
    `${API_PREFIX}${path.startsWith('/') ? path : `/${path}`}`,
    window.location.origin,
  );
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined && value !== '') url.searchParams.set(key, String(value));
  }

  const response = await fetch(url, {
    method: options.method ?? 'GET',
    credentials: 'same-origin',
    headers: {
      accept: 'application/json',
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as ApiErrorBody | null;
    throw new ApiClientError(
      response.status,
      body?.error.code ?? 'INTERNAL_ERROR',
      body?.error.message ?? `请求失败（${String(response.status)}）`,
      body?.error.details ?? null,
    );
  }

  // 204 之类的空响应：解 JSON 会抛，这里如实返回 undefined。
  const text = await response.text();
  return (text === '' ? undefined : JSON.parse(text)) as T;
}

/* ------------------------------------------------------------------ */
/* 登录（邮箱验证码 / OTP）—— 按用户决定：**只做邮箱，不接 GitHub**       */
/* ------------------------------------------------------------------ */

/**
 * `POST /auth/email/request-code` 的响应。
 *
 * `sent` 恒为 `true` —— 服务端**不透露该邮箱是否已注册**（防账号枚举）。
 */
export type RequestCodeResponse = { sent: true; expiresInSeconds: number };

/** `POST /auth/email/verify` 与 `/auth/refresh` 的响应（会话已由 Set-Cookie 建好）。 */
export type AuthSessionResponse = {
  user: MeDto;
  accessTokenExpiresInSeconds: number;
};

/**
 * 请求一次性验证码。
 *
 * ⚠ 界面文案**必须**跟着服务端这条语义走：它不会告诉你邮箱是否注册过。
 * 所以只能写「如果这个邮箱可用，验证码已经发出」，不能写「已发送，请查收」
 *（那会让「这个邮箱没注册」变成一个可观测的差异），更不能写「该邮箱不存在」。
 */
export async function requestEmailCode(email: string): Promise<RequestCodeResponse> {
  // ⚠ **必须解封套。** API 一律返回 `{data: …}`（`docs/02`），
  // 漏掉 `.data` 的话业务字段全是 `undefined` —— 而**类型检查不会报错**，
  // 因为这个函数的返回类型是我们自己声明的（它撒了谎）。
  const body = await apiRequest<{ data: RequestCodeResponse }>('/auth/email/request-code', {
    method: 'POST',
    body: { email },
  });
  return body.data;
}

/** 用验证码换会话（服务端会 Set-Cookie：HttpOnly + SameSite=Lax）。 */
export async function verifyEmailCode(email: string, code: string): Promise<AuthSessionResponse> {
  // ⚠ 这里漏 `.data` 的后果**不是「少显示一个字段」，而是登录后整个页面崩**：
  // 抽屉会拿到 `undefined` 当会话 → `session.user` 是 `undefined` →
  // 顶栏读 `user.displayName` → `TypeError`。
  // 而它躲过了全部测试与类型检查 —— 因为函数自己声明了返回类型，
  // 而运行时返回的是封套。**只有浏览器里真的点一次才会发现。**
  const body = await apiRequest<{ data: AuthSessionResponse }>('/auth/email/verify', {
    method: 'POST',
    body: { email, code },
  });
  return body.data;
}

/** 读当前登录用户。未登录时抛 `ApiClientError`（401）。 */
export async function fetchMe(): Promise<MeDto> {
  const body = await apiRequest<{ data: MeDto }>('/me');
  return body.data;
}

/** 登出。 */
export async function logout(): Promise<void> {
  // 返回值同样包在封套里（`envelope({ loggedOut: true })`）。这里不读它，
  // 但类型要写对 —— 三个登录相关的调用里有两个就是因为类型写错而静默失效的。
  await apiRequest<{ data: { loggedOut: true } }>('/auth/logout', { method: 'POST' });
}

/* ------------------------------------------------------------------ */
/* 用户能力（收藏 / 阅读进度 / 偏好）                                   */
/* ------------------------------------------------------------------ */

/**
 * 加/取消收藏。**幂等**（`docs/11`）：重复加不会报错，状态由响应给出。
 */
export async function setBookmark(
  contentId: string,
  bookmarked: boolean,
): Promise<{ contentId: string; bookmarked: boolean; createdAt: string | null }> {
  const body = await apiRequest<{
    data: { contentId: string; bookmarked: boolean; createdAt: string | null };
  }>(`/bookmarks/${contentId}`, { method: bookmarked ? 'POST' : 'DELETE' });
  return body.data;
}

/** 上报阅读进度。`>= 0.95` 视为读完（`docs/11`）。 */
export async function saveReadingProgress(
  contentId: string,
  progress: number,
): Promise<void> {
  await apiRequest<unknown>('/reading-progress', {
    method: 'PUT',
    body: { contentId, progress },
  });
}

/** 读偏好（登录用户的服务端同步值）。 */
export async function fetchPreferences(): Promise<UserPreferences> {
  const body = await apiRequest<{ data: UserPreferences }>('/me/preferences');
  return body.data;
}

/** 写偏好（部分更新；只提交改动过的字段）。 */
export async function savePreferences(patch: Partial<UserPreferences>): Promise<UserPreferences> {
  const body = await apiRequest<{ data: UserPreferences }>('/me/preferences', {
    method: 'PUT',
    body: patch,
  });
  return body.data;
}
