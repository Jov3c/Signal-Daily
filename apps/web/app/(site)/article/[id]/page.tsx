/**
 * 文章阅读（`/article/[id]`）—— 原型的 `article.html`。
 *
 * ```text
 * .article-shell
 *   .article-header   eyebrow(主题) / h1 / .article-deck(摘要) / .meta(作者·日期·时长)
 *   .article-toolbar  收藏 / 译文开关 / 打开原文
 *   .article-cover
 *   .article-body     正文（原文与译文都在 DOM 里，用 hidden 切换）
 *   .article-footer   来源与证据（轻量）
 * ```
 *
 * ── 三条硬要求（都来自 docs）────────────────────────────────────────
 *
 * 1. **必须有来源与原文链接**（`docs/00` / `docs/17` 第 22 条：
 *    内容详情始终包含 `originalUrl` 与 `source`）。所以「原文」按钮
 *    永远在，即使正文为空也不会消失。
 * 2. **`bodyOriginal` 不被 `bodyTranslated` 覆盖**（`docs/00`）。
 * 3. **evidence summary 要能看到，但只有轻量那一层**（`docs/14`）。
 *
 * ── ⚠ 可见性失败与「不存在」对用户是同一件事 ────────────────────────
 * 后端故意不区分「不存在」与「未审核」（`docs/12`：不要构成存在性探测器），
 * 所以前端**也不区分** —— 两种都走 404 页面。
 */

import type { ReactElement } from 'react';
import { notFound } from 'next/navigation';
import { ArticleBody, EvidencePanel } from '../../../../components/article-client';
import { BookmarkButton } from '../../../../components/bookmark-button';
import { ApiRequestError, serverFetch, type Single } from '../../../../lib/api';
import { dottedDate, readingLabel } from '../../../../lib/format';
import type { PublicContent } from '@signal/contracts';
import { IconExternal } from '../../../../components/icons';

export default async function ArticlePage({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<ReactElement> {
  const { id } = await params;

  let content: PublicContent;
  try {
    content = (await serverFetch<Single<PublicContent>>(`/contents/${encodeURIComponent(id)}`)).data;
  } catch (error) {
    // 404 = 不存在**或**不可见（后端刻意不区分）。其它错误继续抛。
    if (error instanceof ApiRequestError && error.status === 404) notFound();
    throw error;
  }

  const published = content.publishedAt === null ? null : new Date(content.publishedAt);

  return (
    <div className="container">
      <article className="article-shell">
        <header className="article-header">
          <div className="eyebrow">
            {content.topics.length === 0
              ? content.source.name
              : content.topics.map((topic) => topic.name).join(' / ')}
          </div>
          <h1>{content.title}</h1>
          {content.summary === null ? null : <p className="article-deck">{content.summary}</p>}
          <div className="meta">
            <span>{content.author?.name ?? content.source.name}</span>
            <span className="dot">·</span>
            <span>{published === null ? '未标注发布时间' : dottedDate(published)}</span>
            <span className="dot">·</span>
            <span>{readingLabel(content.bodyOriginal ?? content.summary)}</span>
          </div>
        </header>

        <div className="article-toolbar">
          <BookmarkButton contentId={content.id} initial={content.bookmarked ?? false} label={false} />
          <a
            className="quiet-action"
            href={content.originalUrl}
            target="_blank"
            rel="noreferrer noopener"
          >
            原文 <IconExternal />
          </a>
        </div>

        <div className="article-cover" aria-hidden="true" />

        {content.bodyOriginal === null ? (
          <p className="subtle">
            这条内容没有正文（可能是 X 动态或只有摘要的条目）。请点上面的「原文」查看来源。
          </p>
        ) : (
          <ArticleBody
            contentId={content.id}
            original={content.bodyOriginal}
            translated={content.bodyTranslated}
            // 匿名访客按「不自动展开译文」处理 —— 与原型一致。
            defaultShowTranslation={false}
          />
        )}

        <footer className="article-footer">
          <div className="detail-block">
            <h2>来源</h2>
            <dl className="kv">
              <dt>来源</dt>
              <dd>
                {content.source.name}
                {content.source.official ? '（官方）' : ''}
              </dd>
              <dt>类型</dt>
              <dd>
                {content.source.type} · {content.source.tier}
              </dd>
              <dt>原文</dt>
              <dd>
                <a href={content.originalUrl} target="_blank" rel="noreferrer noopener">
                  {content.originalUrl}
                </a>
              </dd>
            </dl>
          </div>

          <EvidencePanel contentId={content.id} summary={content.evidenceSummary} />
        </footer>
      </article>
    </div>
  );
}
