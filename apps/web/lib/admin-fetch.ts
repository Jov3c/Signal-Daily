/**
 * 后台页面的取数封装。
 *
 * ── 为什么需要它 ────────────────────────────────────────────────────
 * 9 个后台页面原先各自写一份一模一样的 try/catch：捕获 401 / 403 就渲染
 * 「无权访问」面板，其余错误一律重新抛出。那段逻辑每页近十行，
 * 而它恰恰是**安全相关**的 —— 401 与 403 为什么要分开说，
 * 理由写在 `components/admin-ui.tsx` 的 `AdminDenied` 上。
 * 安全相关的判断不该有九份副本：改一处却漏了另一处，不会有任何测试变红。
 *
 * ── 语义（刻意保守）────────────────────────────────────────────────
 * 只把**列出来的**状态码收敛成 `{ ok: false }`，其余**照旧抛出**。
 * 默认只有 401 / 403 —— 500 不是权限问题，把它渲染成「无权访问」
 * 会把一个真实的故障伪装成「你没登录」，比直接报错更难排查。
 * 需要多收一个状态码的页面（如详情页的 404）显式传 `handledStatuses`。
 */

import { ApiRequestError, serverFetch, type ServerFetchOptions, type Single } from './api';

/** 命中了「可预期」的失败状态码。 */
export type AdminLoadResult<T> = { ok: true; data: T } | { ok: false; status: number };

/** 默认收敛的状态码：401 未登录、403 已登录但不是管理员。 */
export const DEFAULT_HANDLED_STATUSES: readonly number[] = [401, 403];

/**
 * 取一份后台数据；命中的状态码返回 `{ ok: false, status }`。
 *
 * ```ts
 * const result = await loadAdmin<OffsetPage<AdminJobRun>>('/admin/jobs', { page });
 * if (!result.ok) return <AdminDenied status={result.status} />;
 * const list = result.data;
 * ```
 */
export async function loadAdmin<T>(
  path: string,
  query?: ServerFetchOptions['query'],
  handledStatuses: readonly number[] = DEFAULT_HANDLED_STATUSES,
): Promise<AdminLoadResult<T>> {
  try {
    return { ok: true, data: await serverFetch<T>(path, query === undefined ? {} : { query }) };
  } catch (error) {
    if (error instanceof ApiRequestError && handledStatuses.includes(error.status)) {
      return { ok: false, status: error.status };
    }
    throw error;
  }
}

/**
 * 同上，但**自动解开 `Single<T>` 信封** —— 省掉调用点的 `result.data.data`。
 *
 * ```ts
 * const result = await loadAdminSingle<DashboardStats>('/admin/dashboard');
 * if (!result.ok) return <AdminDenied status={result.status} />;
 * const stats = result.data;
 * ```
 */
export async function loadAdminSingle<T>(
  path: string,
  query?: ServerFetchOptions['query'],
  handledStatuses: readonly number[] = DEFAULT_HANDLED_STATUSES,
): Promise<AdminLoadResult<T>> {
  const result = await loadAdmin<Single<T>>(path, query, handledStatuses);
  return result.ok ? { ok: true, data: result.data.data } : result;
}
