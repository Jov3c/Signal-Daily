/**
 * 日报调度器 —— `docs/10` 的「建议调度」。
 *
 * ```text
 * 00:10 初始化当天 DRAFT            -> 入队 publishing.daily-draft（槽 0010）
 * 05:30 生成初始 draft              -> 入队 publishing.daily-draft（槽 0530）
 * 07:00 刷新候选                    -> 入队 publishing.daily-draft（槽 0700）
 * 07:30 未 REVIEWING 则通知管理员    -> **进程内直接做**（不入队）
 * 08:00 只有 SCHEDULED 才发布        -> 入队 publishing.daily-publish（槽 0800）
 * ```
 *
 * ── 为什么是「自己查时间 + 入队」，而不是 BullMQ 的 repeatable job ──────
 * `docs/13` 固定了 10 个 Job 名，里面**没有**「日报调度」这一类；
 * 而 BullMQ 的 repeatable job 本身也是一个 job（会出现在队列里、
 * 有自己的名字）。Agent 04 的采集调度、Agent 05 的收尾扫描、
 * Agent 07 的通知扫描都是同一个取舍：**模块内的定时器 + 入队真正的作业**。
 *
 * ── ⚠ 为什么每 60 秒醒一次而不是「到点才跑」──────────────────────────
 * 两个理由：
 *
 * 1. **停机追赶**。worker 在 05:29 挂了、06:10 起来，
 *    如果是「精确到分的判断」，05:30 那一趟就永远错过了，
 *    而当天就会少一份草稿、并且没有任何信号。
 *    现在的判断是「`now >= 槽位时刻` 且本进程还没处理过这一趟」，
 *    于是起来之后会**补跑**。
 * 2. 追赶是**安全**的：能被补跑的动作都以人的决定为前提
 *   （发布只发 `SCHEDULED`，而 `SCHEDULED` 只能由管理员排期）。
 *    理由详见 `publishing.service.ts` 的文件头。
 *
 * ⚠ **不回溯历史**：只处理**当天**的槽位。停机两天后重启不会补发
 * 中间那两天的日报 —— 日报是当日产品（同见 service 的文件头）。
 *
 * ── 幂等（三处叠加）────────────────────────────────────────────────
 * 1. 进程内的 `handled` 集合（快，但重启就没了）；
 * 2. **JobId**：重启后重复入队会得到同一个 jobId，BullMQ 直接返回已有的 job，
 *    不会第二次执行（`removeOnComplete` 保留 24 小时，覆盖整个业务日）；
 * 3. 提醒那一条走 `notifier.notify()` 的 `(type, targetUrl)` 幂等。
 *
 * 三层里第 2 层是**真正兜底**的，另外两层只是省掉无谓的查询。
 */

import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { businessDateOf, businessTimeToUtc } from '@signal/config';
import type { Logger } from '@signal/logger';
import {
  PUBLISHING_SLOT,
  PUBLISHING_SLOTS_IN_ORDER,
  SLOT_JOB_NAME,
  SLOT_TIME,
  dailyDraftJobId,
  dailyPublishJobId,
  type PublishingJobData,
  type PublishingSlot,
} from './queue';
import { PUBLISHING_CLOCK, type PublishingClock } from './clock';
import { PUBLISHING_LOGGER, PublishingService } from './publishing.service';
import { shouldStartConsumers } from '../../common/consumers';

/** 调度器醒来的间隔。 */
export const SCHEDULER_TICK_INTERVAL_MS = 60_000;

/** 注入 token：入队端口。 */
export const PUBLISHING_ENQUEUER = 'PUBLISHING_ENQUEUER';

/**
 * 入队端口。
 *
 * 抽成接口而不是直接用 `Queue`：调度逻辑（哪些槽位该跑、按什么顺序、
 * 出错怎么不互相影响）是本模块**最需要测试**的部分，而它不需要真 Redis
 * 就能测 —— 给它一个记录调用的替身即可。
 */
export interface PublishingEnqueuer {
  add(jobName: string, data: PublishingJobData, jobId: string): Promise<void>;
}

/** 一个槽位的处置结果。 */
export type SlotOutcome = {
  slot: PublishingSlot;
  action: 'ENQUEUED' | 'DONE_IN_PROCESS' | 'SKIPPED_NOT_DUE' | 'SKIPPED_ALREADY' | 'FAILED';
  detail?: string;
};

export type TickResult = {
  businessDate: string;
  outcomes: SlotOutcome[];
};

@Injectable()
export class PublishingScheduler implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | null = null;

  /** 本进程已经处理过的 `${businessDate}:${slot}`。 */
  private readonly handled = new Set<string>();

  /**
   * ⚠ 全部依赖都用**显式 `@Inject`**（包括 `PublishingService` 这个类 token）。
   *
   * 原因不是风格：不写 `@Inject` 时 Nest 靠 `design:paramtypes` 元数据解析，
   * 而那个元数据要求参数类型在**运行期是个值** —— 一旦有人把 import 改成
   * `import type`（lint 的 `consistent-type-imports` 会诱导这么做），
   * 元数据退化成 `Object`，DI 在运行期**静默失败**。
   * Agent 07 的自查记录里正好有一条「为了让 lint 过把运行时值改成
   * `import type` → 7 条测试全红」，同一个坑。
   */
  constructor(
    @Inject(PUBLISHING_ENQUEUER) private readonly enqueuer: PublishingEnqueuer,
    @Inject(PublishingService) private readonly service: PublishingService,
    @Inject(PUBLISHING_CLOCK) private readonly clock: PublishingClock,
    @Inject(PUBLISHING_LOGGER) private readonly logger: Logger,
  ) {}

  onModuleInit(): void {
    // 测试期不起调度定时器（统一开关见 `common/consumers.ts`）。
    if (!shouldStartConsumers()) return;

    // ⚠ 与 Agent 04 的采集调度不同，这里**不需要分布式锁**：
    // 真正防止重复执行的是 JobId（见文件头第 2 层）。
    // 两个实例同时 tick 只会各自入队一次同一个 jobId，BullMQ 只留一个。
    this.timer = setInterval(() => {
      void this.tick(this.clock.now()).catch((error: unknown) => {
        this.logger.error({ err: error }, 'publishing scheduler tick failed');
      });
    }, SCHEDULER_TICK_INTERVAL_MS);
  }

  onModuleDestroy(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * 跑一次调度判断。
   *
   * **每个槽位独立处置**：一个槽位失败不影响后面的 ——
   * 否则「07:30 的提醒因为某个 bug 抛了」会让 08:00 的发布也一起不发生，
   * 而那是一个没人能理解的失败（提醒是可有可无的，发布不是）。
   */
  async tick(now: Date): Promise<TickResult> {
    const businessDate = businessDateOf(now);
    const outcomes: SlotOutcome[] = [];

    this.pruneHandled(businessDate);

    // 按时间先后处理：05:30 的生成必须在 07:00 的刷新之前入队，
    // 否则队列并发为 1 时它们会按入队顺序执行，而顺序反了会让
    // 「刷新」的结果被「生成」覆盖。
    for (const slot of PUBLISHING_SLOTS_IN_ORDER) {
      outcomes.push(await this.runSlot(businessDate, slot, now));
    }

    return { businessDate, outcomes };
  }

  private async runSlot(
    businessDate: string,
    slot: PublishingSlot,
    now: Date,
  ): Promise<SlotOutcome> {
    const key = `${businessDate}:${slot}`;

    const { hour, minute } = SLOT_TIME[slot];
    const dueAt = businessTimeToUtc(businessDate, hour, minute);
    if (now.getTime() < dueAt.getTime()) {
      return { slot, action: 'SKIPPED_NOT_DUE' };
    }
    if (this.handled.has(key)) {
      return { slot, action: 'SKIPPED_ALREADY' };
    }

    try {
      // `07:30` 那一趟刻意不入队（`docs/13` 没有「日报提醒」这个 Job 名，
      // §6 又禁止创建近义 Job），在进程内直接完成。
      if (slot === PUBLISHING_SLOT.REVIEW_REMINDER) {
        const reminder = await this.service.remindIfNotReviewing(businessDate);
        this.handled.add(key);
        return { slot, action: 'DONE_IN_PROCESS', detail: reminder.reason };
      }

      const jobName = SLOT_JOB_NAME[slot];
      if (jobName === undefined) {
        // 契约表里没有这个槽位对应的 Job —— 说明 `queue.ts` 的两张表不一致。
        // **不要静默跳过**：那会让一个槽位永远不执行且没人知道。
        return { slot, action: 'FAILED', detail: 'no job name registered for this slot' };
      }

      const jobId =
        slot === PUBLISHING_SLOT.PUBLISH
          ? dailyPublishJobId(businessDate, slot)
          : dailyDraftJobId(businessDate, slot);

      await this.enqueuer.add(jobName, { businessDate, slot }, jobId);
      this.handled.add(key);
      return { slot, action: 'ENQUEUED', detail: jobId };
    } catch (error) {
      // 失败**不加入 handled**：下一分钟会重试。
      // 这是刻意的 —— 一次 Redis 抖动不该让当天少一次草稿生成。
      this.logger.error(
        { err: error, businessDate, slot },
        'publishing scheduler slot failed; will retry on the next tick',
      );
      return {
        slot,
        action: 'FAILED',
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * 丢掉非当天的记录。
   *
   * 不做这一步的话，`handled` 会随运行时间无限增长 ——
   * 一个跑了半年的 worker 会攒下 180 天的键。它们是纯字符串、量不大，
   * 但**没有任何用途**（跨天之后槽位不该被复用），留着只是内存泄漏的雏形。
   */
  private pruneHandled(businessDate: string): void {
    const prefix = `${businessDate}:`;
    for (const key of this.handled) {
      if (!key.startsWith(prefix)) this.handled.delete(key);
    }
  }
}

/** 便于测试断言「哪些槽位被处理过」。 */
export function slotKey(businessDate: string, slot: PublishingSlot): string {
  return `${businessDate}:${slot}`;
}
