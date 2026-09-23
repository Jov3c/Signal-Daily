import { API_PREFIX, BUSINESS_TIMEZONE } from '@signal/contracts';

/**
 * 首页 — Agent 00 空壳占位页。
 *
 * 这不是产品页面，只是证明 web 空壳可启动、且能从 @signal/contracts 正确 import。
 * 真实的「今日 / 精选 / 日报 / X 动态」页面由 Agent 13 实现。
 */
export default function Page() {
  return (
    <main>
      <h1>Signal web shell</h1>
      <p>
        bootstrap placeholder — api prefix <code>{API_PREFIX}</code>, business timezone{' '}
        <code>{BUSINESS_TIMEZONE}</code>
      </p>
    </main>
  );
}
