/**
 * `collector` 队列的消费端（BullMQ Worker）。
 *
 * ── 这里唯一的职责是「把结论翻译成 BullMQ 的语义」 ───────────────────
 * 真正的判断都在 `CollectorService.runCollect()`（它返回显式结论）。
 * 本文件只做三件事：
 *
 *   1. **校验载荷**。载荷来自 Redis —— 可能被手工改过、可能是旧版本
 *      写进去的。`sourceId` 不是数字串、`trigger` 不是那两个取值，
 *      都必须当场变成一条**不可重试**的失败，而不是让
 *      `BigInt('abc')` 或一句 `undefined` 在几十行之后炸开。
 *   2. **可重试 → 抛错**（BullMQ 按 `COLLECTOR_RETRY` 重试 3 次）；
 *      **不可重试 → `UnrecoverableError`**（立刻终止，不烧完 3 次尝试）。
 *   3. 并发度取契约的 `QUEUE_CONCURRENCY[collector] = 5`（`docs/13`）。
 *
 * ── 为什么必须区分可重试与不可重试 ──────────────────────────────────
 * 「X 的令牌没配」重试 3 次毫无意义：它不会自己变好，只是把失败
 * 延迟 15 秒，并在日志里留下三条一模一样的记录 —— 真正的问题会被淹掉。
 * 而「上游 502」恰恰相反，重试通常就好了。
 * 这个区分现在就写在 `CollectorError.retryable` 上（见 `errors.ts`）。
 */

import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { UnrecoverableError, Worker, type Job } from 'bullmq';
import { QUEUE_CONCURRENCY, QueueName } from '@signal/contracts';
import { serializeError, type Logger } from '@signal/logger';
import { COLLECTOR_CONFIG, type CollectorConfig } from './collector.config';
import { ADAPTER_REGISTRY, type CollectOutcome, type CollectorService } from './collector.service';
import { WORKER_LOGGER } from './logger';
import type { CollectorFetchSourcePayload } from './ports';
import { redisConnectionOptions } from './redis';

/** 注入 token。 */
export const COLLECTOR_SERVICE = 'COLLECTOR_SERVICE';
export const COLLECTOR_ADAPTER_REGISTRY = ADAPTER_REGISTRY;

/** 载荷里的 `sourceId` 形状（BIGINT 的十进制表示）。 */
const SOURCE_ID_PATTERN = /^\d{1,20}$/;

const TRIGGERS: readonly string[] = ['manual', 'schedule'];

/**
 * 载荷校验失败时写进日志 / 抛给 BullMQ 的**标签**。
 *
 * ⚠ 刻意用 kebab-case 而不是 `DOMAIN_REASON`：它**不是**契约里的业务错误码
 * （不会进库、不会被 API 返回），但如果长得像，就会诱导 Agent 11 的告警规则
 * 或 Agent 12 的后台把它当成业务码去匹配。形状本身是一道防线。
 */
export const MALFORMED_PAYLOAD_LABEL = 'malformed-collector-payload';

@Injectable()
export class CollectorWorker implements OnModuleInit, OnModuleDestroy {
  private worker: Worker<CollectorFetchSourcePayload> | null = null;

  constructor(
    @Inject(COLLECTOR_CONFIG) private readonly config: CollectorConfig,
    @Inject(COLLECTOR_SERVICE) private readonly service: CollectorService,
    @Inject(WORKER_LOGGER) private readonly logger: Logger,
  ) {}

  onModuleInit(): void {
    this.worker = new Worker<CollectorFetchSourcePayload>(
      QueueName.COLLECTOR,
      (job) => this.handle(job),
      {
        connection: redisConnectionOptions(this.config.redisUrl),
        concurrency: QUEUE_CONCURRENCY[QueueName.COLLECTOR],
      },
    );

    this.worker.on('failed', (job, error) => {
      // `docs/15` 的告警项里有「Source 连续失败」，这里给出可聚合的结构化日志。
      this.logger.error(
        {
          jobId: job?.id,
          sourceId: readSourceId(job?.data),
          attemptsMade: job?.attemptsMade,
          err: serializeError(error),
        },
        'collector job failed',
      );
    });

    this.worker.on('error', (error) => {
      // 不监听 'error' 会让 ioredis 的连接错误变成未捕获异常，直接结束进程。
      this.logger.error({ err: serializeError(error) }, 'collector worker error');
    });

    this.logger.info(
      { queue: QueueName.COLLECTOR, concurrency: QUEUE_CONCURRENCY[QueueName.COLLECTOR] },
      'collector worker started',
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    this.worker = null;
  }

  /** 处理一个任务。公开出来是为了让测试可以直接喂一个假 `Job`。 */
  async handle(job: Job<CollectorFetchSourcePayload>): Promise<CollectOutcome> {
    const payload = parsePayload(job.data);
    if (payload === null) {
      // 不可重试：同一个坏载荷重试三次还是坏的。
      // 这里**不写库**（连 sourceId 都可能没有），只记一条日志。
      this.logger.error(
        { jobId: job.id, label: MALFORMED_PAYLOAD_LABEL, payload: describePayload(job.data) },
        'collector job payload is invalid',
      );
      throw new UnrecoverableError(`${MALFORMED_PAYLOAD_LABEL}: malformed collector job payload`);
    }

    const attempt = (job.attemptsMade ?? 0) + 1;
    const maxAttempts = job.opts?.attempts ?? 1;
    const outcome = await this.service.runCollect(payload, {
      attempt,
      isFinalAttempt: attempt >= maxAttempts,
    });

    if (outcome.status !== 'failed') return outcome;

    // 可重试 → 抛普通错误，BullMQ 按 COLLECTOR_RETRY 退避重试；
    // 不可重试 → UnrecoverableError，BullMQ 立刻停止重试。
    if (outcome.retryable) {
      throw new Error(`${outcome.errorCode}: ${outcome.message}`);
    }
    throw new UnrecoverableError(`${outcome.errorCode}: ${outcome.message}`);
  }
}

/**
 * 校验载荷。合法返回归一化后的对象，否则 null。
 *
 * 归一化的意义：`requestedAt` 缺失时**补一个**（它只用于日志与排查，
 * 不参与任何判断），而不是因为缺一个非关键字段就把整个任务判死。
 * 反过来 `sourceId` 与 `trigger` 缺失或不合法就是真的没法处理。
 */
export function parsePayload(raw: unknown): CollectorFetchSourcePayload | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const record = raw as Record<string, unknown>;

  const sourceId = record['sourceId'];
  if (typeof sourceId !== 'string' || !SOURCE_ID_PATTERN.test(sourceId)) return null;

  const trigger = record['trigger'];
  if (typeof trigger !== 'string' || !TRIGGERS.includes(trigger)) return null;

  const requestedAt = record['requestedAt'];
  return {
    sourceId,
    trigger: trigger as CollectorFetchSourcePayload['trigger'],
    requestedAt:
      typeof requestedAt === 'string' && !Number.isNaN(new Date(requestedAt).getTime())
        ? requestedAt
        : new Date().toISOString(),
  };
}

function readSourceId(data: unknown): string | null {
  return typeof data === 'object' && data !== null
    ? (((data as Record<string, unknown>)['sourceId'] as string | undefined) ?? null)
    : null;
}

/** 只用来记日志，**不回显任何可能是凭据的内容**（载荷里本来也没有）。 */
function describePayload(data: unknown): Record<string, unknown> | null {
  return typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : null;
}
