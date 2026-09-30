/**
 * 搜索（`/search`）—— 原型的 `search.html`。
 *
 * 数据来自 `GET /search?q=`（**offset 分页**，不是 cursor ——
 * Agent 10 的 CCR 第 2 项说明了理由：FULLTEXT 的相关度不是稳定列，
 * 做不了游标）。
 *
 * ── 两个由 API 决定、前端不能自作主张的地方 ─────────────────────────
 *
 * 1. **最少几个字**：`docs/12` 与后端 DTO 决定。前端不设 `minLength`，
 *    否则「输入两个字就搜」在界面上被禁用，而在 API 上其实是合法的 ——
 *    两处规则会漂移。空查询只是不发请求。
 * 2. **不返回未审核内容**：那是 SQL 里的可见性过滤（`docs/17` 第 23 条）。
 *    前端**不做**第二层过滤 —— 那会让人以为「过滤在前端」，
 *    从而在别处（比如某个新接口）忘了加。
 */

import type { ReactElement } from 'react';
import Link from 'next/link';
import { PlainRow } from '../../../components/cards';
import { PageHead } from '../../../components/shell';
import { serverFetch } from '../../../lib/api';
import { shortRelative } from '../../../lib/format';
import type { PublicContent } from '@signal/contracts';
import { IconArrowRight } from '../../../components/icons';

type SearchResponse = {
  data: PublicContent[];
  meta: { total: number; limit: number; offset: number };
};

/** 一页多少条。与后端 `parseSearchQuery` 的默认值保持一致。 */
const PAGE_SIZE = 20;

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; offset?: string }>;
}): Promise<ReactElement> {
  const { q, offset } = await searchParams;
  const query = (q ?? '').trim();
  const currentOffset = Math.max(0, Number(offset ?? '0') || 0);

  const result =
    query === ''
      ? null
      : await serverFetch<SearchResponse>('/search', {
          query: { q: query, limit: PAGE_SIZE, offset: currentOffset },
        });

  const now = new Date();

  return (
    <div className="container">
      <PageHead
        eyebrow="Search"
        title="搜索"
        subtle="搜索文章、X 动态与主题。未审核的内容不在结果里。"
      />

      {/*
       * 用**原生 form GET** 而不是受控输入 + JS：
       * 提交后地址栏是 `?q=…`，可以直接分享、可以后退、
       * 而且没有 JS 也能用。原型的 `initSearch` 是客户端过滤一个写死的目录，
       * 在真实数据上那条路走不通。
       */}
      <form className="search-box" action="/search" method="get" role="search">
        <input
          type="search"
          name="q"
          defaultValue={query}
          placeholder="输入关键词，搜索文章、X、人物和主题。"
          aria-label="搜索关键词"
          autoFocus={query === ''}
        />
        <button className="primary-btn" type="submit">
          搜索
        </button>
      </form>

      {result === null ? (
        <p className="search-empty">输入关键词，搜索文章、X、人物和主题。</p>
      ) : result.data.length === 0 ? (
        <div className="search-empty">
          <strong>没有找到相关内容</strong>
          <br />
          换一个关键词试试。
        </div>
      ) : (
        <>
          <p className="subtle" style={{ marginTop: '14px' }}>
            找到 {String(result.meta.total)} 条
            {result.meta.total > PAGE_SIZE
              ? `，当前第 ${String(Math.floor(currentOffset / PAGE_SIZE) + 1)} 页`
              : ''}
            。
          </p>
          <section className="search-results">
            {result.data.map((content) => (
              <PlainRow
                key={content.id}
                meta={`${content.source.name} · ${shortRelative(new Date(content.publishedAt ?? now), now)}`}
                title={content.title}
                href={`/article/${content.id}`}
              />
            ))}
          </section>

          <div className="end-actions" style={{ marginTop: '20px', gap: '8px' }}>
            {currentOffset === 0 ? null : (
              <Link
                className="soft-btn"
                href={`/search?q=${encodeURIComponent(query)}&offset=${String(Math.max(0, currentOffset - PAGE_SIZE))}`}
              >
                上一页
              </Link>
            )}
            {currentOffset + PAGE_SIZE >= result.meta.total ? null : (
              <Link
                className="soft-btn"
                href={`/search?q=${encodeURIComponent(query)}&offset=${String(currentOffset + PAGE_SIZE)}`}
              >
                下一页 <IconArrowRight />
              </Link>
            )}
          </div>
        </>
      )}
    </div>
  );
}
