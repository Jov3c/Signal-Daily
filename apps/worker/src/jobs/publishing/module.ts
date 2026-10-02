/**
 * `PublishingModule` —— 日报草稿生成与定时发布的装配。
 *
 * ⚠ **不要把它挂到 `apps/worker/src/worker.module.ts`** —— 根注册由 Agent 14
 * 统一完成（Agent 00 HANDOFF Integration Notes 第 3 条）。
 *
 * ── 本模块自己启动消费者与调度器 ─────────────────────────────────────
 * 与 `CollectorsModule`（Agent 04）、`AiWorkerModule`（Agent 06）、
 * `ContentPipelineModule`（Agent 05）对齐：`PublishingQueueWorker` 与
 * `PublishingScheduler` 都是本模块的 provider，由 `onModuleInit` 启动、
 * `onModuleDestroy` 关闭 —— **`imports: [PublishingModule]` 这一个动作
 * 就完成了接线**。
 *
 * ⚠ **给 Agent 14 的代价说明**：引用本模块会**真的连 Redis、
 * 起一个 BullMQ 消费者，并开始一个每分钟醒一次的调度器**。
 * 这与另外三个模块行为一致 —— 缺的是一个**统一的**「测试期不启动消费者」
 * 开关，那是对整个 app 的决策，不在本模块里单独发明
 *（Agent 05 / 06 都提过同一点）。
 *
 * 全部外部依赖都是可 override 的 provider token，因此单元测试可以在
 * 没有 MySQL / Redis / 网络的情况下跑完整条生成与发布流程。
 */

import { Inject, Module, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { shouldStartConsumers } from '../../common/consumers';
import { Queue } from 'bullmq';
import { parseEnv } from '@signal/config';
import { createLogger } from '@signal/logger';
import { PUBLISHING_CLOCK, SystemPublishingClock } from './clock';
import {
  PUBLISHING_QUEUE,
  PUBLISHING_QUEUE_CONNECTION,
  BullPublishingEnqueuer,
  publishingConnectionOptions,
} from './enqueuer';
import { PUBLISHING_NOTIFIER } from './notifier';
import { PrismaPublishingNotifier } from './prisma-notifier';
import { PrismaPublishingRepository } from './prisma-publishing.repository';
import {
  PrismaPublishingJobRunRecorder,
  PUBLISHING_JOB_RUN_RECORDER,
} from './prisma-job-run.repository';
import { PublishingPrismaService } from './prisma.service';
import { PUBLISHING_REPOSITORY } from './publishing.repository';
import { PUBLISHING_LOGGER, PublishingService } from './publishing.service';
import { PublishingQueueWorker } from './publishing.worker';
import { PUBLISHING_ENQUEUER, PublishingScheduler } from './scheduler';
import { PUBLISHING_QUEUE_NAME } from './queue-names';
import { PrismaModule } from '../../common/prisma/prisma.module';

/**
 * Redis 连接参数 provider。
 *
 * 抽成常量而不是内联在 `providers` 数组里：`@Module({...})` 装饰器在
 * **类定义时**求值，而 `const` 声明在它之后会落进 TDZ ——
 * 那是一个启动即 `ReferenceError` 的错误，而不是编译期能发现的。
 * （这里踩过一次，所以把顺序固定下来。）
 */
const connectionProvider = {
  provide: PUBLISHING_QUEUE_CONNECTION,
  useFactory: () => publishingConnectionOptions(parseEnv().REDIS_URL),
};

@Module({
  // ⚠ P3-02：不再在本模块 `providers` 里声明 `PublishingPrismaService`
  //（它现在是全局 `WorkerPrismaService` 的别名）。唯一实例由 `@Global()` 的
  // PrismaModule 提供；下面三个 `useFactory` 的 `inject: [PublishingPrismaService]`
  // 通过全局导出解析到同一个对象，所以接线写法一行未改。
  imports: [PrismaModule],
  providers: [
    {
      provide: PUBLISHING_LOGGER,
      useFactory: () => createLogger({ service: 'worker', level: parseEnv().LOG_LEVEL }),
    },
    {
      provide: PUBLISHING_REPOSITORY,
      useFactory: (prisma: PublishingPrismaService) => new PrismaPublishingRepository(prisma),
      inject: [PublishingPrismaService],
    },
    {
      provide: PUBLISHING_NOTIFIER,
      useFactory: (prisma: PublishingPrismaService) => new PrismaPublishingNotifier(prisma),
      inject: [PublishingPrismaService],
    },
    {
      provide: PUBLISHING_JOB_RUN_RECORDER,
      useFactory: (prisma: PublishingPrismaService) => new PrismaPublishingJobRunRecorder(prisma),
      inject: [PublishingPrismaService],
    },
    { provide: PUBLISHING_CLOCK, useClass: SystemPublishingClock },
    connectionProvider,
    {
      // 入队用的 Queue。生命周期与消费者分开：Queue 是「写」端。
      provide: PUBLISHING_QUEUE,
      useFactory: (connection: ReturnType<typeof publishingConnectionOptions>) =>
        new Queue(PUBLISHING_QUEUE_NAME, { connection }),
      inject: [PUBLISHING_QUEUE_CONNECTION],
    },
    {
      provide: PUBLISHING_ENQUEUER,
      useFactory: (queue: Queue) => new BullPublishingEnqueuer(queue),
      inject: [PUBLISHING_QUEUE],
    },
    PublishingService,
    {
      provide: PublishingQueueWorker,
      useFactory: (
        service: PublishingService,
        connection: ReturnType<typeof publishingConnectionOptions>,
        logger: ReturnType<typeof createLogger>,
        recorder: PrismaPublishingJobRunRecorder,
      ) => new PublishingQueueWorker({ service, connection, logger, recorder }),
      inject: [
        PublishingService,
        PUBLISHING_QUEUE_CONNECTION,
        PUBLISHING_LOGGER,
        PUBLISHING_JOB_RUN_RECORDER,
      ],
    },
    PublishingScheduler,
  ],
  exports: [PublishingService, PUBLISHING_REPOSITORY, PUBLISHING_ENQUEUER],
})
export class PublishingModule implements OnModuleInit, OnModuleDestroy {
  constructor(
    @Inject(PublishingQueueWorker) private readonly worker: PublishingQueueWorker,
    @Inject(PUBLISHING_LOGGER) private readonly logger: ReturnType<typeof createLogger>,
  ) {}

  async onModuleInit(): Promise<void> {
    // 测试期不启动消费者。⚠ 这只挡住**本模块的 consumer** ——
    // 调度器是独立 provider，它自己的钩子里也有一道同样的守卫。
    if (!shouldStartConsumers()) return;

    // 调度器自己在 `onModuleInit` 里起定时器（它是 provider）。
    await this.worker.start();
    this.logger.info({}, 'publishing module initialised');
  }

  async onModuleDestroy(): Promise<void> {
    // 调度器的定时器由它自己的 `onModuleDestroy` 清掉（Nest 会调）。
    await this.worker.close();
  }
}
