/**
 * Jobs（后台 `/admin/jobs`）—— 作业运行历史。
 *
 * ⚠ **这一页的接口是本次新补的**（`GET /admin/jobs`）。`docs/04` 与
 * 已实现的代码里都没有它，而 `tasks/agent-12-admin-ui.md` 要求这一页 ——
 * 数据一直都在（`job_runs` 由 worker 的 04 / 05 / 06 / 08 写入），
 * 只是没有出口。用户于 2026-09-30 授权补上，见 CCR-agent-12 第 1 项。
 *
 * ── 这一页要回答的问题 ──────────────────────────────────────────────
 * 「昨天晚上那条日报为什么没生成？」「采集器是不是在反复失败？」
 * 所以列的是：**谁**（jobType）、**什么时候**、**多久**、**成没成**、
 * **错在哪**（errorCode）。`metadata` 不展开显示（内容由各 Job 自己决定，
 * 后台不该假装懂它）—— 需要时看日志。
 */

import type { ReactElement } from 'react';
import Link from 'next/link';
import { AdminDenied, Badge, DataTable, EmptyRow, duration, isoShort } from '../../../components/admin-ui';
import { PageHead } from '../../../components/shell';
import { ApiRequestError, serverFetch } from '../../../lib/api';
import type { AdminJobRun } from '../../../lib/admin-types';
import { JobRunStatus, JOB_RUN_STATUSES } from '@signal/contracts';

type ListResponse = {
  data: AdminJobRun[];
  meta: { page: number; pageSize: number; total: number; totalPages: number };
};

/** 失败与 DEAD 要显眼：它们是「需要人看一眼」的状态。 */
function toneOf(status: JobRunStatus): 'warn' | undefined {
  return status === JobRunStatus.FAILED || status === JobRunStatus.DEAD ? 'warn' : undefined;
}

export default async function AdminJobsPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; jobType?: string; status?: string }>;
}): Promise<ReactElement> {
  const { page, jobType, status } = await searchParams;

  let list: ListResponse;
  try {
    list = await serverFetch<ListResponse>('/admin/jobs', { query: { page, jobType, status } });
  } catch (error) {
    if (error instanceof ApiRequestError && (error.status === 401 || error.status === 403)) {
      return <AdminDenied status={error.status} />;
    }
    throw error;
  }

  return (
    <div className="container">
      <PageHead
        eyebrow="Jobs"
        title="作业运行历史"
        subtle={`${String(list.meta.total)} 条，按开始时间倒序。`}
        action={{ href: '/admin/ai-usage', label: '看 AI 用量' }}
      />

      <div className="admin-toolbar">
        <Link className={status === undefined ? 'tab active' : 'tab'} href="/admin/jobs">
          全部
        </Link>
        {JOB_RUN_STATUSES.map((value) => (
          <Link
            key={value}
            className={status === value ? 'tab active' : 'tab'}
            href={`/admin/jobs?status=${value}`}
          >
            {value}
          </Link>
        ))}
        <span className="spacer" />
        <span className="subtle">
          第 {list.meta.page} / {list.meta.totalPages} 页
        </span>
      </div>

      <DataTable headers={['状态', '作业类型', 'Key', '开始', '耗时', '尝试', '错误码']}>
        {list.data.length === 0 ? (
          <EmptyRow span={7} text="还没有作业运行记录。" />
        ) : (
          list.data.map((row) => (
            <tr key={row.id}>
              <td>
                <Badge tone={toneOf(row.status)}>{row.status}</Badge>
              </td>
              <td>{row.jobType}</td>
              <td className="subtle">{row.jobKey ?? '—'}</td>
              <td>{isoShort(row.startedAt)}</td>
              <td className="num">{duration(row.durationMs)}</td>
              <td className="num">{row.attempts}</td>
              <td>
                {row.errorCode === null ? (
                  <span className="subtle">—</span>
                ) : (
                  <Badge tone="warn">{row.errorCode}</Badge>
                )}
              </td>
            </tr>
          ))
        )}
      </DataTable>

      <div className="end-actions" style={{ marginTop: '18px', gap: '8px' }}>
        {list.meta.page <= 1 ? null : (
          <Link className="soft-btn" href={hrefOf(list.meta.page - 1, jobType, status)}>
            上一页
          </Link>
        )}
        {list.meta.page >= list.meta.totalPages ? null : (
          <Link className="soft-btn" href={hrefOf(list.meta.page + 1, jobType, status)}>
            下一页
          </Link>
        )}
      </div>

      <p className="subtle" style={{ marginTop: '14px' }}>
        「耗时」是由 `finishedAt - startedAt` **派生**的：还在跑的作业显示 `—`
        而不是 `0ms`（那会看起来像「瞬间完成」）。`metadata` 不展示 ——
        它的形状由各 Job 自己决定，后台不该假装懂它。
      </p>
    </div>
  );
}

function hrefOf(page: number, jobType?: string, status?: string): string {
  const params = new URLSearchParams({ page: String(page) });
  if (jobType !== undefined) params.set('jobType', jobType);
  if (status !== undefined) params.set('status', status);
  return `/admin/jobs?${params.toString()}`;
}
