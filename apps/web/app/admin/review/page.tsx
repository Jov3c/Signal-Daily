/**
 * 审核队列（后台 `/admin/review`）—— `docs/09` 的 Review Queue。
 *
 * 默认排序 `finalScore DESC, publishedAt DESC`（由 API 决定，前端不重排 ——
 * 重排意味着「分页边界」与「显示顺序」用了两套规则）。
 *
 * `docs/09`：列表要额外显示 **Source Tier / Official / Independent Source
 * Count**。前两个在 `ReviewListRow.source` 里，**第三个不在** ——
 * 独立来源数是**事件**的属性（`distinct source_id`），只有详情页
 *（`/admin/review/:contentId` 的 `event.independentSourceCount`）才给。
 *
 * ⚠ 所以列表里**没有**这一列。用 `eventId` 是否存在来「猜」一个数字
 * 是更糟的选择：审核员会拿它做判断，而一个编出来的数字看起来与真的没区别。
 *
 * 批量动作**只允许 Defer / Reject**（`docs/09`），且那是客户端元件
 * （`components/admin-bulk-actions.tsx`）。
 */

import type { ReactElement } from 'react';
import Link from 'next/link';
import { AdminDenied } from '../../../components/admin-ui';
import { ReviewQueue } from '../../../components/admin-review-queue';
import { PageHead } from '../../../components/shell';
import { ApiRequestError, serverFetch } from '../../../lib/api';
import type { ReviewListRow } from '../../../lib/admin-types';
import { EditorialReviewStatus } from '@signal/contracts';

type ListResponse = {
  data: ReviewListRow[];
  meta: { page: number; pageSize: number; total: number; totalPages: number };
};

export default async function AdminReviewQueuePage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; status?: string; minScore?: string }>;
}): Promise<ReactElement> {
  const { page, status, minScore } = await searchParams;

  let list: ListResponse;
  try {
    list = await serverFetch<ListResponse>('/admin/review', {
      query: { page, status, minScore },
    });
  } catch (error) {
    if (error instanceof ApiRequestError && (error.status === 401 || error.status === 403)) {
      return <AdminDenied status={error.status} />;
    }
    throw error;
  }

  const { meta } = list;

  return (
    <div className="container">
      <PageHead
        eyebrow="Review queue"
        title="审核队列"
        subtle={`${String(meta.total)} 条，按分数倒序（同分按发布时间）。`}
      />

      <div className="admin-toolbar">
        <Link
          className={status === undefined ? 'tab active' : 'tab'}
          href="/admin/review"
        >
          全部
        </Link>
        <Link
          className={status === EditorialReviewStatus.PENDING ? 'tab active' : 'tab'}
          href={`/admin/review?status=${EditorialReviewStatus.PENDING}`}
        >
          待审
        </Link>
        <Link
          className={status === EditorialReviewStatus.DEFERRED ? 'tab active' : 'tab'}
          href={`/admin/review?status=${EditorialReviewStatus.DEFERRED}`}
        >
          已搁置
        </Link>
        <Link
          className={minScore === undefined ? 'tab' : 'tab active'}
          href="/admin/review?minScore=85"
        >
          只要高分
        </Link>
        <span className="spacer" />
        <span className="subtle">
          第 {meta.page} / {meta.totalPages} 页
        </span>
      </div>

      {/*
       * 表格与批量动作栏是**同一个**客户端元件：选中集与行必须在
       * 一个元件里，否则「全选」能写、行却改不了那份状态
       *（第一版就是这样，点了没反应且没有任何测试会红）。
       */}
      <ReviewQueue rows={list.data} />
      <div className="end-actions" style={{ marginTop: '18px', gap: '8px' }}>
        {meta.page <= 1 ? null : (
          <Link className="soft-btn" href={pageHref(meta.page - 1, status, minScore)}>
            上一页
          </Link>
        )}
        {meta.page >= meta.totalPages ? null : (
          <Link className="soft-btn" href={pageHref(meta.page + 1, status, minScore)}>
            下一页
          </Link>
        )}
      </div>
    </div>
  );
}

/** 保住筛选条件的翻页链接（丢了 status 就等于换了一个结果集）。 */
function pageHref(page: number, status?: string, minScore?: string): string {
  const params = new URLSearchParams({ page: String(page) });
  if (status !== undefined) params.set('status', status);
  if (minScore !== undefined) params.set('minScore', minScore);
  return `/admin/review?${params.toString()}`;
}
