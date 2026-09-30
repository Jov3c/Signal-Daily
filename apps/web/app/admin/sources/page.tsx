/**
 * Source 管理（后台 `/admin/sources`）—— `docs/04` 的 Admin Source Registry。
 *
 * ── ⚠ X 白名单**不是第二套后端** ────────────────────────────────────
 * `tasks/agent-12-admin-ui.md` 明确要求：「使用 Source API，不创建第二套
 * X account backend」。所以 X 账号就是 `type = X_USER` 的 Source，
 * `/admin/sources/x` 只是**同一份数据的过滤视图**（多几列 X 专有字段）。
 * 两条路由、一个数据源 —— 不会出现「在这里改了、那边没变」。
 *
 * ── 列的选择依据 ────────────────────────────────────────────────────
 * 第一列是**运维会看的**（状态与最近错误），中间是身份，右侧是节奏与动作。
 * 「最近错误」比「最近成功」重要：一个安静的来源不需要人管，
 * 一个报错的来源需要。
 */

import type { ReactElement } from 'react';
import Link from 'next/link';
import { AdminDenied, Badge, DataTable, EmptyRow, isoShort } from '../../../components/admin-ui';
import { NewSourceForm, SourceRowActions } from '../../../components/admin-source-actions';
import { PageHead } from '../../../components/shell';
import { ApiRequestError, serverFetch } from '../../../lib/api';
import type { SourceDto } from '../../../lib/admin-types';
import { SourceTier, SourceType } from '@signal/contracts';

type ListResponse = {
  data: SourceDto[];
  meta: { page: number; pageSize: number; total: number; totalPages: number };
};

export default async function AdminSourcesPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; type?: string }>;
}): Promise<ReactElement> {
  const { page, type } = await searchParams;

  let list: ListResponse;
  try {
    list = await serverFetch<ListResponse>('/admin/sources', { query: { page, type } });
  } catch (error) {
    if (error instanceof ApiRequestError && (error.status === 401 || error.status === 403)) {
      return <AdminDenied status={error.status} />;
    }
    throw error;
  }

  return (
    <div className="container">
      <PageHead
        eyebrow="Sources"
        title="Source 管理"
        subtle={`${String(list.meta.total)} 个来源。X 账号也在这里 —— 它不是第二套后端。`}
        action={{ href: '/admin/sources/x', label: '只看 X 白名单' }}
      />

      <div className="admin-toolbar">
        <NewSourceForm defaultType={SourceType.RSS} />
        <span className="spacer" />
        <Link className={type === undefined ? 'tab active' : 'tab'} href="/admin/sources">
          全部
        </Link>
        <Link
          className={type === SourceType.RSS ? 'tab active' : 'tab'}
          href={`/admin/sources?type=${SourceType.RSS}`}
        >
          RSS
        </Link>
        <Link
          className={type === SourceType.X_USER ? 'tab active' : 'tab'}
          href={`/admin/sources?type=${SourceType.X_USER}`}
        >
          X 账号
        </Link>
      </div>

      <DataTable
        headers={['状态', '名称', '类型 / 身份', 'Tier', '优先级', '间隔', '最近抓取', '最近错误', '动作']}
      >
        {list.data.length === 0 ? (
          <EmptyRow span={9} text="还没有来源。用上面的按钮新增一个。" />
        ) : (
          list.data.map((source) => (
            <tr key={source.id}>
              <td>
                {source.enabled ? <Badge>启用</Badge> : <Badge tone="warn">停用</Badge>}
              </td>
              <td>
                {source.name}
                <div className="subtle">
                  {source.slug}
                  {source.official ? ' · 官方' : ''}
                </div>
              </td>
              <td>
                {source.type}
                <div className="subtle">{source.kind}</div>
              </td>
              <td>
                <Badge
                  tone={
                    source.tier === SourceTier.S || source.tier === SourceTier.A ? 'warn' : undefined
                  }
                >
                  {source.tier}
                </Badge>
              </td>
              <td className="num">{source.priority}</td>
              <td className="num">{source.fetchIntervalSeconds}s</td>
              <td>{isoShort(source.lastFetchedAt)}</td>
              <td>
                {source.lastErrorCode === null ? (
                  <span className="subtle">—</span>
                ) : (
                  <>
                    <Badge tone="warn">{source.lastErrorCode}</Badge>
                    <div className="subtle">{isoShort(source.lastErrorAt)}</div>
                  </>
                )}
              </td>
              <td>
                <SourceRowActions sourceId={source.id} enabled={source.enabled} />
              </td>
            </tr>
          ))
        )}
      </DataTable>

      <p className="subtle" style={{ marginTop: '14px' }}>
        「测试」只验证可达性与解析（不写库、不入队）；「立刻抓」会真的入队一次采集。
        抓取间隔与优先级决定调度顺序（`docs/06`）。
      </p>
    </div>
  );
}
