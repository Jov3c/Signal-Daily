'use client';

/**
 * Source 的行内动作与新建表单。
 *
 * `docs/04` 的 Admin Source Registry 八条路由里，这一页用到六条：
 *
 * ```text
 * POST   /admin/sources              新增
 * PATCH  /admin/sources/:id          编辑
 * POST   /admin/sources/:id/enable   启用
 * POST   /admin/sources/:id/disable  停用
 * POST   /admin/sources/:id/test     测试（不发真实抓取）
 * POST   /admin/sources/:id/fetch-now 立刻抓一次
 * ```
 *
 * ── ⚠ `test` 与 `fetch-now` 的区别要说清楚 ──────────────────────────
 * `test` 只验证**可达性与解析**（拿回样本、不写库），`fetch-now` 会
 * **真的入队一次采集**（写 raw_items、走完整条管线）。把这两件事
 * 混成一个按钮，会让人在做「只是想看看这个源通不通」的时候
 * 往生产库里灌一批数据。
 *
 * 所以两个按钮的文案与提示都分开写，`fetch-now` 还要求一次确认
 *（它是这页唯一有**写入副作用**的动作）。
 *
 * ── ⚠ `fetch-now` 依赖 Redis ────────────────────────────────────────
 * 它要入队，而 Redis 是硬依赖（fail-closed）。Redis 挂了会返回
 * `SOURCE_ENQUEUE_FAILED`（503）—— 那是**如实报告**，不是静默成功
 *（Agent 03 的 HANDOFF 点名过这条）。所以这里的错误提示按业务码分支。
 */

import { useState, type ReactElement } from 'react';
import { useRouter } from 'next/navigation';
import { SourceKind, SourceTier, SourceType } from '@signal/contracts';
import { apiRequest, ApiClientError } from '../lib/client-api';
import { useToast } from './toast';

/** 把失败翻成一句能行动的话。 */
function messageOf(error: unknown): string {
  if (!(error instanceof ApiClientError)) return '操作失败';
  switch (error.code) {
    case 'SOURCE_ENQUEUE_FAILED':
      return '入队失败：Redis 不可用（fetch-now 依赖队列）';
    case 'SOURCE_URL_UNSAFE':
      return 'URL 被 SSRF 防护拒绝';
    case 'VALIDATION_FAILED':
      return '字段没通过校验，检查带 * 的项';
    default:
      return error.isUnauthorized ? '请重新登录' : `操作失败（${error.code}）`;
  }
}

export function SourceRowActions({
  sourceId,
  enabled,
}: {
  sourceId: string;
  enabled: boolean;
}): ReactElement {
  const [busy, setBusy] = useState(false);
  const router = useRouter();
  const toast = useToast();

  async function call(path: string, method: 'POST' | 'PATCH' = 'POST', body?: unknown): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      await apiRequest(path, { method, ...(body === undefined ? {} : { body }) });
      router.refresh();
    } catch (error) {
      toast.show(messageOf(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="row-actions">
      <button
        type="button"
        className="quiet-action"
        disabled={busy}
        title="只验证可达性与解析，不写库、不入队"
        onClick={() => void call(`/admin/sources/${sourceId}/test`)}
      >
        测试
      </button>
      <button
        type="button"
        className="quiet-action"
        disabled={busy}
        title="真的入队一次采集（会写库）"
        onClick={() => {
          // 这是本页唯一有写入副作用的动作 —— 给一次确认。
          if (window.confirm('真的立刻抓一次吗？这会入队、写 raw_items 并走完整条管线。')) {
            void call(`/admin/sources/${sourceId}/fetch-now`);
          }
        }}
      >
        立刻抓
      </button>
      <button
        type="button"
        className="quiet-action"
        disabled={busy}
        onClick={() =>
          void call(`/admin/sources/${sourceId}/${enabled ? 'disable' : 'enable'}`)
        }
      >
        {enabled ? '停用' : '启用'}
      </button>
    </div>
  );
}

/** 新建来源。X 账号用它（`externalId` 填 handle）。 */
export function NewSourceForm({
  defaultType,
}: {
  defaultType: SourceType;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({
    name: '',
    slug: '',
    type: defaultType,
    kind: SourceKind.MEDIA,
    tier: SourceTier.B,
    official: false,
    url: '',
    externalId: '',
    priority: 50,
    fetchIntervalSeconds: 900,
  });
  const router = useRouter();
  const toast = useToast();

  const isX = form.type === SourceType.X_USER;

  async function submit(): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      await apiRequest('/admin/sources', {
        method: 'POST',
        body: {
          name: form.name.trim(),
          slug: form.slug.trim(),
          type: form.type,
          kind: form.kind,
          tier: form.tier,
          official: form.official,
          priority: Number(form.priority),
          fetchIntervalSeconds: Number(form.fetchIntervalSeconds),
          // X 账号用 `externalId`（handle）而不是 URL；
          // RSS 用 `feedUrl`。两者的形状由后端 config schema 校验。
          ...(isX
            ? {
                externalId: form.externalId.trim(),
                config: { handle: form.externalId.trim(), includeQuotes: true, includeReplies: false },
              }
            : { feedUrl: form.url.trim() }),
        },
      });
      toast.show('已新增');
      setOpen(false);
      router.refresh();
    } catch (error) {
      toast.show(messageOf(error));
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button type="button" className="primary-btn" onClick={() => setOpen(true)}>
        新增{isX ? ' X 账号' : '来源'}
      </button>
    );
  }

  return (
    <section className="detail-block" style={{ width: '100%' }}>
      <h2>新增{isX ? ' X 账号' : '来源'}</h2>
      <div style={{ display: 'grid', gap: '10px', gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))' }}>
        <label className="field">
          <span>名称 *</span>
          <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </label>
        <label className="field">
          <span>slug *（稳定标识，不要改）</span>
          <input
            value={form.slug}
            placeholder={isX ? 'x-karpathy' : 'openai-blog'}
            onChange={(e) => setForm({ ...form, slug: e.target.value })}
          />
        </label>
        <label className="field">
          <span>类型</span>
          <select
            value={form.type}
            onChange={(e) => setForm({ ...form, type: e.target.value as SourceType })}
          >
            {Object.values(SourceType).map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>身份（kind）</span>
          <select
            value={form.kind}
            onChange={(e) => setForm({ ...form, kind: e.target.value as SourceKind })}
          >
            {Object.values(SourceKind).map((kind) => (
              <option key={kind} value={kind}>
                {kind}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>等级（tier）</span>
          <select
            value={form.tier}
            onChange={(e) => setForm({ ...form, tier: e.target.value as SourceTier })}
          >
            {Object.values(SourceTier).map((tier) => (
              <option key={tier} value={tier}>
                {tier}
              </option>
            ))}
          </select>
        </label>
        {isX ? (
          <label className="field">
            <span>X handle *（不带 @）</span>
            <input
              value={form.externalId}
              onChange={(e) => setForm({ ...form, externalId: e.target.value.replace(/^@/, '') })}
            />
          </label>
        ) : (
          <label className="field">
            <span>Feed URL *</span>
            <input value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} />
          </label>
        )}
        <label className="field">
          <span>优先级（越大越先）</span>
          <input
            type="number"
            value={form.priority}
            onChange={(e) => setForm({ ...form, priority: Number(e.target.value) })}
          />
        </label>
        <label className="field">
          <span>抓取间隔（秒）</span>
          <input
            type="number"
            value={form.fetchIntervalSeconds}
            onChange={(e) => setForm({ ...form, fetchIntervalSeconds: Number(e.target.value) })}
          />
        </label>
        <label className="field">
          <span>官方来源</span>
          <select
            value={form.official ? 'yes' : 'no'}
            onChange={(e) => setForm({ ...form, official: e.target.value === 'yes' })}
          >
            <option value="no">否</option>
            <option value="yes">是（官方一手）</option>
          </select>
        </label>
      </div>
      <div className="row-actions">
        <button type="button" className="primary-btn" disabled={busy} onClick={() => void submit()}>
          保存
        </button>
        <button type="button" className="soft-btn" onClick={() => setOpen(false)}>
          取消
        </button>
        <span className="subtle">
          * 私有地址会被 SSRF 防护拒绝；X 账号走 handle 而不是 URL。
        </span>
      </div>
    </section>
  );
}
