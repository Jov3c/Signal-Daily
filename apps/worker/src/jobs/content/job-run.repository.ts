/**
 * `JobRunRecorder` 端口 —— `docs/13` 的 Dead Letter 契约。
 *
 * ```text
 * 最终失败：
 *   BullMQ 保留
 *   JobRun = DEAD
 *   后台可重试
 * ```
 *
 * ⚠ 与 Agent 04（`jobs/collectors/`）、Agent 06（`jobs/ai/`）各有一份实现。
 * 这是本仓库的**第 3 份**，已与其它 worker 侧重复一起记入 CCR。
 * 三份的「DEAD 判定口径」必须一致，否则 Agent 11 的运维面板读同一张
 * `job_runs` 表却看到三种语义。
 *
 * 只记录**终态**（SUCCEEDED / DEAD）—— 中间重试由 BullMQ 自己保存，
 * `job_runs` 回答的是「这个任务最后怎么样了」。
 */

import type { JobRunStatus } from '@signal/contracts';

/** 注入 token。 */
export const JOB_RUN_RECORDER = 'JOB_RUN_RECORDER';

export type RecordJobRunInput = {
  /** 用 `@signal/contracts` 的 `JobName` 取值。 */
  jobType: string;
  /** 幂等键（`JobId` 的产物）；无幂等键时为 `null`。 */
  jobKey: string | null;
  status: JobRunStatus;
  startedAt: Date;
  finishedAt: Date;
  /** 含本次在内的累计尝试次数。 */
  attempts: number;
  errorCode: string | null;
  metadata?: Record<string, unknown>;
};

export interface JobRunRecorder {
  record(input: RecordJobRunInput): Promise<void>;
}

/** 不记录任何东西的实现（供不需要 JobRun 的测试显式选用）。 */
export class NoopJobRunRecorder implements JobRunRecorder {
  async record(): Promise<void> {
    // 有意为空
  }
}
