/**
 * 价格表与每日预算闸门的守卫（`docs/08`）。
 *
 * 预算统计的口径是**上海业务日**，不是 UTC 日。最容易写错的地方是
 * 「UTC 16:00 跨日」这条边界 —— 按 UTC 日聚合的话，
 * 上海每天早上 8 点预算就会重置，而日报的目标发布时刻正是 08:00。
 * 下面第一组用例就是钉死这条边界。
 */

import { describe, expect, it } from 'vitest';
import { AiTaskType } from '@signal/contracts';
import {
  AI_BUDGET_EXCEEDED_RATIO,
  AI_BUDGET_WARNING_RATIO,
  AiBudgetGuard,
} from '../src/jobs/ai/budget';
import {
  FALLBACK_MODEL_PRICE,
  MODEL_PRICE_TABLE,
  estimateCostUsd,
  findPrice,
  roundUsd,
} from '../src/jobs/ai/pricing';
import { FakeAiClock, InMemoryAiRepository } from './support/ai-fakes';

function buildGuard(options: {
  now: string;
  dailyBudgetUsd: number;
  spent?: { id: string; usd: number | null; at: string }[];
}): { guard: AiBudgetGuard; clock: FakeAiClock; repository: InMemoryAiRepository } {
  const clock = new FakeAiClock(new Date(options.now));
  const repository = new InMemoryAiRepository();
  for (const run of options.spent ?? []) {
    repository.seedAiRun({
      id: run.id,
      contentId: '1',
      taskType: AiTaskType.SCORE,
      createdAt: new Date(run.at),
      estimatedCostUsd: run.usd,
    });
  }
  const guard = new AiBudgetGuard({
    spend: repository,
    clock,
    config: { dailyBudgetUsd: options.dailyBudgetUsd },
  });
  return { guard, clock, repository };
}

describe('模型价格表', () => {
  it('按最长前缀命中，`gpt-4.1-mini` 不会被 `gpt-4.1` 抢走', () => {
    expect(findPrice('gpt-4.1-mini').matchedKey).toBe('gpt-4.1-mini');
    expect(findPrice('gpt-4.1').matchedKey).toBe('gpt-4.1');
  });

  it('带日期后缀的模型名也能命中', () => {
    expect(findPrice('gpt-4o-mini-2024-07-18').matchedKey).toBe('gpt-4o-mini');
  });

  it('大小写不敏感', () => {
    expect(findPrice('GPT-4O-MINI').matchedKey).toBe('gpt-4o-mini');
  });

  it('未知模型走兜底价，且兜底价不低于表中任何一档（刻意取高）', () => {
    const lookup = findPrice('some-local-llama-3');
    expect(lookup.matchedKey).toBeNull();
    expect(lookup.price).toEqual(FALLBACK_MODEL_PRICE);

    const highestInput = Math.max(
      ...Object.values(MODEL_PRICE_TABLE).map((price) => price.inputPerMillionUsd),
    );
    expect(FALLBACK_MODEL_PRICE.inputPerMillionUsd).toBeGreaterThanOrEqual(highestInput);
  });
});

describe('成本估算', () => {
  it('按 token 数计算并保留 6 位小数（对齐 DECIMAL(12,6)）', () => {
    // gpt-4o-mini: 0.15 / 0.6 每 1M
    const cost = estimateCostUsd({
      model: 'gpt-4o-mini',
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    expect(cost).toBe(0.75);
  });

  it('token 数缺失时返回 null，而**不是 0**', () => {
    // 返回 0 会让预算统计静默少算 —— 这是最坏的失败形态。
    expect(
      estimateCostUsd({ model: 'gpt-4o-mini', inputTokens: null, outputTokens: null }),
    ).toBeNull();
  });

  it('只有一个方向的 token 数时仍能估算', () => {
    expect(
      estimateCostUsd({ model: 'gpt-4o-mini', inputTokens: 1_000_000, outputTokens: null }),
    ).toBe(0.15);
  });

  it('roundUsd 处理浮点尾数', () => {
    expect(roundUsd(0.1 + 0.2)).toBe(0.3);
  });
});

describe('预算闸门 —— 业务日边界', () => {
  it('上海 2026-09-23 23:59 属于业务日 2026-09-23', () => {
    const { guard } = buildGuard({ now: '2026-09-23T15:59:00.000Z', dailyBudgetUsd: 5 });
    return expect(guard.snapshot()).resolves.toMatchObject({ businessDate: '2026-09-23' });
  });

  it('上海 2026-09-24 00:00 属于业务日 2026-09-24（UTC 16:00 跨日）', async () => {
    const { guard } = buildGuard({ now: '2026-09-23T16:00:00.000Z', dailyBudgetUsd: 5 });
    await expect(guard.snapshot()).resolves.toMatchObject({ businessDate: '2026-09-24' });
  });

  it('跨日后的统计不再包含前一业务日的消费', async () => {
    const { guard } = buildGuard({
      now: '2026-09-23T16:00:00.000Z', // 业务日 2026-09-24
      dailyBudgetUsd: 5,
      spent: [
        // 业务日 2026-09-23（UTC 15:00 = 上海 23:00）
        { id: '1', usd: 4.9, at: '2026-09-23T15:00:00.000Z' },
        // 业务日 2026-09-24（UTC 16:30 = 上海 00:30）
        { id: '2', usd: 0.1, at: '2026-09-23T16:30:00.000Z' },
      ],
    });

    const snapshot = await guard.snapshot();
    expect(snapshot.spentUsd).toBeCloseTo(0.1, 6);
    expect(snapshot.state).toBe('OK');
  });
});

describe('预算闸门 —— 80% / 100% 阈值', () => {
  it('低于 80% 是 OK', async () => {
    const { guard } = buildGuard({
      now: '2026-09-24T02:00:00.000Z',
      dailyBudgetUsd: 5,
      spent: [{ id: '1', usd: 3.99, at: '2026-09-24T01:00:00.000Z' }],
    });
    await expect(guard.snapshot()).resolves.toMatchObject({ state: 'OK' });
  });

  it('恰好 80% 进入 WARNING', async () => {
    const { guard } = buildGuard({
      now: '2026-09-24T02:00:00.000Z',
      dailyBudgetUsd: 5,
      spent: [{ id: '1', usd: 4, at: '2026-09-24T01:00:00.000Z' }],
    });
    const snapshot = await guard.snapshot();
    expect(snapshot.state).toBe('WARNING');
    expect(snapshot.ratio).toBe(AI_BUDGET_WARNING_RATIO);
  });

  it('WARNING 时非关键任务仍然可以跑（只是告警）', async () => {
    const { guard } = buildGuard({
      now: '2026-09-24T02:00:00.000Z',
      dailyBudgetUsd: 5,
      spent: [{ id: '1', usd: 4.5, at: '2026-09-24T01:00:00.000Z' }],
    });
    await expect(guard.assertCanRun(AiTaskType.SCORE)).resolves.toMatchObject({
      state: 'WARNING',
    });
  });

  it('恰好 100% 进入 EXCEEDED，非关键任务被拒', async () => {
    const { guard } = buildGuard({
      now: '2026-09-24T02:00:00.000Z',
      dailyBudgetUsd: 5,
      spent: [{ id: '1', usd: 5, at: '2026-09-24T01:00:00.000Z' }],
    });
    const snapshot = await guard.snapshot();
    expect(snapshot.ratio).toBe(AI_BUDGET_EXCEEDED_RATIO);
    expect(snapshot.state).toBe('EXCEEDED');

    await expect(guard.assertCanRun(AiTaskType.SCORE)).rejects.toMatchObject({
      kind: 'BUDGET_EXCEEDED',
      code: 'AI_BUDGET_EXCEEDED',
    });
  });

  it('EXCEEDED 时关键任务（DAILY_DRAFT）仍然可以跑', async () => {
    const { guard } = buildGuard({
      now: '2026-09-24T02:00:00.000Z',
      dailyBudgetUsd: 5,
      spent: [{ id: '1', usd: 99, at: '2026-09-24T01:00:00.000Z' }],
    });
    await expect(guard.assertCanRun(AiTaskType.DAILY_DRAFT)).resolves.toMatchObject({
      state: 'EXCEEDED',
    });
  });

  it('预算为 0 的字面语义是「一分钱都不能花」，不是「不限量」', async () => {
    const { guard } = buildGuard({
      now: '2026-09-24T02:00:00.000Z',
      dailyBudgetUsd: 0,
      spent: [],
    });
    const snapshot = await guard.snapshot();
    expect(snapshot.state).toBe('EXCEEDED');
    expect(snapshot.ratio).toBe(Number.POSITIVE_INFINITY);
    await expect(guard.assertCanRun(AiTaskType.SCORE)).rejects.toMatchObject({
      kind: 'BUDGET_EXCEEDED',
    });
  });

  it('未计价的 run 不计入合计，但会被单独暴露出来', async () => {
    const { guard } = buildGuard({
      now: '2026-09-24T02:00:00.000Z',
      dailyBudgetUsd: 5,
      spent: [
        { id: '1', usd: 4, at: '2026-09-24T01:00:00.000Z' },
        // 三条拿不到 token 数的调用 —— 它们的花费是未知的
        { id: '2', usd: null, at: '2026-09-24T01:01:00.000Z' },
        { id: '3', usd: null, at: '2026-09-24T01:02:00.000Z' },
        { id: '4', usd: null, at: '2026-09-24T01:03:00.000Z' },
      ],
    });

    const snapshot = await guard.snapshot();
    expect(snapshot.spentUsd).toBe(4);
    expect(snapshot.uncostedRuns).toBe(3);
    // 合计没有把 null 当 0 悄悄吞掉 —— 它被单独计数，因此可见
    expect(snapshot.state).toBe('WARNING');
  });
});
