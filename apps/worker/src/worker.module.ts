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
 * ContentPipelineModule  → new Worker('content-pipeline')   + 60 秒收尾扫描
 * PublishingModule       → new Worker('publishing')         + PublishingScheduler 定时器
 * ```
 *
 * 所以它们**全部**会先问一遍 `shouldStartConsumers()`（`common/consumers.ts`）。
 * 那是本次集成做的**唯一一个跨模块决策** —— 四个模块的文件头都写着
 * 「统一开关应当是 Agent 14 的决策，不要各自发明」，这个文件与那个函数就是答复。
 *
 * 在 `NODE_ENV=test` 下：**消费者与定时器都不启动**，但 provider 照常实例化
 * （`parseEnv()` 仍会跑，缺 env 仍会报错 —— 那是刻意的，见 `consumers.ts` 的边界说明）。
 *
 * ── ⚠ 从这里 import 的是各模块的 `module.ts`，不是它们的 `index.ts` ──
 * `jobs/ai/index.ts` 与 `jobs/content/index.ts` **都 re-export 了同名的**
 * `JOB_RUN_RECORDER` 与 `NoopJobRunRecorder`（两个模块各自的名字，绑定到各自的实现）。
 * 在同一个文件里同时从两个 index import 会撞名，需要 `as` 重命名 ——
 * 直接指到 `module.ts` 就没有这个问题，而且根模块本来也不该依赖业务模块的公开面。
 */

import { Module } from '@nestjs/common';
import { AiWorkerModule } from './jobs/ai/module';
import { CollectorsModule } from './jobs/collectors/module';
import { ContentPipelineModule } from './jobs/content/module';
import { PublishingModule } from './jobs/publishing/module';

@Module({
  imports: [CollectorsModule, AiWorkerModule, ContentPipelineModule, PublishingModule],
  providers: [],
})
export class WorkerModule {}
