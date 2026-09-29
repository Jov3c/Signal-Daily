/**
 * Pipeline 的出队/入队端口 —— 把各阶段串成一条链。
 *
 * ```text
 * collector.fetch-source
 *   → content.normalize   （S1/S2：清洗 + 提取 + 精确判重）
 *   → content.dedup       （S3：近似判重候选）
 *   → content.event-cluster（S4：事件聚合）
 * ```
 *
 * ── 为什么入队要单独抽一层 ──────────────────────────────────────────
 * 与 Agent 06 的 `queue.ts` 同一理由：JobId 幂等与入队选项必须在**入队时**
 * 确定，让每个调用方自己 `new Queue(...).add(...)` 迟早会出现
 * 「某处忘了带 JobId」「某处 attempts 写成了默认值」这类静默不一致。
 *
 * ── ⚠ 入队失败怎么办 ────────────────────────────────────────────────
 * 本端口**不吞异常**：入队失败意味着「这一阶段做完了，但下一阶段不会发生」，
 * 那是一个必须被看见的故障（Redis 挂了 / 队列名写错）。
 * 调用方（service）的策略见 `content.service.ts`。
 */

import type { Queue } from 'bullmq';
import { AiTaskType, JobId, JobName } from '@signal/contracts';
import {
  AI_JOB_OPTIONS,
  classifyScoreJobId,
  promptFor,
  translateJobId,
} from '../ai';
import { CONTENT_PIPELINE_JOB_OPTIONS, normalizeJobId } from './queue';

/** 注入 token。 */
export const CONTENT_ENQUEUER = 'CONTENT_ENQUEUER';

export interface ContentEnqueuer {
  /** 入队 `content.normalize`。 */
  enqueueNormalize(rawItemId: string): Promise<void>;
  /** 入队 `content.dedup`（近似判重）。 */
  enqueueDedup(contentId: string): Promise<void>;
  /** 入队 `content.event-cluster`（事件聚合）。 */
  enqueueEventCluster(contentId: string): Promise<void>;
  /**
   * 入队 Agent 06 的两个 AI 作业（翻译 / 评分）。
   *
   * ⚠ 这两个作业在 **`ai` 队列**上，不归本模块消费 —— 本模块只负责
   * 「把内容推进到待分析状态，并把它交给 AI 阶段」。
   * JobId 与入队选项**必须复用 Agent 06 导出的 builder**（`@signal/... ` 的
   * `jobs/ai` 公开面），不要自己拼字符串：那边已经踩过
   * 「2 段 JobId 被 BullMQ 拒绝」的坑（CCR 第 0 项）。
   */
  enqueueAiTranslation(contentId: string): Promise<void>;
  enqueueAiScoring(contentId: string): Promise<void>;
}

/**
 * `content.dedup` 的幂等 JobId。
 *
 * ⚠ 契约 `JobId` 里**没有** dedup 的 builder（4 个里 2 个还是坏的 2 段形态，
 * 见 `queue.ts` 的文件头）。这里沿用本模块的 3 段约定：
 * 第三段是**近似判重规则的版本**（阈值、指纹算法变了就该能重跑）。
 */
export const DEDUP_VERSION = 'v1';

export function dedupJobId(contentId: string, version: string = DEDUP_VERSION): string {
  return `dedup:${contentId}:${version}`;
}

/**
 * `content.event-cluster` 的幂等 JobId。
 *
 * 第三段是**聚类规则版本** —— 归属规则、优先级表变了就该能重跑。
 */
export const CLUSTER_VERSION = 'v1';

export function eventClusterJobId(
  contentId: string,
  version: string = CLUSTER_VERSION,
): string {
  return `cluster:${contentId}:${version}`;
}

/** 基于 BullMQ 的实现。 */
export class BullContentEnqueuer implements ContentEnqueuer {
  constructor(
    /** `content-pipeline` 队列（本模块自己的三个作业）。 */
    private readonly queue: Queue,
    /** `ai` 队列（Agent 06 的两个作业）。 */
    private readonly aiQueue: Queue,
  ) {}

  async enqueueNormalize(rawItemId: string): Promise<void> {
    await this.queue.add(
      JobName.CONTENT_NORMALIZE,
      { rawItemId },
      { ...CONTENT_PIPELINE_JOB_OPTIONS, jobId: normalizeJobId(rawItemId) },
    );
  }

  async enqueueDedup(contentId: string): Promise<void> {
    await this.queue.add(
      JobName.CONTENT_DEDUP,
      { contentId },
      { ...CONTENT_PIPELINE_JOB_OPTIONS, jobId: dedupJobId(contentId) },
    );
  }

  async enqueueEventCluster(contentId: string): Promise<void> {
    await this.queue.add(
      JobName.CONTENT_EVENT_CLUSTER,
      { contentId },
      { ...CONTENT_PIPELINE_JOB_OPTIONS, jobId: eventClusterJobId(contentId) },
    );
  }

  /**
   * 入队 `ai.translate` —— 复用 Agent 06 的 builder 与入队选项。
   *
   * `translateJobId(contentId, promptVersion)` 的第三段是 prompt 版本：
   * prompt 改版后重新入队不会被去重，历史内容因此可以被重新翻译。
   */
  async enqueueAiTranslation(contentId: string): Promise<void> {
    const version = promptFor(AiTaskType.TRANSLATE).version;
    await this.aiQueue.add(
      JobName.AI_TRANSLATE,
      { contentId },
      { ...AI_JOB_OPTIONS, jobId: translateJobId(contentId, version) },
    );
  }

  /** 入队 `ai.classify-score`（分类 + 评分共用一次调用，见 Agent 06 的说明）。 */
  async enqueueAiScoring(contentId: string): Promise<void> {
    const version = promptFor(AiTaskType.SCORE).version;
    await this.aiQueue.add(
      JobName.AI_CLASSIFY_SCORE,
      { contentId },
      { ...AI_JOB_OPTIONS, jobId: classifyScoreJobId(contentId, version) },
    );
  }
}

/**
 * 什么都不做的实现 —— **仅供测试与「只跑单阶段」的场景**。
 *
 * ⚠ 刻意不是默认值：默认必须真入队，否则 pipeline 会在某一阶段静默断掉
 *（Agent 06 的独立审查在那里发现过「消费者只被测试 new 过」的同类问题）。
 */
export class NoopContentEnqueuer implements ContentEnqueuer {
  async enqueueNormalize(): Promise<void> {}
  async enqueueDedup(): Promise<void> {}
  async enqueueEventCluster(): Promise<void> {}
  async enqueueAiTranslation(): Promise<void> {}
  async enqueueAiScoring(): Promise<void> {}
}

/** 供测试断言「契约 Job 名的映射没写错」。 */
export const CONTENT_JOB_NAMES = {
  normalize: JobName.CONTENT_NORMALIZE,
  dedup: JobName.CONTENT_DEDUP,
  eventCluster: JobName.CONTENT_EVENT_CLUSTER,
} as const;

/** 契约里的 `content.dedup` JobId builder 是否存在（用于记录契约缺口）。 */
export function contractHasDedupJobId(): boolean {
  return Object.hasOwn(JobId, 'dedup');
}
