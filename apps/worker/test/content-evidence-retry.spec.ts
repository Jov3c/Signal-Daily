/**
 * `applyEvidencePlan` 的 **P2034 重试**回归守卫。
 *
 * ── 这个文件守的是哪次事故 ────────────────────────────────────────────
 * 2026-10-01，`raw → normalize` 的入口接上之后（见 `08fbb2b`），流水线第一次
 * 被真正喂满：每批 50 条并发跑 `event-cluster`。结果 `applyEvidencePlan` 里的
 * `tx.eventEvidence.createMany()` 开始撞 **Prisma P2034（写冲突 / 死锁）**：
 *
 * ```text
 *   job_runs: content.event-cluster  SUCCEEDED 249 / FAILED 92
 * ```
 *
 * BullMQ 的重试救回了绝大多数，**但有一条（content id=6）三次重试耗尽，
 * 永远停在 `INGESTED`** —— 不进 AI、不进审核队列，那条内容**永久卡死**。
 *
 * 同文件的 `createContentAndAdvance` 早就写了这个重试，而且它的注释里
 * **明确预见了「证据挂接」会参与死锁** —— 只是那个预见没有落成代码。
 *
 * ── 为什么不用真库来测 ────────────────────────────────────────────────
 * 死锁是**概率性**的：靠并发去碰它，只会得到一个偶发红的测试 ——
 * 而偶发红的测试既不能证明修复有效，也不能在回归时稳定报警。
 * 这里用一个受控的假 client，把「第一次抛 P2034、第二次成功」变成**确定性**的。
 *
 * ⚠ **这个文件在修复之前必定是红的**（第一条用例）—— 那正是它的价值。
 */

import { Prisma } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { PrismaContentRepository } from '../src/jobs/content/prisma-content.repository';
import type { EvidencePlan } from '../src/jobs/content/evidence/evidence-plan';

/** 一份「什么都不做」的计划：只验重试行为，不牵扯具体的证据拼装逻辑。 */
const NOOP_PLAN: EvidencePlan = {
  toInsert: [],
  primaryUrlHash: null,
  reassignPrimary: false,
  skippedExistingUrls: 0,
  independentSourceCount: 0,
};

/** 事务里会用到的 tx 方法都补上空实现（`NOOP_PLAN` 不会真的调用它们）。 */
function txStub(): Record<string, unknown> {
  return {
    eventEvidence: {
      updateMany: async () => ({ count: 0 }),
      createMany: async () => ({ count: 0 }),
    },
  };
}

function p2034(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(
    'Transaction failed due to a write conflict or a deadlock. Please retry your transaction',
    { code: 'P2034', clientVersion: '6.19.3' },
  );
}

/** 造一个假 client：按脚本决定第 N 次 `$transaction` 是抛还是跑。 */
function fakeClient(script: ('throw' | 'run')[]): {
  client: Parameters<typeof PrismaContentRepository.forClient>[0];
  calls: () => number;
} {
  let call = 0;
  const client = {
    $transaction: async (fn: (tx: unknown) => Promise<unknown>): Promise<unknown> => {
      const step = script[call] ?? 'run';
      call += 1;
      if (step === 'throw') throw p2034();
      return await fn(txStub());
    },
  };
  return {
    client: client as unknown as Parameters<typeof PrismaContentRepository.forClient>[0],
    calls: () => call,
  };
}

describe('applyEvidencePlan 遇到 P2034 会重试一次', () => {
  it('⚠ 第一次 P2034、第二次成功 → 整体成功（旧实现下这里必红）', async () => {
    const { client, calls } = fakeClient(['throw', 'run']);
    const repository = PrismaContentRepository.forClient(client);

    const result = await repository.applyEvidencePlan('1', NOOP_PLAN);

    expect(result).toEqual({
      inserted: 0,
      primaryUrlHash: null,
      independentSourceCount: 0,
    });
    expect(calls(), '应当恰好重试一次（不是零次，也不是无限次）').toBe(2);
  });

  it('两次都 P2034 → 不再重试，把错误抛上去交给 BullMQ', async () => {
    const { client, calls } = fakeClient(['throw', 'throw']);
    const repository = PrismaContentRepository.forClient(client);

    await expect(repository.applyEvidencePlan('1', NOOP_PLAN)).rejects.toThrow(/deadlock/i);
    // ⚠ 只重试**一次**是有意的：P2034 是瞬时故障，一次通常就够；
    // 持续冲突应当冒上去由 BullMQ 的重试与告警接手，而不是在这里空转。
    expect(calls()).toBe(2);
  });

  it('非 P2034 的错误**不重试**（别把真 bug 当瞬时故障吞掉）', async () => {
    let call = 0;
    const client = {
      $transaction: async (): Promise<unknown> => {
        call += 1;
        throw new Error('some other failure');
      },
    };
    const repository = PrismaContentRepository.forClient(
      client as unknown as Parameters<typeof PrismaContentRepository.forClient>[0],
    );

    await expect(repository.applyEvidencePlan('1', NOOP_PLAN)).rejects.toThrow(
      'some other failure',
    );
    expect(call, '非 P2034 必须原样抛上去，一次都不重试').toBe(1);
  });
});
