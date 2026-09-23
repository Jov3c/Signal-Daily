/**
 * API 根模块 — 空壳占位。
 *
 * 所有权说明（`docs/18-multi-agent-coordination.md`）：
 *   根 AppModule 的总注册由 **Agent 14** 在集成阶段完成。
 *   Agent 00 只建立可启动的空壳，后续 Agent **不要**在这里挂载自己的模块，
 *   以免并行开发时互相冲突。
 *
 *   各模块应把自己的 Module 放在 `apps/api/src/modules/<module>/module.ts`，
 *   由 Agent 14 统一 import 到这里。
 */

import { Module } from '@nestjs/common';

@Module({
  imports: [],
  controllers: [],
  providers: [],
})
export class AppModule {}
