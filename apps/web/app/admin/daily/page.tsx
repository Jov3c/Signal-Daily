/**
 * 日报编排（后台 `/admin/daily`）—— `docs/10` 的编辑台入口。
 *
 * 一个月的期次列表 + 每一期的状态机动作。
 *
 * ── ⚠ 状态机不能再多也不能再少 ──────────────────────────────────────
 * `docs/10` / `docs/05` 的状态机是：
 *
 * ```text
 * DRAFT ──schedule──▶ SCHEDULED ──publish──▶ PUBLISHED
 *   ▲                     │
 *   └────── cancel ───────┘          REVIEWING 是 DRAFT 与 SCHEDULED 之间的中间态
 * ```
 *
 * 所以每一行**只显示当前状态允许的动作**。给一个 DRAFT 显示「发布」按钮
 * 是错的（后端会拒，而用户会以为是 bug）—— 比「按钮点了报错」更糟的是
 * 「按钮看起来能用」。
 *
 * ── ⚠ 未审核 08:00 不发布（`docs/17` 第 11 条）─────────────────────
 * 发布那条路有一道 preflight（Agent 08 的 `preflight.ts`）。所以
 * 「发布」按钮点了以后可能返回**带问题的结果**而不是成功 ——
 * 那必须显示出来，不能当成失败吞掉：审核员需要知道**是哪一条**没过。
 */

import type { ReactElement } from 'react';
import Link from 'next/link';
import { AdminDenied, Badge, DataTable, EmptyRow, isoShort } from '../../../components/admin-ui';
import { EditionActions } from '../../../components/admin-daily-actions';
import { PageHead } from '../../../components/shell';
import { loadAdmin } from '../../../lib/admin-fetch';
import type { AdminEditionRow } from '../../../lib/admin-types';
import { DailyEditionStatus } from '@signal/contracts';

type DailyListResponse = {
  data: AdminEditionRow[];
  meta: { from: string; to: string; total: number };
};

export default async function AdminDailyPage({
  searchParams,
}: {
  searchParams: Promise<{ year?: string; month?: string; status?: string }>;
}): Promise<ReactElement> {
  const { year, month, status } = await searchParams;

  const result = await loadAdmin<DailyListResponse>('/admin/daily', { year, month, status });
  if (!result.ok) return <AdminDenied status={result.status} />;
  const list = result.data;

  return (
    <div className="container">
      <PageHead
        eyebrow={`${list.meta.from} → ${list.meta.to}`}
        title="日报编排"
        subtle={`${String(list.meta.total)} 期。08:00 发布；未审核完不会发（docs/10）。`}
        action={{ href: '/admin/review', label: '去看审核队列' }}
      />

      <div className="admin-toolbar">
        {[
          { label: '全部', value: undefined },
          { label: '草稿', value: DailyEditionStatus.DRAFT },
          { label: '已排期', value: DailyEditionStatus.SCHEDULED },
          { label: '已发布', value: DailyEditionStatus.PUBLISHED },
        ].map((tab) => (
          <Link
            key={tab.label}
            className={status === tab.value ? 'tab active' : 'tab'}
            href={tab.value === undefined ? '/admin/daily' : `/admin/daily?status=${tab.value}`}
          >
            {tab.label}
          </Link>
        ))}
        <span className="spacer" />
        <span className="subtle">默认是上海业务时区的当月</span>
      </div>

      <DataTable headers={['业务日', '刊号', '状态', '头条', '条目', '排期', '发布', '动作']}>
        {list.data.length === 0 ? (
          <EmptyRow span={8} text="这个月还没有期次。" />
        ) : (
          list.data.map((row) => (
            <tr key={row.businessDate}>
              <td>{row.businessDate}</td>
              <td className="num">{row.editionNo ?? '—'}</td>
              <td>
                <Badge
                  tone={row.status === DailyEditionStatus.PUBLISHED ? undefined : 'warn'}
                >
                  {row.status}
                </Badge>
              </td>
              <td>{row.headline ?? <span className="subtle">—</span>}</td>
              <td className="num">{row.itemCount}</td>
              <td>{isoShort(row.scheduledAt)}</td>
              <td>{isoShort(row.publishedAt)}</td>
              <td>
                <EditionActions businessDate={row.businessDate} status={row.status} />
              </td>
            </tr>
          ))
        )}
      </DataTable>

      <p className="subtle" style={{ marginTop: '14px' }}>
        DRAFT 与 SCHEDULED 的期次**前台看不到**（`docs/17` 第 10 条）。
        排期只是标记，真正的发布由 worker 在 08:00 那一趟执行，并在发布前跑一次
        preflight —— 所以「排了期」不等于「一定会发」。
      </p>
    </div>
  );
}
