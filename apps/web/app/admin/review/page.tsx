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
import { AdminDenied, Pager, TabLink } from '../../../components/admin-ui';
import { ReviewQueue } from '../../../components/admin-review-queue';
import { PageHead } from '../../../components/shell';
import type { OffsetPage } from '../../../lib/api';
import { loadAdmin } from '../../../lib/admin-fetch';
import type { ReviewListRow } from '../../../lib/admin-types';
import { EditorialReviewStatus } from '@signal/contracts';

export default async function AdminReviewQueuePage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; status?: string; minScore?: string }>;
}): Promise<ReactElement> {
  const { page, status, minScore } = await searchParams;

  const result = await loadAdmin<OffsetPage<ReviewListRow>>('/admin/review', {
    page,
    status,
    minScore,
  });
  if (!result.ok) return <AdminDenied status={result.status} />;
  const list = result.data;

  const { meta } = list;

  return (
    <div className="container">
      <PageHead
        eyebrow="Review queue"
        title="审核队列"
        subtle={`${String(meta.total)} 条，按分数倒序（同分按发布时间）。`}
      />

      <div className="admin-toolbar">
        <TabLink href="/admin/review" active={status === undefined}>
          全部
        </TabLink>
        <TabLink
          href={`/admin/review?status=${EditorialReviewStatus.PENDING}`}
          active={status === EditorialReviewStatus.PENDING}
        >
          待审
        </TabLink>
        <TabLink
          href={`/admin/review?status=${EditorialReviewStatus.DEFERRED}`}
          active={status === EditorialReviewStatus.DEFERRED}
        >
          已搁置
        </TabLink>
        <TabLink href="/admin/review?minScore=85" active={minScore !== undefined}>
          只要高分
        </TabLink>
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
      <Pager
        page={meta.page}
        totalPages={meta.totalPages}
        hrefOf={(target) => pageHref(target, status, minScore)}
      />
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
