/**
 * X 白名单（后台 `/admin/sources/x`）—— `docs/09` 的「X 白名单管理」。
 *
 * ── ⚠ 这不是用户订阅系统 ────────────────────────────────────────────
 * `docs/09` 的原文就是这么写的。这是**编辑维护的账号名单**：
 * 谁的内容值得被 Signal 采集。前台没有任何办法修改它（`docs/23`：
 * X 动态是「Signal 编辑维护的少量高质量账号白名单」）。
 *
 * 所以这一页的动作是运营动作（新增 handle、设 kind/tier/priority/间隔、
 * 启停、测试、立刻抓），而不是任何用户行为。
 *
 * ── 用的是**同一套** Source API ─────────────────────────────────────
 * `?type=X_USER` 过滤出来的就是 `/admin/sources` 的数据，
 * 只是多显示几列 X 专有的（handle、Quote/Reply 开关）。
 * 两套后端会立刻分叉：在那里停用的账号会继续在 X 动态里出现。
 */

import type { ReactElement } from 'react';
import Link from 'next/link';
import { AdminDenied, Badge, DataTable, EmptyRow, isoShort } from '../../../../components/admin-ui';
import { NewSourceForm, SourceRowActions } from '../../../../components/admin-source-actions';
import { PageHead } from '../../../../components/shell';
import type { OffsetPage } from '../../../../lib/api';
import { loadAdmin } from '../../../../lib/admin-fetch';
import type { SourceDto } from '../../../../lib/admin-types';
import { SourceType } from '@signal/contracts';

/** 从 `config` 里读 X 专有的开关（形状由 Agent 03 的 config schema 定义）。 */
function xConfigOf(source: SourceDto): { handle: string; quotes: boolean; replies: boolean } {
  const config = source.config ?? {};
  return {
    handle: typeof config['handle'] === 'string' ? config['handle'] : (source.externalId ?? '—'),
    quotes: config['includeQuotes'] === true,
    replies: config['includeReplies'] === true,
  };
}

export default async function AdminXWhitelistPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}): Promise<ReactElement> {
  const { page } = await searchParams;

  const result = await loadAdmin<OffsetPage<SourceDto>>('/admin/sources', {
    page,
    type: SourceType.X_USER,
  });
  if (!result.ok) return <AdminDenied status={result.status} />;
  const list = result.data;

  const enabledCount = list.data.filter((source) => source.enabled).length;

  return (
    <div className="container">
      <PageHead
        eyebrow="X whitelist"
        title="X 白名单"
        subtle={`${String(enabledCount)} / ${String(list.meta.total)} 个账号在启用中。前台只能看、翻译、收藏、跳去 X —— 没有关注。`}
        action={{ href: '/admin/sources', label: '全部来源' }}
      />

      <div className="admin-toolbar">
        <NewSourceForm defaultType={SourceType.X_USER} />
        <span className="spacer" />
        <span className="subtle">
          这里的账号就是前台的「X 动态」与「人物」——
          <Link className="text-link" href="/x">
            去前台看看
          </Link>
        </span>
      </div>

      <DataTable
        headers={['状态', '人物 / handle', '身份', 'Tier', '优先级', '间隔', 'Quote / Reply', '最近错误', '动作']}
      >
        {list.data.length === 0 ? (
          <EmptyRow span={9} text="白名单是空的 —— 前台的 X 动态会是空的。" />
        ) : (
          list.data.map((source) => {
            const x = xConfigOf(source);
            return (
              <tr key={source.id}>
                <td>{source.enabled ? <Badge>启用</Badge> : <Badge tone="warn">停用</Badge>}</td>
                <td>
                  {source.name}
                  <div className="subtle">@{x.handle}</div>
                </td>
                <td>
                  {source.kind}
                  {source.official ? <Badge>官方</Badge> : null}
                </td>
                <td>
                  <Badge tone={source.tier === 'S' || source.tier === 'A' ? 'warn' : undefined}>
                    {source.tier}
                  </Badge>
                </td>
                <td className="num">{source.priority}</td>
                <td className="num">{source.fetchIntervalSeconds}s</td>
                <td className="subtle">
                  {x.quotes ? '引文 ✓' : '引文 ✗'} / {x.replies ? '回复 ✓' : '回复 ✗'}
                </td>
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
            );
          })
        )}
      </DataTable>

      <p className="subtle" style={{ marginTop: '14px' }}>
        停用一个账号之后，它的内容会从 X 动态与人物页消失（可见性由 `source.enabled`
        决定，`docs/04`）。这里的调整不需要重新部署 —— 下一次请求就生效。
      </p>
    </div>
  );
}
