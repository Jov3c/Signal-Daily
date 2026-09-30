'use client';

/**
 * 审核队列的**表格 + 批量动作**。
 *
 * ── 为什么整张表是一个客户端元件 ────────────────────────────────────
 * 第一版把「批量动作栏」与「表格」拆成两个元件：动作栏是客户端的
 *（要管选中集），表格是服务端渲染的。结果**行里根本没有勾选框** ——
 * 选中集只被「全选本页」按钮写，永远不会被行写。那是一个「能编译、
 * 能渲染、点了没反应」的错位，而且没有任何测试会发现。
 *
 * 选中集与行**必须在同一个元件里**。所以这里接收可序列化的 `rows`
 *（服务端取好传下来），自己渲染表头、行、勾选框与动作栏。
 */

import { useState, type ReactElement } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { EditorialReviewStatus, SourceTier } from '@signal/contracts';
import { BULK_REVIEW_ACTIONS } from '../lib/review-actions';
import { apiRequest, ApiClientError } from '../lib/client-api';
import { Badge, DataTable, EmptyRow, isoShort } from './admin-ui';
import { useToast } from './toast';

export type QueueRow = {
  contentId: string;
  title: string;
  summary: string | null;
  finalScore: number | null;
  publishedAt: string | null;
  source: { name: string; type: string; tier: SourceTier; official: boolean };
  review: { status: EditorialReviewStatus };
};

export function ReviewQueue({ rows }: { rows: QueueRow[] }): ReactElement {
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const router = useRouter();
  const toast = useToast();

  const allSelected = rows.length > 0 && selected.size === rows.length;

  function toggle(contentId: string): void {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(contentId)) next.delete(contentId);
      else next.add(contentId);
      return next;
    });
  }

  async function run(action: string, label: string): Promise<void> {
    if (busy || selected.size === 0) return;
    setBusy(true);
    try {
      await apiRequest('/admin/review/bulk', {
        method: 'POST',
        body: { contentIds: [...selected], action },
      });
      toast.show(`已${label} ${String(selected.size)} 条`);
      setSelected(new Set());
      router.refresh();
    } catch (error) {
      toast.show(
        error instanceof ApiClientError && error.isUnauthorized
          ? '登录已过期，请重新登录'
          : '批量操作失败',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="admin-toolbar">
        <button
          type="button"
          className="soft-btn"
          disabled={rows.length === 0}
          onClick={() => setSelected(allSelected ? new Set() : new Set(rows.map((r) => r.contentId)))}
        >
          {allSelected ? '取消全选' : '全选本页'}
        </button>
        <span className="subtle">已选 {selected.size} 条</span>
        <span className="spacer" />
        {BULK_REVIEW_ACTIONS.map((action) => (
          <button
            key={action}
            type="button"
            className="soft-btn"
            disabled={busy || selected.size === 0}
            onClick={() => void run(action, action === 'REJECT' ? '拒绝' : '搁置')}
          >
            {action === 'REJECT' ? '拒绝' : '搁置'}
          </button>
        ))}
        <span className="subtle">批量只有这两个动作 —— 通过必须逐条看</span>
      </div>

      <DataTable headers={['', '分数', '标题', '来源', 'Tier', '状态', '发布时间', '']}>
        {rows.length === 0 ? (
          <EmptyRow span={8} text="没有待审内容 —— 队列是空的。" />
        ) : (
          rows.map((row) => (
            <tr key={row.contentId}>
              <td>
                <input
                  type="checkbox"
                  checked={selected.has(row.contentId)}
                  onChange={() => toggle(row.contentId)}
                  aria-label={`选择 ${row.title}`}
                />
              </td>
              <td className="num">{row.finalScore ?? '—'}</td>
              <td>
                <Link className="text-link" href={`/admin/review/${row.contentId}`}>
                  {row.title}
                </Link>
                {row.summary === null ? null : (
                  <div className="subtle" style={{ marginTop: '4px' }}>
                    {row.summary.length > 90 ? `${row.summary.slice(0, 90)}…` : row.summary}
                  </div>
                )}
              </td>
              <td>
                {row.source.name}
                <div className="subtle">{row.source.type}</div>
              </td>
              <td>
                <Badge
                  tone={
                    row.source.tier === SourceTier.S || row.source.tier === SourceTier.A
                      ? 'warn'
                      : undefined
                  }
                >
                  {row.source.tier}
                </Badge>
                {row.source.official ? <Badge>官方</Badge> : null}
              </td>
              <td>
                <Badge tone={row.review.status === EditorialReviewStatus.PENDING ? 'warn' : undefined}>
                  {row.review.status}
                </Badge>
              </td>
              <td>{isoShort(row.publishedAt)}</td>
              <td>
                <Link className="soft-btn" href={`/admin/review/${row.contentId}`}>
                  审核
                </Link>
              </td>
            </tr>
          ))
        )}
      </DataTable>
    </>
  );
}
