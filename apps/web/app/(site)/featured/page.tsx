/**
 * 精选（`/featured`）—— 原型的 `featured.html`。
 *
 * 数据来自 `GET /featured`（**cursor 分页**，`docs/02`：Public Feed 用 cursor）。
 *
 * ── ⚠ 这个接口返回的形状与 /today、/x 不同 ──────────────────────────
 * `/today` 与 `/x` 返回的是 `PublicContent`，而 `/featured` 返回的是
 * **精选表的行**：外层是 `contentId / customTitle / sortWeight / active`，
 * 内容在 `content` 子对象里。
 *
 * 也就是说编辑的**自定义标题与摘要**（`customTitle` / `customSummary`）
 * 会覆盖内容自己的 —— 这正是精选的意义（编辑挑出来并重写标题）。
 * 所以下面一律 `customTitle ?? content.title`。
 *
 * ⚠ 该响应**还带着** `content.pipelineStatus` / `reviewStatus` /
 * `publishFeatured` 三个内部字段。前台**不读**它们（`docs/14`），
 * 但它们在响应里确实是可达的 —— 已作为独立问题记入 CCR-agent-13 第 2 项。
 */

import type { ReactElement } from 'react';
import Link from 'next/link';
import { BookmarkButton } from '../../../components/bookmark-button';
import { EmptyState, PageHead } from '../../../components/shell';
import { serverFetch, type CursorPage } from '../../../lib/api';
import { shortRelative } from '../../../lib/format';
import type { FeaturedRow } from '../../../lib/types';
import { IconArrowRight, IconExternal } from '../../../components/icons';

export default async function FeaturedPage({
  searchParams,
}: {
  searchParams: Promise<{ cursor?: string }>;
}): Promise<ReactElement> {
  const { cursor } = await searchParams;
  const page = await serverFetch<CursorPage<FeaturedRow>>('/featured', {
    query: { cursor },
  });

  const now = new Date();

  return (
    <div className="container">
      <PageHead
        eyebrow="Editor's picks"
        title="精选"
        subtle="编辑挑出来的内容，按可读价值排序 —— 不是按热度。"
      />

      {page.data.length === 0 ? (
        <EmptyState
          title="还没有精选内容"
          hint="编辑还没有从今日候选里挑出内容。可以先看看今日。"
        />
      ) : (
        <section className="story-list">
          {page.data.map((row) => (
            <article className="story-row" key={row.contentId}>
              <div>
                <div className="source-line">
                  <span className="source-badge">A</span>
                  {row.content.sourceName} ·{' '}
                  {shortRelative(new Date(row.publishedAt), now)}
                </div>
                <div className="story-title">
                  <Link href={`/article/${row.contentId}`}>
                    {row.customTitle ?? row.content.title}
                  </Link>
                </div>
                {(() => {
                  const summary = row.customSummary ?? row.content.summary;
                  return summary === null ? null : <p className="story-summary">{summary}</p>;
                })()}
                <div className="story-actions">
                  <BookmarkButton contentId={row.contentId} initial={false} />
                  <a
                    className="quiet-action"
                    href={row.content.originalUrl}
                    target="_blank"
                    rel="noreferrer noopener"
                  >
                    原文 <IconExternal />
                  </a>
                  <Link className="quiet-action" href={`/article/${row.contentId}`}>
                    站内阅读 <IconArrowRight />
                  </Link>
                </div>
              </div>
              <div className="thumb" aria-hidden="true" />
            </article>
          ))}
        </section>
      )}

      {/*
       * 翻页用 cursor（`docs/02`）。**没有**「上一页」—— cursor 是单向的，
       * 想往回看请用浏览器的后退（那会复用上一页的缓存，比重新请求快）。
       * 造一个假的「上一页」要记住历史 cursor 栈，而收益接近零。
       */}
      {page.meta.nextCursor === null ? null : (
        <div className="end-actions" style={{ marginTop: '22px' }}>
          <Link className="soft-btn" href={`/featured?cursor=${encodeURIComponent(page.meta.nextCursor)}`}>
            更早的精选 <IconArrowRight />
          </Link>
        </div>
      )}

      {page.meta.nextCursor === null && page.data.length > 0 ? (
        <p className="subtle" style={{ marginTop: '18px' }}>
          已经到底了。想按主题找内容，去 <Link className="text-link" href="/topics">主题</Link> 或{' '}
          <Link className="text-link" href="/search">搜索</Link>。
        </p>
      ) : null}
    </div>
  );
}
