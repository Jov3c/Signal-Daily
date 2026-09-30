/**
 * 某一期日报（`/daily/[date]`）。
 *
 * 与原型的 `daily.html` 同一套版式（`.newspaper-*` / `.edition-*`），
 * 只是日期从 URL 来。在 `/daily` 与 `/daily/archive` 里点进去都会落到这里。
 *
 * ── ⚠ 三种「看不到」必须分开 ────────────────────────────────────────
 *
 * ```text
 * 日期格式不对        → 404（它从来不是一个地址）
 * 该期不存在/未发布    → 404 + 一句说得清楚的说明（docs/10：DRAFT 不公开）
 * 其它错误（500/网络） → 抛出去，走错误页
 * ```
 *
 * 第三条最要紧：把后端故障也渲染成「这一期还没发布」会让人往完全
 * 错误的方向排查（去问编辑为什么没发，而其实是库挂了）。
 */

import type { ReactElement } from 'react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { DailyEdition } from '../../../../components/daily-edition';
import { PageHead } from '../../../../components/shell';
import { ApiRequestError, serverFetch, type Single } from '../../../../lib/api';
import { businessDateWeekday, formatBusinessDate } from '../../../../lib/format';
import type { PublicDailyEdition } from '../../../../lib/types';

/** `YYYY-MM-DD`；不合法就不必去问 API 了。 */
const BUSINESS_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export default async function DailyEditionPage({
  params,
}: {
  params: Promise<{ date: string }>;
}): Promise<ReactElement> {
  const { date } = await params;
  if (!BUSINESS_DATE_PATTERN.test(date)) notFound();

  let edition: PublicDailyEdition;
  try {
    edition = (await serverFetch<Single<PublicDailyEdition>>(`/daily/${date}`)).data;
  } catch (error) {
    if (error instanceof ApiRequestError && error.status === 404) notFound();
    throw error;
  }

  return (
    <div className="container">
      <PageHead
        eyebrow={`${formatBusinessDate(edition.businessDate)} · ${businessDateWeekday(edition.businessDate)}`}
        title="信号日报"
        subtle={edition.headline ?? '这一期的内容。'}
        action={{ href: '/daily/archive', label: '历史日报' }}
      />
      <DailyEdition edition={edition} />
      <p className="subtle" style={{ marginTop: '20px' }}>
        想看今天这一期？去 <Link className="text-link" href="/daily">日报</Link>。
      </p>
    </div>
  );
}
