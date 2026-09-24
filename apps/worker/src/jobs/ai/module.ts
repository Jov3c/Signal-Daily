/**
 * `AiWorkerModule` —— AI Job 的装配。
 *
 * ⚠ **不要把它挂到 `apps/worker/src/worker.module.ts`** —— 根注册由 Agent 14
 * 统一完成（Agent 00 HANDOFF Integration Notes 第 3 条）。
 * 下游若要复用 `AiService`，在自己模块里 `imports: [AiWorkerModule]` 即可。
 *
 * 全部外部依赖都是可 override 的 provider token，因此单元测试可以在
 * **没有 MySQL、没有 Redis、没有网络**的情况下跑完整条 AI 流水线。
 * 唯一的例外是 `PrismaAiRepository` 背后的 `WorkerPrismaService` ——
 * 它被 override 成内存替身时不会真的连库（Prisma 客户端是惰性连接的）。
 */

import { Module } from '@nestjs/common';
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
    AiService,
  ],
  exports: [AiService, AI_REPOSITORY],
})
export class AiWorkerModule {}
