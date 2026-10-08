'use client';

/**
 * 审核详情的**动作区**与**证据链编辑**。
 *
 * ── 单条有五个动作、批量只有两个 ────────────────────────────────────
 * `docs/09` 的五个审核动作由 `POST /admin/review/:contentId/decision`
 * 承载（`action` 字段区分）：Approve Featured / Approve Daily / Both /
 * Defer / Reject。这三个「通过」类动作**只能逐条做**。
 *
 * ⚠ 动作名是 `DEFER` / `REJECT`，而**结果状态**是 `DEFERRED` / `REJECTED`。
 * 两者长得很像，把后者当动作发出去后端会 400 —— 所以这里从常量取，
 * 不手写字符串。
 *
 * ── 证据链：`docs/09` 的四个人工操作 ────────────────────────────────
 * ```text
 * 增加一个 Evidence URL    → POST   /admin/events/:eventId/evidence
 * 修改 Evidence type       → PATCH  /admin/events/:eventId/evidence/:evidenceId
 * 设置 Primary             → POST   .../set-primary
 * 删除错误 Evidence        → DELETE .../evidence/:evidenceId
 * ```
 *
 * ⚠ 这四条都是**需 Origin 校验的变更**（`AdminOriginGuard`）。浏览器从
 * 同域发出请求会自动带 `Origin`，所以正常用没问题；但如果哪天有人把这个
 * 后台部署到另一个域上，这四条会一起 403 —— 那是设计如此（`docs/14`），
 * 不是 bug。
 *
 * ⚠ 人工证据**必须**保留 URL 与操作者审计（`docs/09`）。所以那个
 * 「增加证据」表单里 URL 是必填，而且不做「没有 URL 也能加」的捷径。
 */

import { useState, type ReactElement } from 'react';
import { useRouter } from 'next/navigation';
import { EvidenceType } from '@signal/contracts';
import { REVIEW_DECISIONS } from '../lib/review-actions';
import { apiRequest, ApiClientError } from '../lib/client-api';
import { useToast } from './toast';
import type { AdminEvidence } from '../lib/admin-types';

export function DecisionPanel({
  contentId,
  currentStatus,
}: {
  contentId: string;
  currentStatus: string;
}): ReactElement {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const router = useRouter();
  const toast = useToast();

  async function decide(action: string, label: string): Promise<void> {
    if (busy) return;
    // 拒绝是破坏性的（内容立刻从前台消失），所以要求一个理由。
    // 通过不需要 —— 那是默认动作，加一道拦截只会让人乱填。
    if (action === 'REJECT' && note.trim() === '') {
      toast.show('拒绝前请写一句理由');
      return;
    }
    setBusy(true);
    try {
      await apiRequest(`/admin/review/${contentId}/decision`, {
        method: 'POST',
        body: { action, ...(note.trim() === '' ? {} : { note: note.trim() }) },
      });
      toast.show(`已${label}`);
      setNote('');
      router.refresh();
    } catch (error) {
      toast.show(
        error instanceof ApiClientError && error.isUnauthorized ? '请重新登录' : '操作失败',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="detail-block">
      <h2>审核动作</h2>
      <p className="subtle">当前状态：{currentStatus}</p>
      <label className="field">
        <span>备注（拒绝时必填）</span>
        <textarea
          value={note}
          onChange={(event) => setNote(event.target.value)}
          placeholder="为什么拒绝 / 为什么搁置 —— 会给下一个看到这条的人看。"
        />
      </label>
      <div className="row-actions">
        {REVIEW_DECISIONS.map((item) => (
          <button
            key={item.action}
            type="button"
            className={item.action.startsWith('APPROVE') ? 'primary-btn' : 'soft-btn'}
            disabled={busy}
            onClick={() => void decide(item.action, item.label)}
          >
            {item.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/** 证据链的人工纠正。 */
export function EvidenceEditor({
  eventId,
  evidences,
}: {
  eventId: string;
  evidences: AdminEvidence[];
}): ReactElement {
  const [url, setUrl] = useState('');
  const [title, setTitle] = useState('');
  const [evidenceType, setEvidenceType] = useState<string>(EvidenceType.SUPPORTING_SOURCE);
  const [busy, setBusy] = useState(false);
  const router = useRouter();
  const toast = useToast();

  async function call(
    path: string,
    method: 'POST' | 'PATCH' | 'DELETE',
    body?: unknown,
  ): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      await apiRequest(path, { method, ...(body === undefined ? {} : { body }) });
      toast.show('已保存');
      router.refresh();
    } catch (error) {
      toast.show(
        error instanceof ApiClientError && error.isUnauthorized ? '请重新登录' : '操作失败',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="detail-block">
      <h2>证据链（人工纠正）</h2>
      <p className="subtle">
        人工证据会保留 URL 与操作者审计。**不能伪造 Source** —— 这里只能改证据， 不能新增一个来源。
      </p>

      {evidences.length === 0 ? (
        <p className="subtle">这个事件还没有证据。</p>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>类型</th>
                <th>标题 / URL</th>
                <th>来源</th>
                <th>指纹</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {evidences.map((item) => (
                <tr key={item.evidenceId}>
                  <td>
                    <select
                      className="choice"
                      value={item.evidenceType}
                      disabled={busy}
                      onChange={(event) =>
                        void call(`/admin/events/${eventId}/evidence/${item.evidenceId}`, 'PATCH', {
                          evidenceType: event.target.value,
                        })
                      }
                    >
                      {Object.values(EvidenceType).map((type) => (
                        <option key={type} value={type}>
                          {type}
                        </option>
                      ))}
                    </select>
                    {item.isPrimary ? <span className="badge warn">PRIMARY</span> : null}
                  </td>
                  <td>
                    <a href={item.url} target="_blank" rel="noreferrer noopener">
                      {item.title ?? item.url}
                    </a>
                  </td>
                  <td>
                    {item.source === null ? (
                      <span className="subtle">（无来源）</span>
                    ) : (
                      <>
                        {item.source.name}
                        <div className="subtle">
                          {item.source.tier}
                          {item.source.official ? ' · 官方' : ''}
                        </div>
                      </>
                    )}
                  </td>
                  {/*
                    ⚠ `urlHash` 可以为空 —— 2026-10-08 修。原来直接 `.slice(0, 10)`，
                    只要有一条证据没带这个字段，**整页崩到错误边界**。
                    （改了 `?` 与 `?? ''`：没有指纹时显示「—」而不是让页面挂掉。）
                  */}
                  <td className="subtle">
                    {item.urlHash == null ? '—' : `${item.urlHash.slice(0, 10)}…`}
                  </td>
                  <td>
                    <div className="row-actions">
                      {item.isPrimary ? null : (
                        <button
                          type="button"
                          className="quiet-action"
                          disabled={busy}
                          onClick={() =>
                            void call(
                              `/admin/events/${eventId}/evidence/${item.evidenceId}/set-primary`,
                              'POST',
                            )
                          }
                        >
                          设为主证据
                        </button>
                      )}
                      <button
                        type="button"
                        className="quiet-action"
                        disabled={busy}
                        onClick={() =>
                          void call(
                            `/admin/events/${eventId}/evidence/${item.evidenceId}`,
                            'DELETE',
                          )
                        }
                      >
                        删除
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2 style={{ marginTop: '18px' }}>增加一条证据</h2>
      <label className="field">
        <span>URL（必填 —— 人工证据必须可追溯）</span>
        <input
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          placeholder="https://…"
        />
      </label>
      <label className="field">
        <span>标题（可选）</span>
        <input value={title} onChange={(event) => setTitle(event.target.value)} />
      </label>
      <label className="field">
        <span>证据类型</span>
        <select value={evidenceType} onChange={(event) => setEvidenceType(event.target.value)}>
          {Object.values(EvidenceType).map((type) => (
            <option key={type} value={type}>
              {type}
            </option>
          ))}
        </select>
      </label>
      <div className="row-actions">
        <button
          type="button"
          className="primary-btn"
          disabled={busy || url.trim() === ''}
          onClick={() => {
            void call(`/admin/events/${eventId}/evidence`, 'POST', {
              evidenceType,
              url: url.trim(),
              ...(title.trim() === '' ? {} : { title: title.trim() }),
            }).then(() => {
              setUrl('');
              setTitle('');
            });
          }}
        >
          增加
        </button>
        <span className="subtle">人工证据会记入审计日志，操作者是你当前的账号。</span>
      </div>
    </div>
  );
}
