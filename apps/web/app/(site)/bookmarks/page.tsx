/**
 * 收藏（`/bookmarks`）—— 原型的 `bookmarks.html`。
 *
 * ── ⚠ 这是**唯一**需要登录的前台页面 ────────────────────────────────
 * `docs/00` 的其余公开面全部游客可读。所以这一页在未登录时**不跳转**，
 * 而是渲染一个引导登录的空态 —— 「把用户甩到别处」会让他丢掉
 * 「我点的是收藏」这个上下文。
 *
 * 判断登录态的方式：直接请求 `GET /bookmarks`，401 就是未登录。
 * 不先查 `/me` 再查收藏 —— 那是两个往返，而且两者之间的状态可能变。
 *
 * ── 分类标签沿用原型的四个 ──────────────────────────────────────────
 * `全部 / 文章 / X / 日报`。这里是**客户端过滤已经取回的一页**，
 * 而不是再打一次接口 —— `GET /bookmarks` 只按时间倒序返回，
 * 没有 type 过滤参数。所以标签上加了「（本页）」的说明，如实表达
 * 它过滤的是当前这一页，不是全部收藏。已记入 CCR-agent-13。
 */

import type { ReactElement } from 'react';
import Link from 'next/link';
import { EmptyState, PageHead } from '../../../components/shell';
import { ApiRequestError, serverFetch, type CursorPage } from '../../../lib/api';
import { shortRelative } from '../../../lib/format';
import type { PublicContent } from '@signal/contracts';
import { BookmarkList } from '../../../components/bookmark-list';

export default async function BookmarksPage(): Promise<ReactElement> {
  let page: CursorPage<PublicContent> | null = null;
  try {
    page = await serverFetch<CursorPage<PublicContent>>('/bookmarks');
  } catch (error) {
    // 401 = 未登录（正常路径，不是错误）。其它错误继续抛。
    if (!(error instanceof ApiRequestError) || error.status !== 401) throw error;
  }

  if (page === null) {
    return (
      <div className="container">
        <PageHead
          eyebrow="Your library"
          title="收藏"
          subtle="登录之后，你收藏的内容会出现在这里，并在设备之间同步。"
        />
        <EmptyState
          title="登录后才能使用收藏"
          hint="收藏保存在账号里（不是浏览器里），换设备也在。"
        />
        <p className="subtle" style={{ marginTop: '16px' }}>
          登录入口在右上角。没有注册流程 —— 邮箱收到验证码就等于有账号了。
          也可以先去 <Link className="text-link" href="/">今日</Link> 看看。
        </p>
      </div>
    );
  }

  const now = new Date();

  return (
    <div className="container">
      <PageHead
        eyebrow="Your library"
        title="收藏"
        subtle={`${String(page.data.length)} 条。之后还想回来读的内容。`}
      />
      {page.data.length === 0 ? (
        <EmptyState
          title="还没有收藏"
          hint="在信息流或文章页点「收藏」，它就会出现在这里。"
        />
      ) : (
        <BookmarkList
          items={page.data.map((item) => ({
            id: item.id,
            title: item.title,
            summary: item.summary,
            sourceName: item.source.name,
            type: item.type,
            relativeLabel: shortRelative(new Date(item.publishedAt ?? now), now),
          }))}
        />
      )}
    </div>
  );
}
