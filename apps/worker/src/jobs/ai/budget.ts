/**
 * AI 每日预算闸门 —— `docs/08`：「预算 80% 告警 / 100% 非关键任务暂停」。
 *
 * ── 统计口径：上海业务日，不是 UTC 日 ────────────────────────────────
 * `ai_runs.created_at` 存 UTC。若按 UTC 日聚合，那么**上海时间每天早上 8 点**
 * 预算就会重置 —— 而日报的目标发布时刻正是 08:00（`docs/00`），
 * 也就是说预算会在最需要它的那个时刻被清零。
 * 所以统一用 `businessDayRangeUtc()` 换算成上海业务日的 UTC 区间。
 *
 * ── 两个刻意的诚实设计 ──────────────────────────────────────────────
 * 1. **成本为 `null` 的 run 不计入总额，但会被单独计数并暴露**
 *    （`uncostedRuns`）。原因见 `pricing.ts`：缺 token 数时估算不出成本。
 *    如果对 `null` 视而不见，预算统计会静默少算，闸门永远不触发 ——
 *    那是最坏的失败形态（看着有预算，实际是一行不生效的配置）。
 *    暴露计数让「有多少消费没被算进去」是可见的。
 * 2. **预算是软闸门**：并发任务可能同时通过检查再各自消费，
 *    因此实际支出可以略微越过上限。它是**安全阀，不是账务**。
 *    要精确拦截需要分布式锁或预留额度，而 `docs/01` 明确
 *    「任何关键业务状态不得只存在 Redis」——为一个软限制引入这份复杂度不划算。
 */

import { businessDateOf, businessDayRangeUtc } from '@signal/config';
import type { AiTaskType } from '@signal/contracts';
import type { AiConfig } from './ai.config';
import type { AiClock } from './clock';
import { aiBudgetExceededError } from './ai.errors';
import { isCriticalTask } from './ai.types';

/** 注入 token。 */
export const AI_SPEND_REPOSITORY = 'AI_SPEND_REPOSITORY';

/** 某段时间内的 AI 支出汇总。 */
export type AiSpendSummary = {
  /** 已计入的成本合计（USD）。 */
  totalUsd: number;
  /**
   * 成本为 `null` 的 run 数量 —— **没有被计入 `totalUsd`**。
   * 大于 0 时说明预算存在盲区，应告警而不是当作 0。
   */
  uncostedRuns: number;
};

export interface AiSpendRepository {
  /** 统计 `[from, to)` 内 `ai_runs.estimated_cost_usd` 的合计。 */
  sumCostUsdBetween(from: Date, to: Date): Promise<AiSpendSummary>;
}

/** 80% 起告警。 */
export const AI_BUDGET_WARNING_RATIO = 0.8;

/** 100% 暂停非关键任务。 */
export const AI_BUDGET_EXCEEDED_RATIO = 1;

export type AiBudgetState = 'OK' | 'WARNING' | 'EXCEEDED';

export type AiBudgetSnapshot = {
  /** 上海业务日 `YYYY-MM-DD`。 */
  businessDate: string;
  spentUsd: number;
  budgetUsd: number;
  /**
   * `spent / budget`。`budgetUsd === 0` 时为 `Infinity`
   * （预算为 0 的字面语义就是「一分钱都不能花」，见下方说明）。
   */
  ratio: number;
  state: AiBudgetState;
  /** 未被计入 `spentUsd` 的 run 数量。 */
  uncostedRuns: number;
};

/**
 * 预算闸门。
 *
 * `AI_DAILY_BUDGET_USD = 0` 的字面语义是「**不允许任何消费**」，
 * 因此除关键任务外全部暂停（`ratio` 为 `Infinity`）。
 * 刻意**不**把 0 解释成「不限量」—— 那会让一个看起来是「关闭预算」的配置
 * 变成「关闭保护」，方向刚好相反。
 */
export class AiBudgetGuard {
  constructor(
    private readonly deps: {
      spend: AiSpendRepository;
      clock: AiClock;
      config: Pick<AiConfig, 'dailyBudgetUsd'>;
    },
  ) {}

  /** 当前业务日的预算快照。 */
  async snapshot(): Promise<AiBudgetSnapshot> {
    const now = this.deps.clock.now();
    const businessDate = businessDateOf(now);
    const { startUtc, endUtc } = businessDayRangeUtc(businessDate);

    const summary = await this.deps.spend.sumCostUsdBetween(startUtc, endUtc);
    const budgetUsd = this.deps.config.dailyBudgetUsd;
    const ratio = budgetUsd === 0 ? Number.POSITIVE_INFINITY : summary.totalUsd / budgetUsd;

    let state: AiBudgetState = 'OK';
    if (ratio >= AI_BUDGET_EXCEEDED_RATIO) {
      state = 'EXCEEDED';
    } else if (ratio >= AI_BUDGET_WARNING_RATIO) {
      state = 'WARNING';
    }

    return {
      businessDate,
      spentUsd: summary.totalUsd,
      budgetUsd,
      ratio,
      state,
      uncostedRuns: summary.uncostedRuns,
    };
  }

  /**
   * 断言该任务现在可以执行；不允许则抛 `AI_BUDGET_EXCEEDED`。
   *
   * 返回快照供调用方记录日志（`state` 为 `WARNING` 时应当告警）。
   */
  async assertCanRun(taskType: AiTaskType): Promise<AiBudgetSnapshot> {
    const snapshot = await this.snapshot();
    if (snapshot.state !== 'EXCEEDED') return snapshot;

    if (isCriticalTask(taskType)) {
      // 关键任务（目前只有 DAILY_DRAFT）在预算耗尽后仍继续 —— docs/08
      // 说的是「非关键任务暂停」，且日报有硬性时刻表（docs/00）。
      return snapshot;
    }

    throw aiBudgetExceededError({
      taskType,
      spentUsd: snapshot.spentUsd,
      budgetUsd: snapshot.budgetUsd,
    });
  }
}
