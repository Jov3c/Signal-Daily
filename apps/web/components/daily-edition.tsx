/**
 * 日报正文 —— 原型的 `daily.html`（`.newspaper-*` / `.edition-*` 那套）。
 *
 * ```text
 * .daily-top       ← 前一天 / 历史日报 / 后一天
 * .newspaper-masthead  SIGNAL DAILY / 信号日报 / TUESDAY, SEPTEMBER 22, 2026 · NO. 086
 * .daily-section-nav   各版块的锚点
 * .newspaper-grid      **头版**：第一个版块的条目排成报纸网格
 * .edition-section    其余版块，每块一个 h2 + 三栏
 * ```
 *
 * ── 三件从数据里来、不能写死的事 ────────────────────────────────────
 *
 * 1. **刊号**：`NO. 086` 来自 `editionNoLabel`（服务端格式化好的）。
 *    前端自己拼 `NO. ${editionNo}` 会在没有刊号（`null`）时显示 `NO. null`。
 * 2. **版块清单**：来自 `sections`，不是原型里那六个写死的标签。
 *    每个版块一个锚点，点过去能真的跳到那一块（`id` 由 `slugify` 生成）。
 * 3. **相邻日期的链接**：由当前业务日 ±1 天算出。原型里那是两个装饰性按钮，
 *    这里它们是**真的**链接 —— 没发布的那天会落到「今日日报尚未发布」的空态，
 *    而不是 404。
 *
 * ⚠ 第一条内容（`sections[0].items[0]`）是头条：它占满左栏、用大标题
 * 与配图。其余按 `.paper-story` 排。数据里只有一条时也不会排版错乱 ——
 * 那种情况在日报刚起步时很常见。
 */

import Link from 'next/link';
import type { ReactElement } from 'react';
import { DailyDisplayStyle } from '@signal/contracts';
import type { PublicDailyEdition, PublicDailyItem } from '../lib/types';
import { englishBusinessDate, formatBusinessDate, shiftBusinessDate, slugify } from '../lib/format';
import { IconChevronLeft, IconChevronRight } from './icons';

export function DailyEdition({ edition }: { edition: PublicDailyEdition }): ReactElement {
  const [lead] = edition.sections;

  return (
    <div className="daily-wrap">
      <div className="daily-shell">
        <div className="daily-top">
          <Link
            className="soft-btn"
            href={`/daily/${shiftBusinessDate(edition.businessDate, -1)}`}
            title="前一天"
          >
            <IconChevronLeft /> {shiftBusinessDate(edition.businessDate, -1).slice(5)}
          </Link>
          <Link className="soft-btn center" href="/daily/archive">
            历史日报
          </Link>
          <Link
            className="soft-btn right"
            href={`/daily/${shiftBusinessDate(edition.businessDate, 1)}`}
            title="后一天"
          >
            {shiftBusinessDate(edition.businessDate, 1).slice(5)} <IconChevronRight />
          </Link>
        </div>

        <header className="newspaper-masthead">
          <div className="en">SIGNAL DAILY</div>
          <div className="cn">信号日报</div>
          <div className="date">
            {englishBusinessDate(edition.businessDate)}
            {edition.editionNoLabel === null ? null : ` · ${edition.editionNoLabel}`}
          </div>
        </header>

        {/*
         * 版块导航。`slugify(标题)` 既做锚点 id 也做 href 片段 ——
         * 两处用同一个函数，所以「点进去跳不到」这种事不会发生。
         */}
        {edition.sections.length <= 1 ? null : (
          <nav className="daily-section-nav">
            {edition.sections.map((section) => (
              <a key={section.type + section.title} href={`#${slugify(section.title)}`}>
                {section.title}
              </a>
            ))}
          </nav>
        )}

        {lead === undefined || lead.items.length === 0 ? (
          <p className="subtle">这一期还没有内容。</p>
        ) : (
          <section className="newspaper-grid" id={slugify(lead.title)}>
            <LeadColumn item={lead.items[0] as PublicDailyItem} />
            {chunk(lead.items.slice(1), 2).map((group, index) => (
              <div className="paper-col" key={`${lead.title}-${String(index)}`}>
                {group.map((item) => (
                  <PaperStory key={item.contentId} item={item} level="h2" />
                ))}
              </div>
            ))}
          </section>
        )}

        {edition.sections.slice(1).map((section) => (
          <section
            className="edition-section"
            key={section.type + section.title}
            id={slugify(section.title)}
          >
            <h2>{section.title}</h2>
            <div className="edition-cols">
              {section.items.map((item) => (
                <PaperStory key={item.contentId} item={item} level="h3" />
              ))}
            </div>
          </section>
        ))}

        <div className="daily-ending">
          <Link className="text-link" href="/daily/archive">
            往期日报 →
          </Link>
        </div>
      </div>
    </div>
  );
}

/** 头条：大标题 + 配图 + 正文段。 */
function LeadColumn({ item }: { item: PublicDailyItem }): ReactElement {
  return (
    <article className="paper-col">
      <div className="kicker">
        {item.source.official ? 'Lead Story · 官方一手' : 'Lead Story'}
      </div>
      <h1 className="paper-title">
        <Link href={`/article/${item.contentId}`}>{item.headline}</Link>
      </h1>
      <div className="paper-image" aria-hidden="true" />
      {item.excerpt === null ? null : <p className="paper-copy">{item.excerpt}</p>}
    </article>
  );
}

/** 非头条：kicker + 小标题 + 摘要。 */
function PaperStory({
  item,
  level,
}: {
  item: PublicDailyItem;
  level: 'h2' | 'h3';
}): ReactElement {
  const Title = level;
  return (
    <article className="paper-story">
      {/*
       * `displayStyle` 是编辑选的显示强度（`docs/05` 的 DailyDisplayStyle）。
       * V1 只用它决定 kicker 里显示什么标签，不改变字号 ——
       * 字号层级已经由「在头版还是普通版块」决定了，再来一套会让
       * 「为什么这条比那条大」变得无法解释。
       */}
      <div className="kicker">
        {item.source.name}
        {item.displayStyle === DailyDisplayStyle.BRIEF ? ' · 简讯' : ''}
      </div>
      <Title className="paper-title small">
        <Link href={`/article/${item.contentId}`}>{item.headline}</Link>
      </Title>
      {item.excerpt === null ? null : <p className="paper-copy">{item.excerpt}</p>}
    </article>
  );
}

/** 按 `size` 切成若干组（头版要把非头条排成两栏）。 */
function chunk<T>(items: T[], size: number): T[][] {
  const groups: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    groups.push(items.slice(index, index + size));
  }
  return groups;
}

/** 供日报页复用的眉题（避免两处各拼一次日期）。 */
export function dailyEyebrow(businessDate: string): string {
  return formatBusinessDate(businessDate);
}
