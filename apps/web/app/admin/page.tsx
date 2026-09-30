/**
 * 后台首页（Dashboard）—— `docs/09` 的「Dashboard 一节」。
 *
 * 展示：今日抓取、高分候选、待审核、失败 Source、Queue、AI 成本、日报状态。
 *
 * ⚠ **Queue 那一项不在这个响应里**。`DashboardStats` 有
 * `todayFetched / highScorePending / pendingReview / failingSources /
 * aiCostTodayUsd / latestDailyEdition` 六项，没有队列积压数
 *（队列在 Redis 里，api 侧的 dashboard 查询不碰它）。
 * 所以这里**不编**一个「队列 0」出来 —— 那会让人以为队列是空的。
 * 想看作业情况去 `/admin/jobs`，那一页读的是真实的 `job_runs`。
 *
 * ⚠ `GET /admin/dashboard` 有一条**读操作带副作用**的设计（Agent 07 记过）：
 * 它会顺带跑一次幂等的通知扫描。所以打开后台首页会刷新通知 —— 那是刻意的，
 * 让本地开发不必再起一个定时器。
 */

import type { ReactElement } from 'react';
import Link from 'next/link';
import { AdminDenied, Badge, StatCard, isoShort, usd } from '../../components/admin-ui';
import { EmptyState, PageHead } from '../../components/shell';
import { loadAdminSingle } from '../../lib/admin-fetch';
import type { DashboardStats } from '../../lib/admin-types';
import { DailyEditionStatus } from '@signal/contracts';

export default async function AdminDashboardPage(): Promise<ReactElement> {
  const result = await loadAdminSingle<DashboardStats>('/admin/dashboard');
  if (!result.ok) return <AdminDenied status={result.status} />;
  const stats = result.data;

  return (
    <div className="container">
      <PageHead
        eyebrow="Dashboard"
        title="Dashboard"
        subtle="今天的采集、审核与发布状态。"
        action={{ href: '/admin/review', label: '去审核队列' }}
      />

      <section className="stat-grid">
        <StatCard label="今日抓取" value={stats.todayFetched} hint="原始条目数" />
        <StatCard
          label="高分候选"
          value={stats.highScorePending}
          hint="finalScore ≥ 85 且未审核"
          href="/admin/review?minScore=85"
        />
        <StatCard
          label="待审核"
          value={stats.pendingReview}
          hint="队列长度"
          href="/admin/review"
        />
        <StatCard
          label="AI 成本（今日）"
          value={usd(stats.aiCostTodayUsd)}
          hint="按上海业务日"
          href="/admin/ai-usage"
        />
        <StatCard
          label="失败的 Source"
          value={stats.failingSources.length}
          hint="last_error_code 非空"
          href="/admin/sources"
        />
      </section>

      <section className="detail-block">
        <h2>日报状态</h2>
        {stats.latestDailyEdition === null ? (
          <p className="subtle">还没有任何一期日报。</p>
        ) : (
          <dl className="kv">
            <dt>业务日</dt>
            <dd>{stats.latestDailyEdition.businessDate}</dd>
            <dt>状态</dt>
            <dd>
              <Badge
                tone={
                  stats.latestDailyEdition.status === DailyEditionStatus.PUBLISHED ? undefined : 'warn'
                }
              >
                {stats.latestDailyEdition.status}
              </Badge>{' '}
              {stats.latestDailyEdition.status === DailyEditionStatus.DRAFT
                ? '（未发布 —— 前台看不见）'
                : ''}
            </dd>
            <dt>操作</dt>
            <dd>
              <Link className="text-link" href={`/admin/daily/${stats.latestDailyEdition.businessDate}`}>
                去编排这一期 →
              </Link>
            </dd>
          </dl>
        )}
      </section>

      <section className="detail-block">
        <h2>需要看一眼的 Source</h2>
        {stats.failingSources.length === 0 ? (
          <EmptyState title="没有失败的来源" hint="所有来源最近一次抓取都没有报错。" />
        ) : (
          <dl className="kv">
            {stats.failingSources.map((source) => (
              <div key={source.id} style={{ display: 'contents' }}>
                <dt>
                  <Link className="text-link" href={`/admin/sources/${source.id}`}>
                    {source.name}
                  </Link>
                </dt>
                <dd>
                  <Badge tone="warn">{source.lastErrorCode}</Badge> {isoShort(source.lastErrorAt)}
                </dd>
              </div>
            ))}
          </dl>
        )}
      </section>

      <p className="subtle">
        队列积压不在这一页 —— 它需要读 Redis，而后台首页的查询不碰它。
        去 <Link className="text-link" href="/admin/jobs">Jobs</Link> 看作业运行历史。
      </p>
    </div>
  );
}
