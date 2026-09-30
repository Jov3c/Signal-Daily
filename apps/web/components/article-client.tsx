'use client';

/**
 * 文章页的两个客户端元件：**正文（含译文切换 + 阅读进度）** 与 **证据面板**。
 *
 * ── 为什么正文与工具栏的译文开关是**同一个**元件 ────────────────────
 * 第一版把它们拆开，用 `document.getElementById()` 互相找 —— 那是原型的
 * 做法（`button.closest('.x-post')` 那一套），在 React 里等于用 DOM 查询
 * 穿透组件边界：包一层 div、改一个 id，开关就**静默失效**。
 * 所以这里让正文元件同时持有「开合状态」与「自己的 DOM 引用」，
 * 于是**一个 `getElementById` 都不需要**。
 *
 * ── 译文切换（`docs/00`：`bodyOriginal` 永远不被 `bodyTranslated` 覆盖）──
 * 两者都渲染在 DOM 里，用 `hidden` 切换，而不是替换内容 ——
 * 用户随时能切回原文对照，而且切换不产生网络请求。
 *
 * ── 阅读进度（`docs/11`：0–1，客户端节流更新，>= 0.95 视为完成）────
 * 三个实现要点：
 *
 * 1. **节流 5 秒 + 数值没变就不发**。滚动是最高频的事件，
 *    每帧一个请求会把 API 打爆。
 * 2. **只在登录时上报**。`PUT /reading-progress` 要认证，而未登录用户
 *    滚动时弹登录框显然不行 —— 静默跳过。
 * 3. **`pagehide` / `visibilitychange` 时补一次**。否则
 *    「读到一半关掉标签页」这一最常见的情况永远不会被记录。
 */

import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import type { EvidenceSummary } from '@signal/contracts';
import { apiRequest, saveReadingProgress } from '../lib/client-api';
import { useAuth } from './auth';
import { IconExternal } from './icons';
import type { PublicEvidence } from '../lib/types';

/** 上报间隔（毫秒）。 */
export const PROGRESS_THROTTLE_MS = 5000;
/** 达到即视为读完（`docs/11`）。 */
export const COMPLETED_THRESHOLD = 0.95;

/* ------------------------------------------------------------------ */
/* 正文                                                                */
/* ------------------------------------------------------------------ */

export function ArticleBody({
  contentId,
  original,
  translated,
  defaultShowTranslation,
}: {
  contentId: string;
  original: string;
  translated: string | null;
  /** 来自设置里的 `defaultTranslation`（登录用户的同步偏好）。 */
  defaultShowTranslation: boolean;
}): ReactElement {
  const [showTranslation, setShowTranslation] = useState(
    defaultShowTranslation && translated !== null,
  );
  const bodyRef = useRef<HTMLDivElement>(null);
  const { user } = useAuth();
  const lastSentAt = useRef(0);
  const lastSentValue = useRef(-1);

  const computeProgress = useCallback((): number => {
    const node = bodyRef.current;
    if (node === null) return 0;
    const start = node.getBoundingClientRect().top + window.scrollY;
    const end = start + node.offsetHeight - window.innerHeight * 0.5;
    if (end <= start) return 1;
    return Math.min(1, Math.max(0, (window.scrollY - start) / (end - start)));
  }, []);

  useEffect(() => {
    if (user === null) return;

    const send = (force: boolean): void => {
      const value = computeProgress();
      const now = Date.now();
      if (!force) {
        if (now - lastSentAt.current < PROGRESS_THROTTLE_MS) return;
        if (Math.abs(value - lastSentValue.current) < 0.01) return;
      }
      lastSentAt.current = now;
      lastSentValue.current = value;
      void saveReadingProgress(contentId, Number(value.toFixed(3))).catch(() => undefined);
    };

    const onScroll = (): void => send(false);
    const onHide = (): void => send(true);

    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('pagehide', onHide);
    document.addEventListener('visibilitychange', onHide);
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('pagehide', onHide);
      document.removeEventListener('visibilitychange', onHide);
    };
  }, [contentId, computeProgress, user]);

  return (
    <>
      <div className="article-toolbar">
        {translated === null ? null : (
          <button
            type="button"
            className="quiet-action"
            aria-pressed={showTranslation}
            onClick={() => setShowTranslation((current) => !current)}
          >
            {showTranslation ? '看原文' : '看中文翻译'}
          </button>
        )}
      </div>

      <div className="article-body" ref={bodyRef}>
        <div className="article-text" hidden={showTranslation}>
          {paragraphs(original)}
        </div>
        {translated === null ? null : (
          <div className="article-text" hidden={!showTranslation}>
            {paragraphs(translated)}
          </div>
        )}
      </div>
    </>
  );
}

/**
 * 纯文本 → 段落。
 *
 * 后端存的是**纯文本**（没有 HTML），所以不能 `dangerouslySetInnerHTML`
 * （那会把正文里的 `<script>` 变成真的脚本）。这里按空行切段并交给
 * React 转义 —— 用户/采集来的内容永远不进入 `innerHTML`。
 */
function paragraphs(text: string): ReactElement[] {
  return text
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter((block) => block !== '')
    .map((block, index) => <p key={`p-${String(index)}`}>{block}</p>);
}

/* ------------------------------------------------------------------ */
/* 证据面板                                                            */
/* ------------------------------------------------------------------ */

/**
 * 「来源 / 证据」入口 —— **轻量**（任务书：不得把后台完整 debug 信息搬给用户）。
 *
 * 只展示三层：独立来源数 / 一手与官方 / 证据清单（按需拉取）。
 *
 * ⚠ **不显示** `urlHash` / `confidence` / 采集器内部 id —— 那些是后台判断
 * 用的（`docs/14`）。这里连它们的类型都没有声明（见 `lib/types.ts`），
 * 所以「想显示也显示不出来」。
 *
 * 清单**按需**拉取：文章页是最高频的页面，为一个默认折叠的面板
 * 多打一次接口不划算。
 */
export function EvidencePanel({
  contentId,
  summary,
}: {
  contentId: string;
  summary: EvidenceSummary;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<PublicEvidence[] | null>(null);
  const [failed, setFailed] = useState(false);

  async function toggle(): Promise<void> {
    const next = !open;
    setOpen(next);
    if (!next || items !== null) return;
    try {
      // 泛型是**载荷**类型 —— 封套由 `apiRequest` 内部解开。
      const body = await apiRequest<{ evidence: PublicEvidence[] }>(
        `/contents/${contentId}/evidence`,
      );
      setItems(body.evidence);
    } catch {
      setFailed(true);
    }
  }

  return (
    <div className="detail-block">
      <h2>来源与证据</h2>
      <dl className="kv">
        <dt>独立来源</dt>
        <dd>{summary.independentSourceCount} 家</dd>
        <dt>一手来源</dt>
        <dd>{summary.primarySource === null ? '未标注' : summary.primarySource.name}</dd>
        <dt>官方确认</dt>
        <dd>{summary.hasOfficialConfirmation ? '有' : '暂无'}</dd>
      </dl>

      <div className="row-actions" style={{ marginTop: '12px' }}>
        <button type="button" className="soft-btn" onClick={() => void toggle()}>
          {open ? '收起证据' : '查看证据'}
        </button>
      </div>

      {!open ? null : failed ? (
        <p className="subtle">证据暂时取不到，稍后再试。</p>
      ) : items === null ? (
        <p className="subtle">读取中…</p>
      ) : items.length === 0 ? (
        <p className="subtle">这条内容还没有登记证据。</p>
      ) : (
        <ul className="evidence-list">
          {items.map((item) => (
            <li key={item.id}>
              <a href={item.url} target="_blank" rel="noreferrer noopener">
                {item.title ?? item.url} <IconExternal />
              </a>{' '}
              <span className="subtle">
                {item.source.name}
                {item.isPrimary ? ' · 一手' : ''}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
