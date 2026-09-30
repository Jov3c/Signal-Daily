/**
 * 历史日报（`/daily/archive`）—— 原型的 `daily-archive.html`。
 *
 * 一个月的日历，有日报的那天可以点进去。
 *
 * ⚠ **只显示 `PUBLISHED`**（`docs/10`：前台日历只展示已发布）。
 * 那条约束落在 API 侧（`DailyService.archive`），前端不做第二次过滤 ——
 * 两处都过滤意味着「哪天算已发布」有两个定义，而它们会漂移。
 *
 * ⚠ 日历网格是**按业务日**排的，不是按浏览器本地日期。`meta.from` /
 * `meta.to` 由服务端给出（该月的业务日区间），所以「1 号是周几」
 * 不会因为访客在纽约而错一位。
 */

import type { ReactElement } from 'react';
import Link from 'next/link';
import { EmptyState, PageHead } from '../../../../components/shell';
import { serverFetch } from '../../../../lib/api';
import { formatBusinessDate } from '../../../../lib/format';
import type { PublicDailyArchiveEntry } from '../../../../lib/types';
import { IconChevronLeft, IconChevronRight } from '../../../../components/icons';

type ArchiveResponse = {
  data: PublicDailyArchiveEntry[];
  meta: { from: string; to: string; total: number };
};

/** 星期表头（`docs/00` 的冻结时区是 Asia/Shanghai，所以顺序固定）。 */
const WEEKDAY_HEADERS = ['一', '二', '三', '四', '五', '六', '日'];

/** 周一为一周之首（中文日历习惯）。JS 的 `getUTCDay()` 里周日是 0。 */
function weekdayIndexMondayFirst(utcDate: Date): number {
  return (utcDate.getUTCDay() + 6) % 7;
}

export default async function ArchivePage({
  searchParams,
}: {
  searchParams: Promise<{ year?: string; month?: string }>;
}): Promise<ReactElement> {
  const { year, month } = await searchParams;
  const archive = await serverFetch<ArchiveResponse>('/daily/archive', { query: { year, month } });

  const { from, to } = archive.meta;
  const byDate = new Map(archive.data.map((entry) => [entry.businessDate, entry]));

  // 该月的每一天。用 UTC 日期算术（业务日是没有时刻的日历日）。
  const firstDay = new Date(`${from}T00:00:00.000Z`);
  const lastDay = new Date(new Date(`${to}T00:00:00.000Z`).getTime() - 86_400_000);
  const daysInMonth = lastDay.getUTCDate();
  const leadingBlanks = weekdayIndexMondayFirst(firstDay);

  const shiftMonth = (delta: number): string => {
    const base = new Date(Date.UTC(firstDay.getUTCFullYear(), firstDay.getUTCMonth() + delta, 1));
    return `/daily/archive?year=${String(base.getUTCFullYear())}&month=${String(base.getUTCMonth() + 1)}`;
  };

  const monthLabel = `${String(firstDay.getUTCFullYear())} 年 ${String(firstDay.getUTCMonth() + 1)} 月`;

  return (
    <div className="container">
      <PageHead
        eyebrow={monthLabel}
        title="历史日报"
        subtle={`这个月发布了 ${String(archive.meta.total)} 期。点日期阅读。`}
        action={{ href: '/daily', label: '看今天这一期' }}
      />

      <div className="archive-layout">
        <div>
          <div className="archive-calendar">
            <div className="cal-head">
              <Link className="soft-btn" href={shiftMonth(-1)} title="上个月">
                <IconChevronLeft />
              </Link>
              <strong>{monthLabel}</strong>
              <Link className="soft-btn" href={shiftMonth(1)} title="下个月">
                <IconChevronRight />
              </Link>
            </div>

            <div className="cal-grid">
              {WEEKDAY_HEADERS.map((label) => (
                <span className="cal-weekday" key={label}>
                  {label}
                </span>
              ))}
              {Array.from({ length: leadingBlanks }, (_, index) => (
                <span key={`blank-${String(index)}`} />
              ))}
              {Array.from({ length: daysInMonth }, (_, index) => {
                const day = index + 1;
                const businessDate = `${from.slice(0, 8)}${String(day).padStart(2, '0')}`;
                const entry = byDate.get(businessDate);
                return entry === undefined ? (
                  <span className="day" key={businessDate}>
                    {day}
                  </span>
                ) : (
                  <Link
                    className="day has"
                    key={businessDate}
                    href={`/daily/${businessDate}`}
                    title={`${formatBusinessDate(businessDate)} · ${String(entry.itemCount)} 条`}
                  >
                    {day}
                    <span className="edition-no">{entry.editionNoLabel ?? ''}</span>
                  </Link>
                );
              })}
            </div>
          </div>
        </div>

        <div className="archive-panel">
          {archive.data.length === 0 ? (
            <EmptyState title="这个月还没有日报" hint="换一个月份看看。" />
          ) : (
            <>
              <h2 style={{ fontSize: '13px', margin: '0 0 12px' }}>本期列表</h2>
              <div className="edition-list">
                {[...archive.data].reverse().map((entry) => (
                  <Link
                    className="edition-row"
                    key={entry.businessDate}
                    href={`/daily/${entry.businessDate}`}
                  >
                    <span>{entry.businessDate.slice(5)}</span>
                    <span className="edition-no">{entry.editionNoLabel ?? '—'}</span>
                    <span className="subtle">{String(entry.itemCount)} 条</span>
                  </Link>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
