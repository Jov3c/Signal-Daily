/**
 * 日报（`/daily`）—— 原型的 `daily.html`，展示**今日已发布**的那一期。
 *
 * ── 为什么先去问 `/today` 要业务日 ───────────────────────────────────
 * 前端不知道「今天是哪个业务日」—— 那是 `Asia/Shanghai` 的日历，
 * 而且巴黎时间 23:30 与北京时间 07:30 属于不同的业务日。
 * 自己用 `new Date()` 算 = 在浏览器时区里重实现一遍业务日历，
 * 那正是 `lib/format.ts` 反复在避免的事。
 *
 * `/today` 的响应里带着 `businessDate`（服务端算的），拿它去请求
 * `/daily/{date}` 就永远不会错。
 *
 * ── ⚠ 没发布不是错误 ────────────────────────────────────────────────
 * `docs/10`：08:00 之前、或者当天编辑还没 review 完，日报就是**不存在**的
 *（`GET /daily/:date` 返回 404）。那是正常状态，不是故障 ——
 * 所以要给一个说得清楚的空态 + 去历史日报的路，而不是把 404 抛成错误页。
 */

import type { ReactElement } from 'react';
import Link from 'next/link';
import { EmptyState, PageHead } from '../../../components/shell';
import { serverFetch, ApiRequestError, type Single } from '../../../lib/api';
import { formatBusinessDate, businessDateWeekday } from '../../../lib/format';
import type { PublicDailyEdition } from '../../../lib/types';
import { DailyEdition } from '../../../components/daily-edition';

type TodayView = { businessDate: string };

export default async function DailyPage(): Promise<ReactElement> {
  const today = await serverFetch<Single<TodayView>>('/today');
  const businessDate = today.data.businessDate;

  let edition: PublicDailyEdition | null = null;
  try {
    edition = (await serverFetch<Single<PublicDailyEdition>>(`/daily/${businessDate}`)).data;
  } catch (error) {
    // 只有「没发布」才走空态；其它错误（500 / 网络）应当继续抛，
    // 否则一次后端故障会被伪装成「今天没有日报」——那会让人查错方向。
    if (!(error instanceof ApiRequestError) || error.status !== 404) throw error;
  }

  const eyebrow = `${formatBusinessDate(businessDate)} · ${businessDateWeekday(businessDate)}`;

  if (edition === null) {
    return (
      <div className="container">
        <PageHead eyebrow={eyebrow} title="日报" subtle="今天这一期还没有发布。" />
        <EmptyState
          title="今日日报尚未发布"
          hint="日报在北京时间 08:00 发布，前提是当天的内容已经审核完。"
        />
        <div className="end-actions" style={{ marginTop: '20px' }}>
          <Link className="soft-btn" href="/daily/archive">
            查看历史日报
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="container">
      <PageHead
        eyebrow={eyebrow}
        title="信号日报"
        subtle={edition.headline ?? '今天值得知道的 AI 与科技。'}
        action={{ href: '/daily/archive', label: '历史日报' }}
      />
      <DailyEdition edition={edition} />
    </div>
  );
}
