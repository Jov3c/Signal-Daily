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
 * `DEAD_LETTER_JOB_RUN_STATUS` 是 `packages/contracts/src/queues.ts` 里冻结的常量，
 * `job_runs` 表由 Agent 01 建好（还专门给 `jobKey` 加了索引）。
 *
 * ⚠ 独立审查指出本模块**完全没有写 `JobRun`**（P3）：ai 队列最终失败的 job
 * 只留下 BullMQ 里的失败记录与一行日志，Agent 11 的运维面板无法按契约
 * 从 `job_runs` 看到 DEAD 的 AI 任务，也就无法「后台人工重试」。
 *
 * ⚠ 与 Agent 04 在 `jobs/collectors/` 里的 JobRun 写入是**两份实现**
 * （同样是 `apps/api` 隔离与模块目录隔离的副产品），
 * 已与其它 worker 侧重复一起记入 CCR 第 2 项。
 *
 * 只记录**终态**（SUCCEEDED / DEAD），不记录每次重试 —— 重试的中间态
 * 由 BullMQ 自己保存，`job_runs` 的用途是回答「这个任务最后怎么样了」。
 */

import type { JobRunStatus } from '@signal/contracts';

/** 注入 token。 */
export const JOB_RUN_RECORDER = 'JOB_RUN_RECORDER';

export type RecordJobRunInput = {
  /** 建议用 `@signal/contracts` 的 `JobName` 取值。 */
  jobType: string;
  /** 幂等键（`JobId.*` 的产物）；无幂等键时为 `null`。 */
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

/**
 * 不记录任何东西的实现。
 *
 * 用在「不需要 JobRun 的场景」（单元测试、或运维决定关掉记录）。
 * **刻意不是默认值** —— 默认必须是真记录，否则就回到了「契约要求了但没人做」
 * 的原始问题。测试显式传入它才算知情选择。
 */
export class NoopJobRunRecorder implements JobRunRecorder {
  async record(): Promise<void> {
    // 有意为空
  }
}
