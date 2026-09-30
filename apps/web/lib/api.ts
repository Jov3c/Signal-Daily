/**
 * API 客户端（**服务端**那一半）。
 *
 * ⚠ 本文件只能在 **Server Component / route handler** 里 import ——
 * 它用了 `next/headers`。浏览器侧请用 `./client-api`。
 * 两半分开是必须的：把 `next/headers` import 进一个会被客户端 bundle
 * 拉到的模块，构建会直接失败（而不是运行时报错）。
 *
 * ── 认证怎么过河 ────────────────────────────────────────────────────
 * `docs/11` 定的是 **HttpOnly + SameSite=Lax** 的 Cookie。于是浏览器
 * 自动带上它，但**服务端渲染时的 fetch 不会** —— `fetch()` 不带浏览器
 * 的 Cookie jar。所以这里显式把进来的 `Cookie` 头转给 API。
 *
 * 不这么做的话，只表现为「登录了但收藏页是空的」，非常难查：
 * 页面本身 200、没有报错、只是 data 少了。
 *
 * ── ⚠ 同域是硬前提 ──────────────────────────────────────────────────
 * `docs/16` 要求 nginx 同域（`/` 与 `/api/` 同一个域名）。跨域的话
 * `SameSite=Lax` 的 Cookie 根本不会发给 API，而 `AdminOriginGuard`
 * 会按 Origin 判敏感操作 —— 两处都会失败。所以 `API_BASE_URL`
 * 必须是**同一个站**下的地址。
 */

import { cookies } from 'next/headers';
import { API_PREFIX, REQUEST_ID_HEADER, type ApiErrorBody } from '@signal/contracts';

/**
 * API 的根地址（含 `/api`，**不含** `/v1`）。
 *
 * `docs/20` 的 `API_BASE_URL` 形如 `https://signal.example.com/api`，
 * 而契约里的 `API_PREFIX` 是 `/api/v1` —— 两者拼起来才是完整路径。
 * 拼的时候要小心别把 `/api` 写两遍，所以下面按「去尾斜杠 + 拼 `/v1`」处理。
 */
export function apiBaseUrl(): string {
  const raw = process.env['API_BASE_URL'];
  if (raw === undefined || raw === '') {
    // 本地开发（`pnpm dev`）的默认值：api 固定监听 3001（Agent 00 的决定）。
    return 'http://127.0.0.1:3001/api';
  }
  return raw.replace(/\/+$/, '');
}

/** 把契约前缀的后半段接到 `API_BASE_URL` 上：`/api` + `/v1` + path。 */
function urlOf(path: string): string {
  const suffix = API_PREFIX.slice('/api'.length); // → '/v1'
  const normalized = path.startsWith('/') ? path : `/${path}`;
  return `${apiBaseUrl()}${suffix}${normalized}`;
}

/**
 * API 返回的失败（**服务端**这一半；浏览器侧是 `ApiClientError`）。
 *
 * ── ⚠ 为什么叫 `ApiRequestError` 而不是 `ApiError` ──────────────────
 * `@signal/contracts` 已经导出**类型** `ApiError`（统一错误响应体）。
 * 在别处再声明一个同名类会被
 * `packages/contracts/src/__tests__/no-duplicate-enums.spec.ts`
 * 直接判红 —— 那条守卫的存在理由正是「公共类型只有一个来源」，
 * 而「同名但语义不同」比「同名同义」更糟：读代码的人会以为是同一个东西。
 * 第一次实测就被它抓到了。
 */
export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId: string | null,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

/** 请求选项。 */
export type ServerFetchOptions = {
  /** `no-store`（默认，永远取最新）或秒数。 */
  revalidate?: number;
  /** 不转发 Cookie（公开接口用它，避免登录态影响缓存）。 */
  anonymous?: boolean;
  /** 额外的查询参数（`undefined` 的键会被丢掉）。 */
  query?: Record<string, string | number | undefined | null>;
};

/**
 * GET 一个 API 路径并解开封套。
 *
 * ```ts
 * const today = await serverFetch<TodayView>('/today');
 * ```
 *
 * 默认 `cache: 'no-store'`：`docs/12` 的缓存策略已经落在 **API 侧**
 *（Redis，内容 60 秒 / 元数据 300 秒）。前端再叠一层 Next 的缓存会把
 * 「撤下后多久生效」变成两个窗口的**乘积**，而且第二个窗口不受
 * Agent 10 的失效逻辑控制 —— 那正是「后台点了撤下、前台还在展示」的来源。
 */
export async function serverFetch<T>(path: string, options: ServerFetchOptions = {}): Promise<T> {
  const url = new URL(urlOf(path));
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  }

  const headers: Record<string, string> = { accept: 'application/json' };
  if (options.anonymous !== true) {
    const cookie = (await cookies()).toString();
    if (cookie !== '') headers['cookie'] = cookie;
  }

  const response = await fetch(url, {
    headers,
    ...(options.revalidate === undefined
      ? { cache: 'no-store' as const }
      : { next: { revalidate: options.revalidate } }),
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as ApiErrorBody | null;
    throw new ApiRequestError(
      response.status,
      body?.error.code ?? 'INTERNAL_ERROR',
      body?.error.message ?? `API ${String(response.status)}`,
      body?.error.requestId ?? response.headers.get(REQUEST_ID_HEADER),
    );
  }

  return (await response.json()) as T;
}

/**
 * 列表接口的封套。
 *
 * 三种形状由 `@signal/contracts` 定义（`ApiEnvelope` / `CursorEnvelope` /
 * `OffsetEnvelope`），这里只挑前台用得上的两种。
 */
export type CursorPage<T> = { data: T[]; meta: { nextCursor: string | null } };
export type OffsetPage<T> = {
  data: T[];
  meta: { page: number; pageSize: number; total: number; totalPages: number };
};
export type Single<T> = { data: T };
