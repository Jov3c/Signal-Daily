/**
 * `AiWorkerModule` —— AI Job 的装配，**包含消费者的启动**。
 *
 * ⚠ **不要把它挂到 `apps/worker/src/worker.module.ts`** —— 根注册由 Agent 14
 * 统一完成（Agent 00 HANDOFF Integration Notes 第 3 条）。
 *
 * ── 本模块自己启动 ai 队列的消费者（独立审查 P1 的修复）──────────────
 * 第一版只提供了 `AiService` 与仓储，`AiQueueWorker` **只被测试 new 过**，
 * 生产代码里没有任何实例化路径。后果是：即使 Agent 14 按注释
 * `imports: [AiWorkerModule]`，`ai.translate` / `ai.classify-score`
 * 两个 Job 也**没有消费者** —— 入队的 job 会一直躺在 Redis 里，
 * 而 886 项单测 + 21 项集成测试全绿（集成测试自己 new 了一个 worker）。
 *
 * 现在与 Agent 04 的 `CollectorWorker` 对齐：消费者是本模块的 provider，
 * 由 `onModuleInit` 启动、`onModuleDestroy` 关闭 ——
 * 也就是说 **`imports: [AiWorkerModule]` 这一个动作就完成了接线**。
 *
 * ⚠ **给 Agent 14 的代价说明（必须知道）**：
 * 引用本模块会**真的连 Redis 并起一个 BullMQ 消费者**。
 * 因此 `apps/worker/test/boot.spec.ts` 若把 `AiWorkerModule` 纳入
 * `WorkerModule`，在没有 Redis 的机器上会开始刷连接错误
 * （BullMQ 不会同步抛错，而是后台重连）。
 * 这与 `CollectorsModule` 的行为一致 —— 如果要保住「无 Redis 也能跑
 * `pnpm test`」，需要一个**统一的**开关（例如只在 `NODE_ENV !== 'test'`
 * 时启动），那应当是 Agent 14 对一个 app 内所有队列模块的统一决策，
 * 不在本模块里单独发明。
 *
 * 全部外部依赖都是可 override 的 provider token，因此单元测试可以在
 * **没有 MySQL、没有 Redis、没有网络**的情况下直接构造 `AiService`
 * 跑完整条 AI 流水线（本模块的单元测试就是这么做的，不经过 Nest）。
 */

import { Module, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { createLogger } from '@signal/logger';
import { parseEnv } from '@signal/config';
import { AiService, AI_LOGGER } from './ai.service';
import { AI_CONFIG, createAiConfig } from './ai.config';
import { AI_CLOCK, SystemAiClock } from './clock';
import { AI_REPOSITORY } from './ai-run.repository';
import { PrismaAiRepository } from './prisma-ai-run.repository';
import { WorkerPrismaService } from './prisma.service';
import { AI_PROVIDER } from './provider/provider';
import { OpenAiCompatibleProvider } from './provider/openai-compatible.provider';
import { AiQueueWorker } from './ai.worker';
import { AI_QUEUE_CONNECTION, parseRedisConnection } from './connection';
import { JOB_RUN_RECORDER } from './job-run.repository';
import { PrismaJobRunRecorder } from './prisma-job-run.repository';

@Module({
  providers: [
    WorkerPrismaService,
    { provide: AI_CONFIG, useFactory: () => createAiConfig(parseEnv()) },
    { provide: AI_CLOCK, useClass: SystemAiClock },
    {
      provide: AI_LOGGER,
      useFactory: () => createLogger({ service: 'worker', level: parseEnv().LOG_LEVEL }),
    },
    {
      provide: AI_PROVIDER,
      // provider 需要 config 才能构造（baseUrl / key / timeout 都在里面），
      // 所以用 useFactory 显式注入已有的 AI_CONFIG，而不是 useClass 让 Nest 猜。
      useFactory: (config: ReturnType<typeof createAiConfig>) =>
        new OpenAiCompatibleProvider(config),
      inject: [AI_CONFIG],
    },
    { provide: AI_REPOSITORY, useClass: PrismaAiRepository },
    { provide: JOB_RUN_RECORDER, useClass: PrismaJobRunRecorder },
    { provide: AI_QUEUE_CONNECTION, useFactory: () => parseRedisConnection(parseEnv().REDIS_URL) },
    {
      provide: AiQueueWorker,
      useFactory: (
        service: AiService,
        connection: ReturnType<typeof parseRedisConnection>,
        logger: ReturnType<typeof createLogger>,
        recorder: PrismaJobRunRecorder,
      ) => new AiQueueWorker({ service, connection, logger, recorder }),
      inject: [AiService, AI_QUEUE_CONNECTION, AI_LOGGER, JOB_RUN_RECORDER],
    },
    AiService,
  ],
  exports: [AiService, AI_REPOSITORY],
})
export class AiWorkerModule implements OnModuleInit, OnModuleDestroy {
  constructor(private readonly worker: AiQueueWorker) {}

  /** 随模块实例化启动消费者 —— `imports: [AiWorkerModule]` 即完成接线。 */
  async onModuleInit(): Promise<void> {
    await this.worker.start();
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker.close();
  }
}
