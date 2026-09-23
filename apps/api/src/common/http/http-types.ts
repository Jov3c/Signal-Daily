/**
 * 最小 HTTP 结构类型。
 *
 * 为什么不直接用 express 的 `Request` / `Response`：
 * 本仓库没有（也不打算为了日志/守卫而新增）`@types/express` 依赖。
 * 这里只声明我们真正用到的成员，结构类型即可被 express 的 request/response 满足，
 * 好处是守卫、过滤器、Cookie 工具都能在**没有任何 HTTP 框架实例**的单元测试里直接构造。
 */

/** 只读请求头载体。`x-forwarded-*` 这类头在 Node 里可能是数组。 */
export type HeaderCarrier = {
  headers: Record<string, string | string[] | undefined>;
};

/** 请求的最小形状。 */
export type HttpRequestLike = HeaderCarrier & {
  method?: string;
  url?: string;
  /** 由 `resolveRequestId()` 写入，保证一次请求内处处同一个 ID。 */
  requestId?: string;
  /** 由 AuthGuard 写入；未认证时为 undefined。 */
  authUser?: AuthUser;
};

/** 响应的最小形状。 */
export type HttpResponseLike = {
  setHeader(name: string, value: string | string[]): unknown;
};

/** 认证后的请求主体（挂在 `req.authUser`）。 */
export type AuthUser = {
  /** BIGINT → string（docs/02）。 */
  id: string;
  role: string;
  /** 当前 access token 所属的 Session，便于 logout / 审计。 */
  sessionId: string;
};

/**
 * 读取单个请求头。
 * Node 对重复请求头（如多个 `Cookie`）会给出数组，这里统一取第一个。
 */
export function readHeader(req: HeaderCarrier, name: string): string | undefined {
  const raw = req.headers[name.toLowerCase()];
  if (Array.isArray(raw)) return raw[0];
  return raw;
}
