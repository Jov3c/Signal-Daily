'use client';

/**
 * 收藏按钮（原型的 `.quiet-action` + 书签图标）。
 *
 * ── 三件事与原型刻意不同 ────────────────────────────────────────────
 *
 * 1. **乐观更新 + 失败回滚**。原型写 localStorage，不会失败；
 *    真实 API 会（未登录 401、内容被撤下 404、网络抖动）。先改 UI 再发请求，
 *    失败就改回来并提示 —— 否则按钮会卡在「转圈 / 没反应」上。
 * 2. **未登录时打开登录抽屉**，而不是弹一个错误。收藏是阅读中途的动作，
 *    在这里把用户甩到一个错误提示上等于让他自己去别处找入口。
 * 3. **并发保护**：连点两次不会发出两个请求（`busy`），否则后到的响应
 *    可能把状态改回上一次的结果。
 *
 * ⚠ `initial` 只在**首次挂载**时作为初值。父级重新渲染（例如列表刷新）
 * 不会覆盖用户刚点的结果 —— 那正是「点了收藏又跳回去」的来源。
 */

import { useEffect, useState, type ReactElement } from 'react';
import { ApiClientError, setBookmark } from '../lib/client-api';
import { useAuth } from './auth';
import { IconBookmark } from './icons';
import { useToast } from './toast';

export function BookmarkButton({
  contentId,
  initial,
  label = true,
}: {
  contentId: string;
  initial: boolean;
  /** 是否显示「收藏 / 已收藏」文字（文章页的工具栏只要图标）。 */
  label?: boolean;
}): ReactElement {
  const [bookmarked, setBookmarked] = useState(initial);
  const [busy, setBusy] = useState(false);
  const { openLogin } = useAuth();
  const toast = useToast();

  // 列表换页 / 路由切换后内容 id 变了：把状态重置到服务端给的值。
  useEffect(() => setBookmarked(initial), [contentId, initial]);

  async function toggle(): Promise<void> {
    if (busy) return;

    const next = !bookmarked;
    setBookmarked(next); // 乐观
    setBusy(true);
    try {
      const result = await setBookmark(contentId, next);
      // 以服务端返回为准：它是幂等的，可能纠正我们的猜测。
      setBookmarked(result.bookmarked);
      toast.show(result.bookmarked ? '已收藏' : '已取消收藏');
    } catch (error) {
      setBookmarked(!next); // 回滚
      if (error instanceof ApiClientError && error.isUnauthorized) {
        openLogin();
        return;
      }
      if (error instanceof ApiClientError && error.code === 'CONTENT_NOT_VISIBLE') {
        toast.show('这篇内容已经不可见了');
        return;
      }
      toast.show('没能完成收藏，请稍后再试');
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      className={bookmarked ? 'quiet-action active' : 'quiet-action'}
      aria-pressed={bookmarked}
      aria-busy={busy}
      onClick={() => void toggle()}
    >
      <IconBookmark />
      {label ? <span data-label>{bookmarked ? '已收藏' : '收藏'}</span> : null}
    </button>
  );
}
