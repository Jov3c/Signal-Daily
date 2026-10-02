/**
 * Worker 根模块 —— **Agent 14 在集成阶段完成总注册**（`docs/18`）。
 *
 * ```text
 * collectors  采集（RSS / X / GitHub / HN / HF）+ 调度
 * ai          AI 评分 / 翻译 / 分类
 * content     内容流水线（归一化 → 事件聚类 → 审核队列）+ 收尾扫描
 * publishing  精选与日报的发布编排 + 调度
 * ```
 *
 * ── ⚠ 挂这四个模块 = 启动四个消费者与两个调度定时器 ────────────────
 *
 * ```text
 * CollectorsModule       → new Worker('collector')          + SourceScheduler（OnApplicationBootstrap 起定时器）
 * AiWorkerModule         → new Worker('ai')
 * ContentPipelineModule  → new Worker('content-pipeline')   + 60 秒 normalize 兜底扫描 + 60 秒收尾扫描
 * PublishingModule       → new Worker('publishing')         + PublishingScheduler 定时器
 * ```
 *
 * ⚠ `CollectorsModule` 自己 `imports` 了 `ContentPipelineModule`（采集器要把
 * 新写入的 RawItem 交给 `content.normalize`，见那边的说明）—— 这里再 import
 * 一次是**同一个模块实例**，Nest 会去重，不会起第二个消费者或第二个定时器。
 *
 * 所以它们**全部**会先问一遍 `shouldStartConsumers()`（`common/consumers.ts`）。
 * 那是本次集成做的**唯一一个跨模块决策** —— 四个模块的文件头都写着
 * 「统一开关应当是 Agent 14 的决策，不要各自发明」，这个文件与那个函数就是答复。
 *
 * 在 `NODE_ENV=test` 下：**消费者与定时器都不启动**，但 provider 照常实例化
 * （`parseEnv()` 仍会跑，缺 env 仍会报错 —— 那是刻意的，见 `consumers.ts` 的边界说明）。
 *
 * ── ⚠ 从这里 import 的是各模块的 `module.ts`，不是它们的 `index.ts` ──
 * 根模块本来就不该依赖业务模块的公开面（公开面是给同层下游用的）。
 *
 * 顺带记一笔历史：`jobs/ai/index.ts` 与 `jobs/content/index.ts` 曾经**都**
 * re-export 同名的 `JOB_RUN_RECORDER` 与 `NoopJobRunRecorder`，各自绑定到
 * 各自的实现 —— 在同一个文件里同时从两个 index import 会撞名。
 * P3-02 收敛时已按本仓库既有约定（`jobs/publishing` 的
 * `PUBLISHING_JOB_RUN_RECORDER`）把两者改成**模块限定名**
 *（`AI_JOB_RUN_RECORDER` / `CONTENT_JOB_RUN_RECORDER`，以及
 * `AiNoopJobRunRecorder` / `ContentNoopJobRunRecorder`），撞名的名字不再存在。
 *
 * ── 数据库连接的所有权（P3-02）─────────────────────────────────────
 * 四个模块不再各自持有 `PrismaClient`：唯一实例由 `@Global()` 的
 * `PrismaModule`（`src/common/prisma/`）提供，`imports` 里显式列出是为了
 * 让「根模块的依赖图里确实有这个 provider」一眼可见（四个 Job 模块自己也
 * import 了它，Nest 会去重，不会产生第二个连接池）。
 */

import { Module } from '@nestjs/common';
import { PrismaModule } from './common/prisma/prisma.module';
import { AiWorkerModule } from './jobs/ai/module';
import { CollectorsModule } from './jobs/collectors/module';
import { ContentPipelineModule } from './jobs/content/module';
import { PublishingModule } from './jobs/publishing/module';

@Module({
  imports: [
    PrismaModule,
    CollectorsModule,
    AiWorkerModule,
    ContentPipelineModule,
    PublishingModule,
  ],
  providers: [],
})
export class WorkerModule {}
