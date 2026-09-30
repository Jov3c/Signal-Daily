/**
 * AI 用量与成本（后台 `/admin/ai-usage`）。
 *
 * ⚠ **这一页的接口是本次新补的**（`GET /admin/ai-usage`）。数据一直在
 * `ai_runs` 里（Agent 06 的 AI 作业写入），`docs/04` 没有读出口。
 * 见 CCR-agent-12 第 1 项。
 *
 * ── 三个刻意的呈现选择 ──────────────────────────────────────────────
 *
 * 1. **按业务日切窗口**（`Asia/Shanghai`），不是 UTC 日。所以「今天花了多少」
 *    在北京时间 07:30 已经算今天的 —— 与「日报在 08:00 发」是同一个日历。
 * 2. **失败数单独一列**。`SKIPPED` 与 `FAILED` 都算失败（`repositories` 里的
 *    判据），把它们混进「调用数」会让人以为花钱买了结果 ——
 *    而 `SKIPPED` 是「没花钱也没产出」，`FAILED` 是「花了钱没产出」。
 * 3. **图表是 CSS 条，不是图表库**。一张后台小图引入一个图表库，
 *    它的配色会脱离设计令牌（`--text-3` 这一档），而且这是唯一需要它的地方。
 */

import type { ReactElement } from 'react';
import Link from 'next/link';
import { AdminDenied, Badge, DataTable, EmptyRow, duration, isoShort, usd } from '../../../components/admin-ui';
import { PageHead } from '../../../components/shell';
import { loadAdminSingle } from '../../../lib/admin-fetch';
import type { AiUsageView } from '../../../lib/admin-types';

/** 可选的窗口长度（与后端 `AI_USAGE_MAX_DAYS = 30` 对齐）。 */
const WINDOWS = [7, 14, 30];

export default async function AdminAiUsagePage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string }>;
}): Promise<ReactElement> {
  const { days } = await searchParams;

  const result = await loadAdminSingle<AiUsageView>('/admin/ai-usage', { days });
  if (!result.ok) return <AdminDenied status={result.status} />;
  const view = result.data;

  // 条形图的宽度以窗口内最大值为基准。全为 0 时避免除零。
  const maxCost = Math.max(...view.daily.map((row) => row.estimatedCostUsd), 0.000001);

  return (
    <div className="container">
      <PageHead
        eyebrow={`${view.window.from} → ${view.window.to} · ${view.window.timezone}`}
        title="AI 用量与成本"
        subtle="按上海业务日统计。成本是估算值（`estimated_cost_usd`），不是账单。"
        action={{ href: '/admin/jobs', label: '看作业历史' }}
      />

      <div className="admin-toolbar">
        {WINDOWS.map((value) => (
          <Link
            key={value}
            className={view.window.days === value ? 'tab active' : 'tab'}
            href={`/admin/ai-usage?days=${String(value)}`}
          >
            最近 {value} 天
          </Link>
        ))}
        <span className="spacer" />
        <span className="subtle">窗口上限 30 天（每天一条聚合查询）</span>
      </div>

      <section className="stat-grid">
        <div className="stat-card">
          <div className="label">调用数</div>
          <div className="value">{view.totals.runs}</div>
          <div className="hint">失败 / 跳过 {view.totals.failedRuns}</div>
        </div>
        <div className="stat-card">
          <div className="label">估算成本</div>
          <div className="value">{usd(view.totals.estimatedCostUsd)}</div>
          <div className="hint">窗口内合计</div>
        </div>
        <div className="stat-card">
          <div className="label">输入 token</div>
          <div className="value">{view.totals.inputTokens.toLocaleString('en-US')}</div>
          <div className="hint">全 null 的列按 0 计</div>
        </div>
        <div className="stat-card">
          <div className="label">输出 token</div>
          <div className="value">{view.totals.outputTokens.toLocaleString('en-US')}</div>
        </div>
      </section>

      <section className="detail-block">
        <h2>每日成本</h2>
        {view.daily.length === 0 ? (
          <p className="subtle">窗口内没有调用。</p>
        ) : (
          <div>
            {view.daily.map((row) => (
              <div className="bar-row" key={row.businessDate}>
                <span className="subtle">{row.businessDate.slice(5)}</span>
                <span className="bar-track">
                  <span
                    className="bar-fill"
                    style={{ width: `${String((row.estimatedCostUsd / maxCost) * 100)}%` }}
                  />
                </span>
                <span className="bar-value">
                  {usd(row.estimatedCostUsd)}
                  {row.failedRuns === 0 ? null : (
                    <span className="subtle"> · {row.failedRuns} 失败</span>
                  )}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>

      <div className="review-layout">
        <section className="detail-block">
          <h2>按任务类型</h2>
          {view.byTaskType.length === 0 ? (
            <p className="subtle">无数据。</p>
          ) : (
            <DataTable headers={['任务', '调用', '失败', '输入', '输出', '成本']}>
              {view.byTaskType.map((row) => (
                <tr key={row.key}>
                  <td>{row.key}</td>
                  <td className="num">{row.runs}</td>
                  <td className="num">{row.failedRuns}</td>
                  <td className="num">{row.inputTokens.toLocaleString('en-US')}</td>
                  <td className="num">{row.outputTokens.toLocaleString('en-US')}</td>
                  <td className="num">{usd(row.estimatedCostUsd)}</td>
                </tr>
              ))}
            </DataTable>
          )}
        </section>

        <section className="detail-block">
          <h2>按模型</h2>
          {view.byModel.length === 0 ? (
            <p className="subtle">无数据。</p>
          ) : (
            <DataTable headers={['模型', '调用', '失败', '成本']}>
              {view.byModel.map((row) => (
                <tr key={row.key}>
                  <td style={{ overflowWrap: 'anywhere' }}>{row.key}</td>
                  <td className="num">{row.runs}</td>
                  <td className="num">{row.failedRuns}</td>
                  <td className="num">{usd(row.estimatedCostUsd)}</td>
                </tr>
              ))}
            </DataTable>
          )}
        </section>
      </div>

      <section className="detail-block">
        <h2>最近调用</h2>
        <DataTable headers={['时间', '任务', '模型', '状态', '耗时', '成本', '内容', '错误']}>
          {view.recent.length === 0 ? (
            <EmptyRow span={8} text="还没有调用记录。" />
          ) : (
            view.recent.map((row) => (
              <tr key={row.id}>
                <td>{isoShort(row.createdAt)}</td>
                <td>{row.taskType}</td>
                <td className="subtle">{row.model}</td>
                <td>
                  <Badge
                    tone={row.status === 'SUCCEEDED' ? undefined : 'warn'}
                  >
                    {row.status}
                  </Badge>
                </td>
                <td className="num">{duration(row.durationMs)}</td>
                <td className="num">
                  {row.estimatedCostUsd === null ? '—' : usd(row.estimatedCostUsd)}
                </td>
                <td className="subtle">{row.contentId ?? '—'}</td>
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
      </section>

      <p className="subtle">
        成本来自 `ai_runs.estimated_cost_usd`（`Decimal(12,6)`，在各 Provider 的
        价格表上估算）。**它不是账单** —— 真实账单看 Provider 后台。
        失败调用通常没有 token 与成本（三列全 `null`），这一页按 0 计而不是显示空。
      </p>
    </div>
  );
}
