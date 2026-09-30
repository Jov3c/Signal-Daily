/**
 * 通知（后台 `/admin/notifications`）。
 *
 * ⚠ **这一页的接口是本次新补的**（`GET` + `POST .../read`）。数据由
 * Agent 07 的通知扫描写入 `admin_notifications`（高分候选 / 来源失败），
 * 而 `docs/04` 没有列出读取接口 —— 见 CCR-agent-12 第 1 项。
 *
 * ── `targetUrl` 是**后台内部路径** ──────────────────────────────────
 * 它不是外部链接：通知扫描写入的是 `/admin/review/<id>` 与
 * `/admin/sources/<id>`（跳转目标是**后台的处理页**，而不是原文）。
 * 所以点通知要跳到站内的审核页 —— 那正是「收到通知之后能立刻处理」的意思。
 *
 * ── 「标记已读」为什么是必须的 ──────────────────────────────────────
 * 表里有 `status` / `readAt` 两列，通知扫描也按 `(type, targetUrl)` 去重。
 * 如果界面只有一个未读徽标、没有任何清除动作，那个徽标就永远是红的 ——
 * 用户会开始忽略它，等于把通知功能关掉了。
 * ⚠ 这条 `POST .../read` **不在任务书里**，是本模块判断「不可用」而加的，
 * 已在 CCR 里单列请裁决。
 */

import type { ReactElement } from 'react';
import Link from 'next/link';
import { AdminDenied, Badge, DataTable, EmptyRow, isoShort } from '../../../components/admin-ui';
import { MarkReadButton } from '../../../components/admin-notification-actions';
import { PageHead } from '../../../components/shell';
import type { OffsetPage } from '../../../lib/api';
import { loadAdmin } from '../../../lib/admin-fetch';
import type { AdminNotification } from '../../../lib/admin-types';

/** 通知类型的可读名（后端用 `admin_notifications.type` 存字符串）。 */
const TYPE_LABELS: Record<string, string> = {
  HIGH_SCORE_CONTENT: '高分候选',
  SOURCE_FAILURE: '来源失败',
};

export default async function AdminNotificationsPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; status?: string }>;
}): Promise<ReactElement> {
  const { page, status } = await searchParams;

  const result = await loadAdmin<OffsetPage<AdminNotification>>('/admin/notifications', {
    page,
    status,
  });
  if (!result.ok) return <AdminDenied status={result.status} />;
  const list = result.data;

  const unread = list.data.filter((row) => row.status === 'UNREAD').length;

  return (
    <div className="container">
      <PageHead
        eyebrow="Notifications"
        title="通知"
        subtle={`本页 ${String(unread)} 条未读。通知扫描是幂等的 —— 同一件事只会通知一次。`}
        action={{ href: '/admin/review', label: '去审核队列' }}
      />

      <div className="admin-toolbar">
        <Link className={status === undefined ? 'tab active' : 'tab'} href="/admin/notifications">
          全部
        </Link>
        <Link
          className={status === 'UNREAD' ? 'tab active' : 'tab'}
          href="/admin/notifications?status=UNREAD"
        >
          未读
        </Link>
        <Link
          className={status === 'READ' ? 'tab active' : 'tab'}
          href="/admin/notifications?status=READ"
        >
          已读
        </Link>
        <span className="spacer" />
        <span className="subtle">
          第 {list.meta.page} / {list.meta.totalPages} 页
        </span>
      </div>

      <DataTable headers={['', '类型', '内容', '邮件', '时间', '动作']}>
        {list.data.length === 0 ? (
          <EmptyRow span={6} text="没有通知 —— 一切正常。" />
        ) : (
          list.data.map((row) => (
            <tr key={row.id}>
              <td>{row.status === 'UNREAD' ? <Badge tone="warn">未读</Badge> : <Badge>已读</Badge>}</td>
              <td>{TYPE_LABELS[row.type] ?? row.type}</td>
              <td>
                <strong>{row.title}</strong>
                <div className="subtle" style={{ marginTop: '4px' }}>
                  {row.body}
                </div>
                {row.targetUrl === null ? null : (
                  <Link className="text-link" href={row.targetUrl}>
                    去处理 →
                  </Link>
                )}
              </td>
              <td className="subtle">{row.emailStatus}</td>
              <td>
                {isoShort(row.createdAt)}
                {row.readAt === null ? null : (
                  <div className="subtle">读于 {isoShort(row.readAt)}</div>
                )}
              </td>
              <td>
                {row.status === 'UNREAD' ? (
                  <MarkReadButton notificationId={row.id} />
                ) : (
                  <span className="subtle">—</span>
                )}
              </td>
            </tr>
          ))
        )}
      </DataTable>

      <p className="subtle" style={{ marginTop: '14px' }}>
        通知**只在后台** —— 前台的用户不会收到任何通知（`docs/23`：没有订阅、
        没有关注，也就没有「你关注的人更新了」这类消息）。
        「邮件」那一列是通知本身的投递状态（发给管理员邮箱），不是发给用户。
      </p>
    </div>
  );
}
