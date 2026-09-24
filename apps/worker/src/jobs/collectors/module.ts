/**
 * CollectorsModule —— Agent 04 的完整交付面。
 *
 * ── ⚠ 不要把它挂进 `worker.module.ts` ───────────────────────────────
 * `docs/18` 与 Agent 00 的 HANDOFF 都写明：
 * **根模块的总注册由 Agent 14 在集成阶段完成**，其他 Agent 不要挂 ——
 * 并行开发时多个 Agent 同时改同一个文件必然冲突。
 *
 * 与 Agent 03 的 `SourcesModule` 完全同一套做法。
 * Agent 14 需要在 `apps/worker/src/worker.module.ts` 里加：
 *
 * ```ts
 * @Module({ imports: [CollectorsModule] })
 * export class WorkerModule {}
 * ```
 *
 * ── 这里装配的依赖 ─────────────────────────────────────────────────
 * 真实的 Prisma / Redis / BullMQ 都挂在端口 token 后面，因此：
 *   - 生产：全部真实实现；
 *   - 测试：`Test.createTestingModule({imports:[CollectorsModule]})`
 *     后 `.overrideProvider(...)` 换成内存替身，**不需要 MySQL / Redis**，
 *     但仍然跑的是真实的 service / scheduler / worker 代码。
 */

import { Module } from '@nestjs/common';
import { createAdapterRegistry } from './adapters';
import { CLOCK, systemClock } from './clock';
import { COLLECTOR_CONFIG, createCollectorConfig } from './collector.config';
import { ADAPTER_REGISTRY, CollectorService } from './collector.service';
import { COLLECTOR_SERVICE, CollectorWorker } from './collector.worker';
import { WORKER_LOGGER, createWorkerLogger } from './logger';
import {
  JOB_RUN_REPOSITORY,
  RAW_ITEM_REPOSITORY,
  SOURCE_FETCH_QUEUE,
  SOURCE_LOCK,
  SOURCE_REPOSITORY,
} from './ports';
import { PrismaCollectorSourceRepository } from './prisma-source.repository';
import { PrismaJobRunRepository } from './prisma-job-run.repository';
import { PrismaRawItemRepository } from './prisma-raw-item.repository';
import { PrismaService } from './prisma.service';
import { SourceScheduler } from './scheduler.service';
import { RedisSourceLock } from './source-lock';
import { BullSourceFetchQueue } from './source-queue';

@Module({
  providers: [
    PrismaService,

    // 配置与基础设施
    { provide: COLLECTOR_CONFIG, useFactory: () => createCollectorConfig() },
    { provide: CLOCK, useValue: systemClock },
    { provide: WORKER_LOGGER, useFactory: () => createWorkerLogger() },

    // 端口 → 真实实现
    { provide: SOURCE_REPOSITORY, useClass: PrismaCollectorSourceRepository },
    { provide: RAW_ITEM_REPOSITORY, useClass: PrismaRawItemRepository },
    { provide: JOB_RUN_REPOSITORY, useClass: PrismaJobRunRepository },
    { provide: SOURCE_LOCK, useClass: RedisSourceLock },
    { provide: SOURCE_FETCH_QUEUE, useClass: BullSourceFetchQueue },

    // 适配器注册表。deps 为空 = 用全局 fetch 与真实 DNS。
    { provide: ADAPTER_REGISTRY, useFactory: () => createAdapterRegistry() },

    // 业务组件
    CollectorService,
    { provide: COLLECTOR_SERVICE, useExisting: CollectorService },
    SourceScheduler,
    CollectorWorker,
  ],
  exports: [CollectorService, SourceScheduler],
})
export class CollectorsModule {}
