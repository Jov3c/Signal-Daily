'use client';

/**
 * X 动态的一条（原型的 `.x-post`）。
 *
 * ── 为什么整个 `.x-body` 是一个客户端元件 ───────────────────────────
 * 「查看翻译 / 隐藏翻译」按钮在 `.x-actions` 里，而它要控制的是
 * **上面**那个 `.translation` 块的开合。原型靠 DOM 查询把两者连起来：
 *
 * ```js
 * const post = button.closest('.x-post');
 * const box = post.querySelector('.translation');
 * ```
 *
 * 在 React 里那么写等于用 DOM 查询穿透组件边界 —— 包一层 `<div>`、
 * 换一个 class 名，它就**静默失效**（按钮点了没反应，没有任何测试会红）。
 * 所以这里让同一个元件持有状态，DOM 结构仍然逐字复刻原型。
 *
 * ── `defaultShowTranslation` 是**初值**不是受控值 ────────────────────
 * 它来自设置里的 `defaultTranslation`（`docs/11`）。用户在这次浏览里
 * 手动开合过之后，就不该被设置的变化再覆盖 —— 那会让「我刚点开的译文
 * 又自己收起来了」。
 *
 * ── ⚠ 没有关注 / 订阅 / 评论 / 私信 ─────────────────────────────────
 * `docs/23` 与任务书都写死了：用户在 X 动态只能**看原文、看翻译、收藏、
 * 跳去 X**。`docs/17` 第 19 条断言前端没有「我的订阅」与 `data-subscribe`。
 * 所以这个元件的动作区**只有三项**，加第四个之前请先读那一条。
 */

import { useState, type ReactElement } from 'react';
import type { PublicContent } from '@signal/contracts';
import { BookmarkButton } from './bookmark-button';
import { IconExternal } from './icons';
import { initialsOf } from '../lib/format';

export function XPost({
  content,
  relativeLabel,
  defaultShowTranslation,
}: {
  content: PublicContent;
  /** 服务端算好的相对时间（`2h`）—— 见 `lib/format.ts` 的水合说明。 */
  relativeLabel: string;
  defaultShowTranslation: boolean;
}): ReactElement {
  const name = content.author?.name ?? content.source.name;
  const handle = content.author?.xHandle ?? null;
  const translated = content.bodyTranslated;

  const [showTranslation, setShowTranslation] = useState(defaultShowTranslation);

  return (
    <article className="x-post">
      <div className="x-head">
        <div className="avatar">{initialsOf(name)}</div>
        <div>
          <div className="x-name">{name}</div>
          <div className="x-user">
            {handle === null || handle === undefined ? content.source.name : `@${handle}`} ·{' '}
            {relativeLabel}
          </div>
        </div>
      </div>
      <div className="x-body">
        <div className="x-text">{content.bodyOriginal ?? content.summary ?? ''}</div>

        {translated === null ? null : (
          <div className={showTranslation ? 'translation' : 'translation hidden'}>
            {translated}
          </div>
        )}

        <div className="x-actions">
          {translated === null ? null : (
            <button
              type="button"
              className="quiet-action"
              aria-expanded={showTranslation}
              onClick={() => setShowTranslation((current) => !current)}
            >
              {showTranslation ? '隐藏翻译' : '查看翻译'}
            </button>
          )}
          <BookmarkButton contentId={content.id} initial={content.bookmarked ?? false} />
          <a
            className="quiet-action"
            href={content.originalUrl}
            target="_blank"
            rel="noreferrer noopener"
          >
            在 X 查看 <IconExternal />
          </a>
        </div>
      </div>
    </article>
  );
}
