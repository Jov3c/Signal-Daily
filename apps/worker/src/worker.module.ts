/**
 * Worker 根模块 — 空壳占位。
 *
 * 所有权说明（`docs/18-multi-agent-coordination.md`）：
 *   Worker 的 Job 总注册由 **Agent 14** 在集成阶段完成。
 *   Agent 00 只建立可启动的空壳。
 *
 *   Job 应放在 `apps/worker/src/jobs/<area>/`，目录划分见 `docs/02`：
 *   collectors / content / ai / publishing / notifications。
 */

import { Module } from '@nestjs/common';

@Module({
  imports: [],
  providers: [],
})
export class WorkerModule {}
