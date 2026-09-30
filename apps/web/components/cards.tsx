/**
 * 卡片元件 —— **逐字对应 v1.7 原型的 DOM 结构**。
 *
 * 这些是**服务端元件**（没有 `'use client'`）：它们只把 props 渲染成
 * 原型里那套 class，交互由内层的小客户端元件承担（`BookmarkButton`）。
 *
 * ── ⚠ 时间文案一律在服务端算好再传进来 ──────────────────────────────
 * `relativeLabel` 这类**不在这里调用 `new Date()`**。原因见
 * `lib/format.ts` 的文件头：服务端渲染「2h」、客户端水合时算成「3h」，
 * React 会报 hydration mismatch 并丢掉服务端那份（表现为整块内容闪一下）。
 * 所以调用方（页面）算好了再当字符串传进来。
 *
 * ── 卡片 hover 的契约 ──────────────────────────────────────────────
 * `.mini-card:hover` / `.entity-card:hover` / `.story-row` 的 hover 全部
 * 只改背景与边框，**没有任何位移或缩放**。`docs/17` 的第 21 条验收项
 * 对此有断言，`apps/web/test/visual-contract.spec.ts` 会读 `globals.css`
 * 来验 —— 所以这里也**不要**加 `style={{ transform: ... }}`。
 */

import Link from 'next/link';
import type { ReactElement, ReactNode } from 'react';
import {
  SourceType,
  type PublicContent,
  type PublicPerson,
  type PublicTopic,
} from '@signal/contracts';
import { BookmarkButton } from './bookmark-button';
import { IconArrowRight, IconAuthorMark } from './icons';
import { initialsOf, readingLabel } from '../lib/format';

/**
 * 来源角标：X 来源显示 `X`，其它显示 `A`（原型如此）。
 *
 * ⚠ 判据是 **`source.type === SourceType.X_USER`**（「怎么采集」），
 * 不是 `kind === Person`（「这是谁」）。用 kind 会把一个 kind=PERSON
 * 的 RSS 博客错标成 X；而 kind 是**编辑配置的业务身份**，
 * 采集方式才是「这条内容长什么样」的依据。
 */
function sourceBadge(type: SourceType): string {
  return type === SourceType.X_USER ? 'X' : 'A';
}

/* ------------------------------------------------------------------ */
/* 今日头条（.hero）                                                    */
/* ------------------------------------------------------------------ */

export function Hero({
  content,
  eyebrow,
  relativeLabel,
}: {
  content: PublicContent;
  eyebrow: string;
  relativeLabel: string;
}): ReactElement {
  return (
    <section className="hero">
      <div>
        <div className="meta">
          <span>{eyebrow}</span>
          <span className="dot">·</span>
          <span>{content.topics[0]?.name ?? '科技'}</span>
          <span className="dot">·</span>
          <span>{readingLabel(content.bodyOriginal ?? content.summary)}</span>
        </div>
        <h2>
          <Link href={`/article/${content.id}`}>{content.title}</Link>
        </h2>
        {content.summary === null ? null : <p>{content.summary}</p>}
        <div className="meta">
          <span>{content.author?.name ?? content.source.name}</span>
          <span className="dot">·</span>
          <span>{relativeLabel}</span>
        </div>
      </div>
      <div className="hero-art">
        <span className="signal">SIGNAL / EDITORIAL</span>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* 小卡（.mini-card）—— 今日的「值得关注」与「X 今日声音」             */
/* ------------------------------------------------------------------ */

export function MiniCard({
  meta,
  title,
  href,
  external = false,
}: {
  meta: string;
  title: string;
  href: string;
  external?: boolean;
}): ReactElement {
  const body = (
    <>
      <div className="meta">{meta}</div>
      <h3>{title}</h3>
    </>
  );

  if (external) {
    return (
      <a className="mini-card" href={href} target="_blank" rel="noreferrer noopener">
        {body}
      </a>
    );
  }
  return (
    <Link className="mini-card" href={href}>
      {body}
    </Link>
  );
}

/* ------------------------------------------------------------------ */
/* 信息流一行（.story-row）                                             */
/* ------------------------------------------------------------------ */

export function StoryRow({
  content,
  relativeLabel,
}: {
  content: PublicContent;
  relativeLabel: string;
}): ReactElement {
  return (
    <article className="story-row">
      <div>
        <div className="source-line">
          <span className="source-badge">{sourceBadge(content.source.type)}</span>
          {content.source.name} · {relativeLabel}
          {content.topics[0] === undefined ? null : (
            <span className="tag">{content.topics[0].name}</span>
          )}
        </div>
        <div className="story-title">
          <Link href={`/article/${content.id}`}>{content.title}</Link>
        </div>
        {content.summary === null ? null : <p className="story-summary">{content.summary}</p>}
        {content.recommendationReason === null ? null : (
          <div className="recommend">为什么值得读：{content.recommendationReason}</div>
        )}
        <div className="story-actions">
          <BookmarkButton contentId={content.id} initial={content.bookmarked ?? false} />
          <Link className="quiet-action" href={`/article/${content.id}`}>
            阅读全文 <IconArrowRight />
          </Link>
        </div>
      </div>
      <div className="thumb" aria-hidden="true" />
    </article>
  );
}

/** 无缩略图的一行（搜索结果用它 —— 结果列表里堆一排空缩略图只是噪音）。 */
export function PlainRow({
  meta,
  title,
  href,
}: {
  meta: string;
  title: string;
  href: string;
}): ReactElement {
  return (
    <Link className="story-row no-image" href={href}>
      <div>
        <div className="source-line">{meta}</div>
        <div className="story-title">{title}</div>
      </div>
    </Link>
  );
}

/* ------------------------------------------------------------------ */
/* 实体卡（.entity-card）—— 人物 / 主题                                 */
/* ------------------------------------------------------------------ */

export function PersonCard({
  person,
  contentCount,
}: {
  person: PublicPerson;
  contentCount?: number;
}): ReactElement {
  return (
    <Link className="entity-card" href={`/people/${person.slug}`}>
      <div className="avatar">{initialsOf(person.name)}</div>
      <div>
        <h3>{person.name}</h3>
        {person.xHandle === null || person.xHandle === undefined ? null : (
          <div className="meta">@{person.xHandle}</div>
        )}
      </div>
      <div className="entity-card-foot">
        {contentCount === undefined ? null : <span>{contentCount} 条内容</span>}
      </div>
    </Link>
  );
}

export function TopicCard({
  topic,
  contentCount,
}: {
  topic: PublicTopic;
  contentCount?: number;
}): ReactElement {
  return (
    <Link className="entity-card" href={`/topics/${topic.slug}`}>
      <div className="avatar">
        <span className="topic-icon">#</span>
      </div>
      <div>
        <h3>{topic.name}</h3>
      </div>
      <div className="entity-card-foot">
        {contentCount === undefined ? null : <span>{contentCount} 条内容</span>}
      </div>
    </Link>
  );
}

/** 文章作者行。 */
export function AuthorLine({ name, meta }: { name: string; meta: string }): ReactElement {
  return (
    <div className="meta">
      <IconAuthorMark />
      <span>{name}</span>
      <span className="dot">·</span>
      <span>{meta}</span>
    </div>
  );
}

/** 通用列表容器（`.story-list`）。 */
export function StoryList({ children }: { children: ReactNode }): ReactElement {
  return <section className="story-list">{children}</section>;
}

/** 通用小卡网格（`.mini-grid`）。 */
export function MiniGrid({ children }: { children: ReactNode }): ReactElement {
  return <section className="mini-grid">{children}</section>;
}
