'use client';

/**
 * 一期日报的状态机动作。
 *
 * ── ⚠ 只显示**当前状态允许**的动作 ──────────────────────────────────
 * 状态机是 `docs/10` 冻结的：
 *
 * ```text
 * DRAFT      → 排期（schedule）
 * REVIEWING  → 排期 / 取消
 * SCHEDULED  → 发布（publish）/ 取消
 * PUBLISHED  → （终态，只能人工改库）
 * CANCELLED  → 回到草稿（由 cancel 的后续处理，前端不提供）
 * ```
 *
 * 给一个 DRAFT 显示「发布」按钮是错的：后端会以 409/400 拒绝，
 * 而用户会以为是 bug。**「按钮看起来能用但其实不能」比「按钮不存在」更糟。**
 *
 * ── ⚠ preflight 的失败要显示出来 ────────────────────────────────────
 * 发布前有一道 preflight（Agent 08），它会检查「08:00 未审核不发布」之类的
 * 硬约束。所以 `publish` 的结果可能是**成功但带 issues** —— 那必须列出来，
 * 不能当成失败吞掉：审核员需要知道**是哪一条**没过。
 */

import { useState, type ReactElement } from 'react';
import { useRouter } from 'next/navigation';
import { DailyEditionStatus } from '@signal/contracts';
import { apiRequest, ApiClientError } from '../lib/client-api';
import { useToast } from './toast';

type PublishResult = {
  published?: boolean;
  reason?: string;
  editionNo?: number | null;
  issues?: { code?: string; message?: string }[];
};

/** 当前状态可用的动作（见文件头）。 */
function availableActions(status: DailyEditionStatus): { action: string; label: string }[] {
  switch (status) {
    case DailyEditionStatus.DRAFT:
    case DailyEditionStatus.REVIEWING:
      return [{ action: 'schedule', label: '排期' }];
    case DailyEditionStatus.SCHEDULED:
      return [
        { action: 'publish', label: '立即发布' },
        { action: 'cancel', label: '取消' },
      ];
    default:
      return [];
  }
}

export function EditionActions({
  businessDate,
  status,
}: {
  businessDate: string;
  status: DailyEditionStatus;
}): ReactElement {
  const [busy, setBusy] = useState(false);
  const [issues, setIssues] = useState<string[]>([]);
  const router = useRouter();
  const toast = useToast();

  const actions = availableActions(status);
  if (actions.length === 0) {
    return <span className="subtle">—</span>;
  }

  async function run(action: string): Promise<void> {
    if (busy) return;
    if (action === 'publish' && !window.confirm('现在就发布这一期吗？发布会立刻对前台可见。')) {
      return;
    }
    setBusy(true);
    setIssues([]);
    try {
      const body = await apiRequest<{ data: PublishResult }>(
        `/admin/daily/${businessDate}/${action}`,
        { method: 'POST' },
      );
      const result = body.data;
      // ⚠ 成功但带 issues —— 必须显示。吞掉它等于让「没发出去」看起来像成功。
      if (result.published === false) {
        setIssues(
          (result.issues ?? []).map((issue) =>
            issue.code === undefined ? (issue.message ?? '未知问题') : `${issue.code}：${issue.message ?? ''}`,
          ),
        );
        toast.show(`没有发布：${result.reason ?? 'preflight 未通过'}`);
      } else {
        toast.show(action === 'publish' ? '已发布' : '已排期');
      }
      router.refresh();
    } catch (error) {
      toast.show(
        error instanceof ApiClientError ? `操作失败（${error.code}）` : '操作失败',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="row-actions">
        {actions.map((item) => (
          <button
            key={item.action}
            type="button"
            className={item.action === 'publish' ? 'primary-btn' : 'quiet-action'}
            disabled={busy}
            onClick={() => void run(item.action)}
          >
            {item.label}
          </button>
        ))}
      </div>
      {issues.length === 0 ? null : (
        <ul className="subtle" style={{ margin: '6px 0 0', paddingLeft: '16px' }}>
          {issues.map((issue) => (
            <li key={issue}>{issue}</li>
          ))}
        </ul>
      )}
    </>
  );
}
