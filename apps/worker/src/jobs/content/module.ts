/**
 * `ContentPipelineModule` —— Pipeline（Normalize 阶段）的装配。
 *
 * ⚠ **不要把它挂到 `apps/worker/src/worker.module.ts`** —— 根注册由 Agent 14
 * 统一完成（Agent 00 HANDOFF Integration Notes 第 3 条）。
 *
 * ── 本模块自己启动消费者 ────────────────────────────────────────────
 * 与 Agent 04 的 `CollectorsModule`、Agent 06 的 `AiWorkerModule` 对齐：
 * `ContentPipelineWorker` 是本模块的 provider，由 `onModuleInit` 启动、
 * `onModuleDestroy` 关闭 —— **`imports: [ContentPipelineModule]` 这一个动作
 * 就完成了接线**（消费 `content-pipeline` 队列 + 两个兜底扫描定时器：
 * 入口的 `sweepForNormalize` 与收尾的 `sweepForReview`）。
 *
 * > Agent 06 的独立审查在那里发现过「`AiQueueWorker` 只被测试 new 过、
 * > 生产代码没有实例化路径」，于是即使 Agent 14 挂了模块也没有消费者。
 * > 这里从一开始就按自启动写。
 *
 * ⚠ **给 Agent 14 的代价说明**：引用本模块会**真的连 Redis 并起一个
 * BullMQ 消费者**。因此 `apps/worker/test/boot.spec.ts` 若把它纳入
 * `WorkerModule`，在没有 Redis 的机器上会开始刷连接错误
 *（BullMQ 不同步抛错，而是后台重连）。这与 `CollectorsModule` /
 * `AiWorkerModule` 行为一致 —— 需要一个**统一的**测试期开关，
 * 那是对整个 app 的决策，不在本模块里单独发明。
 *
 * 全部外部依赖都是可 override 的 provider token，因此单元测试可以在
 * 没有 MySQL / Redis / 网络的情况下直接构造 `ContentService`
 * 跑完整条 Normalize 流程。
 */

import { Inject, Module, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { shouldStartConsumers } from '../../common/consumers';
import { Queue } from 'bullmq';
import { createLogger } from '@signal/logger';
import { parseEnv } from '@signal/config';
import { ContentService, CONTENT_CLOCK, CONTENT_LOGGER } from './content.service';
import { BullContentEnqueuer, CONTENT_ENQUEUER } from './content-enqueuer';
import { ContentPipelineWorker } from './content.worker';
import { CONTENT_QUEUE_CONNECTION, parseRedisConnection } from './connection';
import { CONTENT_PIPELINE_QUEUE_NAME } from './queue-names';
import { AI_QUEUE_NAME } from '../ai';

/**
 * 收尾扫描的间隔。
 *
 * 取 60 秒：AI 作业本身是秒级的，而这个扫描是**兜底**而不是主路径 ——
 * 它的作用是「把 AI 已跑完的内容收进审核队列」，管理员刷新后台时最多晚
 * 一分钟看到新候选，完全可接受；更密的轮询只是白烧数据库查询。
 */
export const REVIEW_SWEEP_INTERVAL_MS = 60_000;

/**
 * 入口兜底扫描的间隔。
 *
 * 取 60 秒，与收尾扫描同一档。这一条是**兜底**：正常路径是采集器存完
 * RawItem 后立刻入队（低延迟），扫描只负责补「那次入队没发生」或
 * 「入口补上之前的历史积压」。管理员感知不到它 —— 晚一分钟处理几条
 * 积压数据完全可接受，更密的轮询只是白烧数据库查询。
 *
 * ⚠ 已知代价：`raw_items` 上没有 `status` 索引，`findRawItemsAwaitingNormalize`
 * 会走一次全表扫（外加到 `contents` 的反向一对一 join）。V1 的数据量
 * （每来源每轮最多几十条）下这不是问题，但库长大之后应该给 `status` 加索引 ——
 * 那要改 `prisma/schema.prisma`（Agent 01 独占），已记入 HANDOFF，不在本次改动里。
 */
export const NORMALIZE_SWEEP_INTERVAL_MS = 60_000;

/** 注入 token：入队用的 BullMQ `Queue`（content-pipeline）。 */
export const CONTENT_QUEUE = 'CONTENT_QUEUE';

/** 注入 token：入队用的 BullMQ `Queue`（ai）。 */
export const AI_QUEUE = 'AI_QUEUE';
import { CONTENT_REPOSITORY } from './ports';
import { PrismaContentRepository } from './prisma-content.repository';
import { ContentPrismaService } from './prisma.service';
import { JOB_RUN_RECORDER } from './job-run.repository';
import { PrismaJobRunRecorder } from './prisma-job-run.repository';

@Module({
  providers: [
    ContentPrismaService,
    {
      provide: CONTENT_LOGGER,
      useFactory: () => createLogger({ service: 'worker', level: parseEnv().LOG_LEVEL }),
    },
    { provide: CONTENT_REPOSITORY, useClass: PrismaContentRepository },
    { provide: JOB_RUN_RECORDER, useClass: PrismaJobRunRecorder },
    { provide: CONTENT_CLOCK, useFactory: () => ({ now: () => new Date() }) },
    {
      provide: CONTENT_QUEUE_CONNECTION,
      useFactory: () => parseRedisConnection(parseEnv().REDIS_URL),
    },
    {
      // 入队用的 Queue。生命周期与消费者分开：Queue 是「写」端，
      // 不需要在 onModuleDestroy 里额外处理（BullMQ 会随连接一起关）。
      provide: CONTENT_QUEUE,
      useFactory: (connection: ReturnType<typeof parseRedisConnection>) =>
        new Queue(CONTENT_PIPELINE_QUEUE_NAME, { connection }),
      inject: [CONTENT_QUEUE_CONNECTION],
    },
    {
      // `ai` 队列（Agent 06 的作业）。本模块只**写**它，不消费。
      provide: AI_QUEUE,
      useFactory: (connection: ReturnType<typeof parseRedisConnection>) =>
        new Queue(AI_QUEUE_NAME, { connection }),
      inject: [CONTENT_QUEUE_CONNECTION],
    },
    {
      provide: CONTENT_ENQUEUER,
      useFactory: (queue: Queue, aiQueue: Queue) => new BullContentEnqueuer(queue, aiQueue),
      inject: [CONTENT_QUEUE, AI_QUEUE],
    },
    {
      provide: ContentPipelineWorker,
      useFactory: (
        service: ContentService,
        connection: ReturnType<typeof parseRedisConnection>,
        logger: ReturnType<typeof createLogger>,
        recorder: PrismaJobRunRecorder,
      ) => new ContentPipelineWorker({ service, connection, logger, recorder }),
      inject: [ContentService, CONTENT_QUEUE_CONNECTION, CONTENT_LOGGER, JOB_RUN_RECORDER],
    },
    ContentService,
  ],
  exports: [ContentService, CONTENT_REPOSITORY, CONTENT_ENQUEUER],
})
export class ContentPipelineModule implements OnModuleInit, OnModuleDestroy {
  private sweepTimer: NodeJS.Timeout | null = null;
  private normalizeSweepTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly worker: ContentPipelineWorker,
    private readonly service: ContentService,
    @Inject(CONTENT_LOGGER) private readonly logger: ReturnType<typeof createLogger>,
  ) {}

  async onModuleInit(): Promise<void> {
    // 测试期不启动消费者 **与收尾扫描定时器** —— 两个都在这个方法里。
    if (!shouldStartConsumers()) return;

    await this.worker.start();

    // ── 入口兜底扫描（raw → normalize）────────────────────────────
    // 主入口在采集器那边（`CollectorService.enqueueForPipeline`）：存完
    // RawItem 立刻入队，低延迟。这里只负责补「那次入队没发生」的情况，
    // 以及本入口补上之前已经积压在 `FETCHED` 的历史数据。
    //
    // 与下面的收尾扫描同一套理由：用 `setInterval` 轮询而不是 BullMQ
    // repeatable job（`docs/13` 的 Job 清单里没有这一类），也**不加分布式锁** ——
    // `sweepForNormalize` 幂等：同一条 raw item 重复入队会被
    // `normalizeJobId` 去重，两个实例同时跑没有副作用。
    this.normalizeSweepTimer = setInterval(() => {
      void this.service
        .sweepForNormalize()
        .catch((error: unknown) => this.logger.error({ err: error }, 'normalize sweep failed'));
    }, NORMALIZE_SWEEP_INTERVAL_MS);

    // ── 收尾扫描 ──────────────────────────────────────────────────
    // `docs/13` 固定了 10 个 Job 名，content-pipeline 只有三个，
    // **没有「AI 完成」这一类**；而 Agent 06 的作业在 `ai` 队列上、
    // 跑完不会回调本模块。所以用**轮询**把「AI 已跑完」的内容收进审核队列
    //（见 `ContentService.sweepForReview` 的说明）。
    //
    // ⚠ 刻意**不加分布式锁**：`sweepForReview` 是幂等的
    //（`finalizeForReview` 内部用 upsert，且只挑「还没有审核行」的内容），
    // 两个实例同时跑只会重复一次相等的写，不会产生第二行。
    // Agent 04 的调度器需要锁是因为「双抓取」不是幂等的 —— 这里情况不同。
    // 与 Agent 04 一致：不用 BullMQ repeatable job（`docs/13` 没有这个 Job 名）。
    this.sweepTimer = setInterval(() => {
      void this.service
        .sweepForReview()
        .catch((error: unknown) => this.logger.error({ err: error }, 'review sweep failed'));
    }, REVIEW_SWEEP_INTERVAL_MS);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.normalizeSweepTimer !== null) clearInterval(this.normalizeSweepTimer);
    this.normalizeSweepTimer = null;
    if (this.sweepTimer !== null) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
    await this.worker.close();
  }
}
