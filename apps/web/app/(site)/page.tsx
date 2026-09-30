/**
 * 今日（`/`）—— 原型的 `index.html`。
 *
 * ```text
 * page-head   2026 年 9 月 22 日 · 周二 | 今日 | 今天真正值得你花时间读的内容。
 * hero        今日头条（当日最高分）
 * mini-grid   值得关注（featured 的前三条）
 * story-list  最新（latest）
 * mini-grid   X 今日声音（X 动态的前三条）
 * ```
 *
 * 数据来自 **两个**接口：
 * - `GET /today` —— 当日的 featured 与 latest（按**上海业务日**切窗口）
 * - `GET /x`     —— 「X 今日声音」那三张卡
 *
 * ⚠ 「X 今日声音」没有单独的接口，也不该有：它就是要 X 动态的前三条。
 * 为它开一条 `/x/today` 等于让「今日声音」与「X 动态」有两条可能分叉的
 * 排序逻辑。这里取同一个列表的前三条，所以两处永远一致。
 *
 * ⚠ 时间文案在**服务端**算好（`shortRelative(..., now)`）——
 * 见 `lib/format.ts` 的水合说明。
 */

import type { ReactElement } from 'react';
import Link from 'next/link';
import { Hero, MiniCard, StoryRow } from '../../components/cards';
import { EmptyState, PageHead, SectionTitle } from '../../components/shell';
import { serverFetch, type Single } from '../../lib/api';
import {
  businessDateWeekday,
  formatBusinessDate,
  longBusinessDate,
  shortRelative,
} from '../../lib/format';
import type { PublicContent } from '@signal/contracts';

/** 「X 今日声音」展示几条。原型是 3 条。 */
const X_VOICE_COUNT = 3;
/** 「值得关注」展示几条。原型是 3 条。 */
const HIGHLIGHT_COUNT = 3;

export const dynamic = 'force-dynamic';

type TodayView = {
  businessDate: string;
  featured: PublicContent[];
  latest: PublicContent[];
};

type XFeed = { data: PublicContent[] };

export default async function TodayPage(): Promise<ReactElement> {
  // ⚠ 两个请求并行。串行会让首屏多等一个往返，而它们互不依赖。
  const [today, x] = await Promise.all([
    serverFetch<Single<TodayView>>('/today'),
    serverFetch<XFeed>('/x').catch(() => ({ data: [] })),
  ]);

  const now = new Date();
  const { featured, latest } = today.data;

  // 头条优先取 featured 的第一条；当天还没有高分内容时退回最新一条。
  // 都没有就是真的没有内容（空库 / 采集还没跑），下面给空态。
  const headline = featured[0] ?? latest[0] ?? null;
  // 「值得关注」= 去掉头条之后的前三条（头条已经在 hero 里了，再列一遍是重复）。
  const highlights = featured
    .filter((item) => item.id !== headline?.id)
    .slice(0, HIGHLIGHT_COUNT);
  const rest = latest.filter((item) => item.id !== headline?.id);
  const xVoice = x.data.slice(0, X_VOICE_COUNT);

  const businessDateLabel = `${formatBusinessDate(today.data.businessDate)} · ${businessDateWeekday(today.data.businessDate)}`;

  return (
    <div className="container">
      <PageHead
        eyebrow={businessDateLabel === ' · ' ? longBusinessDate(now) : businessDateLabel}
        title="今日"
        subtle="今天真正值得你花时间读的内容。"
        action={{ href: '/daily', label: '阅读今日日报' }}
      />

      {headline === null ? (
        <EmptyState
          title="今天还没有内容"
          hint="采集与审核还在跑。可以先看看历史日报。"
        />
      ) : (
        <Hero
          content={headline}
          eyebrow="今日头条"
          relativeLabel={shortRelative(new Date(headline.publishedAt ?? now), now)}
        />
      )}

      {highlights.length === 0 ? null : (
        <>
          <SectionTitle title="值得关注" link={{ href: '/featured', label: '查看全部精选 →' }} />
          <section className="mini-grid">
            {highlights.map((item, index) => (
              <MiniCard
                key={item.id}
                meta={`${String(index + 1).padStart(2, '0')} · ${item.source.name}`}
                title={item.title}
                href={`/article/${item.id}`}
              />
            ))}
          </section>
        </>
      )}

      {rest.length === 0 ? null : (
        <>
          <SectionTitle title="最新" link={{ href: '/search', label: '持续更新' }} />
          <section className="story-list">
            {rest.map((item) => (
              <StoryRow
                key={item.id}
                content={item}
                relativeLabel={shortRelative(new Date(item.publishedAt ?? now), now)}
              />
            ))}
          </section>
        </>
      )}

      {xVoice.length === 0 ? null : (
        <>
          <SectionTitle title="X 今日声音" link={{ href: '/x', label: '查看 X 动态 →' }} />
          <section className="mini-grid">
            {xVoice.map((item) => {
              const handle = item.author?.xHandle;
              return (
                <MiniCard
                  key={item.id}
                  meta={`${handle === undefined || handle === null ? item.source.name : `@${handle}`} · ${shortRelative(new Date(item.publishedAt ?? now), now)}`}
                  title={item.bodyOriginal ?? item.title}
                  href={item.originalUrl}
                  external
                />
              );
            })}
          </section>
        </>
      )}

      <p className="subtle" style={{ marginTop: '26px' }}>
        今日精选 {featured.length} 条 · 最新 {latest.length} 条 ·{' '}
        <Link className="text-link" href="/daily/archive">
          历史日报 →
        </Link>
      </p>
    </div>
  );
}
