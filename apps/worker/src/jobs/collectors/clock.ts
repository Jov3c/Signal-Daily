/**
 * 可注入时钟。
 *
 * ── 为什么必须注入而不是直接 `new Date()` ─────────────────────────────
 * 「到期」判定与 `next_fetch_at` 推进都直接依赖「现在」：
 *
 *   - 断言「抓完之后 `nextFetchAt` 恰好等于 `本轮开始 + interval`」
 *     需要一个确定的基准时刻，否则只能用「大约」来断言，而「大约」验不出
 *     `interval + 抓取耗时` 这类周期退化；
 *   - 断言「停用的来源不再到期」需要能把时间往前拨。
 *
 * 与 Agent 02/03 的做法一致（`modules/auth/clock.ts`、`modules/sources/clock.ts`）。
 */

/** 注入 token。 */
export const CLOCK = 'COLLECTOR_CLOCK';

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};
