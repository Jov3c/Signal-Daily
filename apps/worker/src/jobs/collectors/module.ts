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
 *
 * ⚠ 本模块 imports 了 `ContentPipelineModule`（把新写入的 RawItem 交给
 * `content.normalize`，见 `@Module` 装饰器上的说明）。这让「单独编译本模块」
 * 不再与内容模块无关：DI 守卫测试要连它的基础设施 provider 一起 override。
 */

import { Module } from '@nestjs/common';
import { createAdapterRegistry } from './adapters';
import { CLOCK, systemClock } from './clock';
import { COLLECTOR_CONFIG, createCollectorConfig, type CollectorConfig } from './collector.config';
import { ADAPTER_REGISTRY, CollectorService } from './collector.service';
import { COLLECTOR_SERVICE, CollectorWorker } from './collector.worker';
import { WORKER_LOGGER, createWorkerLogger } from './logger';
import {
  JOB_RUN_REPOSITORY,
  NORMALIZE_ENQUEUER,
  RAW_ITEM_REPOSITORY,
  SOURCE_FETCH_QUEUE,
  SOURCE_LOCK,
  SOURCE_REPOSITORY,
} from './ports';
import { ContentPipelineModule } from '../content/module';
import { CONTENT_ENQUEUER } from '../content/content-enqueuer';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaCollectorSourceRepository } from './prisma-source.repository';
import { PrismaJobRunRepository } from './prisma-job-run.repository';
import { PrismaRawItemRepository } from './prisma-raw-item.repository';
import { SourceScheduler } from './scheduler.service';
import { RedisSourceLock } from './source-lock';
import { BullSourceFetchQueue } from './source-queue';

@Module({
  // ── 为什么 imports 里是 ContentPipelineModule ─────────────────────────
  // 采集器存完 RawItem 之后要把它们交给 `content.normalize`（否则流水线
  // 永远停在 raw → 见 `ports.ts` 的 `NormalizeEnqueuer`）。那个模块已经
  // `exports: [ContentService, CONTENT_REPOSITORY, CONTENT_ENQUEUER]`，
  // 所以这里 import 一次、再用 `useExisting` 把它的 `CONTENT_ENQUEUER`
  // 接到采集器自己的窄端口上即可（下一项的 provider）。
  //
  // 依赖方向是**单向**的（collectors → content）；`ContentPipelineModule`
  // 的 `imports` 是空数组，不存在环。重复 import 无害：Nest 对同一个模块类
  // 只建一个实例，`worker.module.ts` 里那份与这里那份是同一个。
  //
  // ⚠ 代价：单独 `Test.createTestingModule({imports:[CollectorsModule]})`
  // 现在会一起实例化内容模块的 provider（含 `parseEnv()` 与两个 BullMQ
  // `Queue` 工厂）。`NODE_ENV=test` 只关闭**消费者与定时器**，不阻止
  // provider 实例化 —— 所以 DI 守卫测试需要额外 override 这些 provider，
  // 理由与 `collectors-di-wiring.spec.ts` 顶上写的一样。
  //
  // ⚠ P3-02：这里还 import 了 `PrismaModule`。它是 `@Global()` 的，但**仍要
  // 被 import 进依赖图才生效**；本模块的 DI 守卫测试是单独编译本模块的，
  // 所以不能只靠根模块 import。`PrismaService` 现在是 `WorkerPrismaService`
  // 的别名（同一个 token），不再在本模块 `providers` 里重复声明。
  imports: [ContentPipelineModule, PrismaModule],
  providers: [
    // 采集器的窄端口 → 内容模块的入队实现。
    // `useExisting` 而不是 `useClass`：不需要第二个 `BullContentEnqueuer`
    // 实例（它持有两个 Queue），同一个对象在两个 token 下可见即可。
    { provide: NORMALIZE_ENQUEUER, useExisting: CONTENT_ENQUEUER },

    // 配置与基础设施
    { provide: COLLECTOR_CONFIG, useFactory: () => createCollectorConfig() },
    { provide: CLOCK, useValue: systemClock },
    { provide: WORKER_LOGGER, useFactory: () => createWorkerLogger() },

    // 端口 → 真实实现
    { provide: SOURCE_REPOSITORY, useClass: PrismaCollectorSourceRepository },
    { provide: RAW_ITEM_REPOSITORY, useClass: PrismaRawItemRepository },
    { provide: JOB_RUN_REPOSITORY, useClass: PrismaJobRunRepository },
    { provide: SOURCE_LOCK, useClass: RedisSourceLock },
    // ⚠ 用 `useFactory` 而不是 `useClass` —— 这不是风格问题。
    //
    // `BullSourceFetchQueue` 的构造函数是
    //   `(@Inject(COLLECTOR_CONFIG) config, queueName: string = QueueName.COLLECTOR)`。
    // 第二个参数**有默认值、没有 `@Inject`**（它存在只为了让测试能用一个
    // 自己的队列名，见那里的注释）。但 `useClass` 会让 Nest 去**解析它** ——
    // token 是 `design:paramtypes` 里的 `String`，于是启动时炸：
    //
    //   Nest can't resolve dependencies of the BullSourceFetchQueue
    //   (COLLECTOR_CONFIG, ?). The argument String at index [1] is not available.
    //
    // **而全部单测与集成测试都是绿的** —— 因为 `String` 这个元数据来自
    // `tsc` 的产物，测试跑的是另一套 transform。也就是说：dist 崩、测试绿，
    // 挂进根模块才暴露（Agent 08 那条教训的又一次复发）。
    //
    // `useFactory` 完全绕开参数元数据 —— 默认值由 JS 自己生效。
    {
      provide: SOURCE_FETCH_QUEUE,
      useFactory: (config: CollectorConfig) => new BullSourceFetchQueue(config),
      inject: [COLLECTOR_CONFIG],
    },

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
