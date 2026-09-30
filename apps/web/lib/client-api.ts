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
 *
 * ── ⚠ 封套 `{data: …}` 的解包**只在这一个文件、这一个函数里做** ────
 *
 * 2026-09-30 的浏览器走查发现 `verifyEmailCode` 忘了读 `.data`，
 * 后果不是「少显示一个字段」，而是**登录成功后整个页面崩**：
 * 抽屉拿到封套当会话 → `session.user` 是 `undefined` → 顶栏读
 * `user.displayName` → `TypeError`。
 *
 * **它躲过了全部 1932 个测试和类型检查。** 因为返回类型是**我们自己声明的**：
 * 写成 `Promise<AuthSessionResponse>` 而实际返回 `{data: AuthSessionResponse}`，
 * TypeScript 不会拆穿 —— 类型检查不会发现一个谎言，它只检查这个谎言自洽。
 *
 * 所以修法不是「补一条测试提醒大家别忘」，而是把解包**下沉进 `apiRequest`**，
 * 让调用方**在结构上没有机会忘记**：
 *
 * ```text
 * 改前  apiRequest<{data: T}>(path)  →  调用方自己 .data   ← 可以忘，忘了没人知道
 * 改后  apiRequest<T>(path)          →  拿到的就是载荷     ← 忘不了
 * ```
 *
 * 泛型参数的含义从「封套类型」变成「**载荷**类型」。这比加测试强：
 * 测试只能证明「我测过的那几个没忘」，而这里证明的是「**任何人都忘不了**」。
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
 * ⚠ **编译期守卫：载荷类型里不允许出现 `data` 键。**
 *
 * `apiRequest` 已经解开封套了（见文件头）。但如果调用方还按旧约定写
 *
 * ```ts
 * const body = await apiRequest<{ data: PublishResult }>(path);  // ← 旧的写法
 * const result = body.data;                                      // ← 永远是 undefined
 * ```
 *
 * 那么 `body` 的真实类型是 `PublishResult` 而**不是** `{data: PublishResult}` ——
 * 于是 `body.data` 是 `undefined`，**而类型检查不会报错**：泛型是调用方自己填的，
 * TypeScript 只会老老实实相信它。这就是那个登录 bug 的**同一个形状**，只是方向相反。
 *
 * 这不是假设出来的风险：2026-09-30 改这一版时，代码里**已经潜伏着两处**
 *（`admin-daily-actions.tsx` 的发布、`article-client.tsx` 的证据列表），
 * 两处都在成功路径上读 `.data` —— 其中一处会让「发布成功」显示成「操作失败」。
 * 一个错误形状能同时潜伏两处，就说明它会继续复发，靠人记是不行的。
 *
 * 所以直接在类型层面堵死：传进来的 `T` 若含 `data` 键 → 返回 `never` →
 * 对它的**任何**读取都是编译错误。错误发生在 `pnpm typecheck`，而不是用户的浏览器里。
 */
type PayloadOnly<T> = 'data' extends keyof T ? never : T;

/**
 * 发一个请求，**并把 `{data: …}` 封套解开**。
 *
 * `T` 是**载荷**类型，不是封套类型 —— 见文件头。这个函数是这一层里
 * 唯一允许看到封套的地方。
 *
 * `credentials: 'same-origin'` 是**显式**写的：默认值就是这样，
 * 但把它写出来是在强调「认证完全依赖同域 Cookie」——
 * 也是提醒后来者不要为了图省事改成 `include` 去跨域调。
 */
export async function apiRequest<T>(
  path: string,
  options: RequestOptions = {},
): Promise<PayloadOnly<T>> {
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
  if (text === '') return undefined as PayloadOnly<T>;

  const body: unknown = JSON.parse(text);

  /**
   * ⚠ **封套守卫：宁可炸，也不要静默 `undefined`。**
   *
   * 少了 `data` 键只有两种可能，两种都不该被当成「字段为空」混过去：
   *   1. 我们连错了端点（或不存在的端点被某个中间层兜住了）；
   *   2. 反向代理把一张 HTML 错误页当成 200 返回了（`JSON.parse` 那一步会先炸）。
   *
   * 之前的写法是直接 `.data`，于是「端点错了」和「这个字段就是 null」
   * 在调用方看来一模一样 —— 而这正是那个登录 bug 能藏那么久的原因。
   * 用 `in` 而不是 `!== undefined`：载荷**本身**是 `null` 时（`{data: null}`）
   * 是合法的，不能误伤。
   */
  if (typeof body !== 'object' || body === null || !('data' in body)) {
    throw new ApiClientError(
      response.status,
      'INTERNAL_ERROR',
      'API 响应缺少 data 封套（端点或反向代理可能不对）',
      body,
    );
  }

  return (body as { data: PayloadOnly<T> }).data;
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
  return apiRequest<RequestCodeResponse>('/auth/email/request-code', {
    method: 'POST',
    body: { email },
  });
}

/** 用验证码换会话（服务端会 Set-Cookie：HttpOnly + SameSite=Lax）。 */
export async function verifyEmailCode(email: string, code: string): Promise<AuthSessionResponse> {
  return apiRequest<AuthSessionResponse>('/auth/email/verify', {
    method: 'POST',
    body: { email, code },
  });
}

/** 读当前登录用户。未登录时抛 `ApiClientError`（401）。 */
export async function fetchMe(): Promise<MeDto> {
  return apiRequest<MeDto>('/me');
}

/** 登出。 */
export async function logout(): Promise<void> {
  // 载荷是 `{ loggedOut: true }`，这里不读它 —— 但**类型要写对**，
  // 因为 `apiRequest` 的泛型现在就是载荷类型（写错会在编译期就露出来）。
  await apiRequest<{ loggedOut: true }>('/auth/logout', { method: 'POST' });
}

/* ------------------------------------------------------------------ */
/* 用户能力（收藏 / 阅读进度 / 偏好）                                   */
/* ------------------------------------------------------------------ */

/** `setBookmark` 的载荷。 */
export type BookmarkState = {
  contentId: string;
  bookmarked: boolean;
  createdAt: string | null;
};

/**
 * 加/取消收藏。**幂等**（`docs/11`）：重复加不会报错，状态由响应给出。
 */
export async function setBookmark(contentId: string, bookmarked: boolean): Promise<BookmarkState> {
  return apiRequest<BookmarkState>(`/bookmarks/${contentId}`, {
    method: bookmarked ? 'POST' : 'DELETE',
  });
}

/** 上报阅读进度。`>= 0.95` 视为读完（`docs/11`）。 */
export async function saveReadingProgress(contentId: string, progress: number): Promise<void> {
  // 服务端返回 `{contentId, progress, completed}`，这一层用不到它。
  await apiRequest<unknown>('/reading-progress', {
    method: 'PUT',
    body: { contentId, progress },
  });
}

/** 读偏好（登录用户的服务端同步值）。 */
export async function fetchPreferences(): Promise<UserPreferences> {
  return apiRequest<UserPreferences>('/me/preferences');
}

/** 写偏好（部分更新；只提交改动过的字段）。 */
export async function savePreferences(patch: Partial<UserPreferences>): Promise<UserPreferences> {
  return apiRequest<UserPreferences>('/me/preferences', {
    method: 'PUT',
    body: patch,
  });
}
