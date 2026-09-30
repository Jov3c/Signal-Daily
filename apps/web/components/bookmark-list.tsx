'use client';

/**
 * 收藏列表 + 它的分类标签（原型的 `.tabs`）。
 *
 * ── 为什么过滤做成客户端 ────────────────────────────────────────────
 * `GET /bookmarks` 只按时间倒序返回，**没有 type 过滤参数**
 *（`docs/04` 的 User 段只有那一条列表接口）。原型的四个标签
 *（全部 / 文章 / X / 日报）在真实数据上只能过滤**已经取回的这一页**。
 *
 * 那就如实标注成「本页」，而不是假装它是全量筛选 ——
 * 后者会让用户以为「收藏里只有 3 篇文章」，而其实只是这一页里只有 3 篇。
 * 已记入 `CONTRACT_CHANGE_REQUEST-agent-13.md`。
 *
 * 服务端已经把「相对时间」算好传进来了（`relativeLabel`）——
 * 见 `lib/format.ts` 的水合说明：这里**不能**再 `new Date()`。
 */

import { useState, type ReactElement } from 'react';
import Link from 'next/link';
import { ContentType } from '@signal/contracts';
import { BookmarkButton } from './bookmark-button';
import { IconArrowRight } from './icons';
import { EmptyState } from './shell';

export type BookmarkListItem = {
  id: string;
  title: string;
  summary: string | null;
  sourceName: string;
  type: ContentType;
  relativeLabel: string;
};

/** 标签 → 匹配的内容类型。`全部` 用 `null`。 */
const TABS: { label: string; type: ContentType | null }[] = [
  { label: '全部', type: null },
  { label: '文章', type: ContentType.ARTICLE },
  { label: 'X', type: ContentType.X_POST },
];

export function BookmarkList({ items }: { items: BookmarkListItem[] }): ReactElement {
  const [active, setActive] = useState<string>('全部');

  const tab = TABS.find((candidate) => candidate.label === active) ?? TABS[0];
  const visible =
    tab === undefined || tab.type === null ? items : items.filter((item) => item.type === tab.type);

  // 原型里第四个标签是「日报」。日报**不是**内容（它是一期编排），
  // 所以收藏里不会有 ContentType.DAILY 这种东西 —— 那个标签在真实数据上
  // 永远是空的，因此不提供。这是与原型的一处有意偏离，已记入 CCR。
  const tabs = TABS;

  return (
    <>
      <div className="tabs">
        {tabs.map((candidate) => (
          <button
            key={candidate.label}
            type="button"
            className={candidate.label === active ? 'tab active' : 'tab'}
            onClick={() => setActive(candidate.label)}
          >
            {candidate.label}
          </button>
        ))}
        <span className="subtle" style={{ alignSelf: 'center', marginLeft: '6px' }}>
          仅筛本页（{String(items.length)} 条）
        </span>
      </div>

      {visible.length === 0 ? (
        <EmptyState title="这一类里没有收藏" hint="切回「全部」看看。" />
      ) : (
        <section className="story-list">
          {visible.map((item) => (
            <article className="story-row no-image" key={item.id}>
              <div>
                <div className="source-line">
                  {labelOfType(item.type)} · {item.sourceName} · {item.relativeLabel}
                </div>
                <div className="story-title">
                  <Link href={`/article/${item.id}`}>{item.title}</Link>
                </div>
                {item.summary === null ? null : <p className="story-summary">{item.summary}</p>}
                <div className="story-actions">
                  {/*
                   * 收藏页上的这个按钮初始值**必须是 true** ——
                   * 它出现在这里就说明已经收藏过了。点一下取消，然后它会
                   * 从列表里消失（下一次刷新时；本地不做即时移除，
                   * 因为那会让「我刚取消的那条去哪了」变得不可撤销）。
                   */}
                  <BookmarkButton contentId={item.id} initial />
                  <Link className="quiet-action" href={`/article/${item.id}`}>
                    阅读全文 <IconArrowRight />
                  </Link>
                </div>
              </div>
            </article>
          ))}
        </section>
      )}
    </>
  );
}

function labelOfType(type: ContentType): string {
  switch (type) {
    case ContentType.X_POST:
      return 'X';
    case ContentType.ARTICLE:
      return '文章';
    default:
      return '内容';
  }
}
