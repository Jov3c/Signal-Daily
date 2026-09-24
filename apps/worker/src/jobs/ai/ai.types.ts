/**
 * AI 模块内部类型 —— 任务分层、关键性、失败分类。
 *
 * 这些**不是**公共契约：`docs/05` 的 `AiTaskType` / `AiRunStatus` 才是，
 * 它们来自 `@signal/contracts`，本文件只在其上做本模块特有的派生。
 */

import { AiTaskType } from '@signal/contracts';

/* ------------------------------------------------------------------ */
/* 模型分层（docs/08）                                                  */
/* ------------------------------------------------------------------ */

/**
 * `docs/08` 的三档模型：
 *
 * - cheap：语言识别、翻译、基础分类
 * - medium：评分、Dedup Verify、Event Cluster
 * - strong：Daily Draft
 */
export const AI_MODEL_TIERS = ['cheap', 'medium', 'strong'] as const;
export type AiModelTier = (typeof AI_MODEL_TIERS)[number];

/**
 * 任务 → 模型档位。
 *
 * ⚠ 这是**穷尽映射**：`AiTaskType` 新增取值时，这里会因为
 * `Record<AiTaskType, ...>` 缺键而在 `tsc` 阶段直接报错，
 * 而不是在运行期悄悄回退到某个默认档位（那会静默烧钱）。
 */
export const TASK_MODEL_TIER: Readonly<Record<AiTaskType, AiModelTier>> = {
  [AiTaskType.LANGUAGE_DETECT]: 'cheap',
  [AiTaskType.TRANSLATE]: 'cheap',
  [AiTaskType.CLASSIFY]: 'cheap',
  [AiTaskType.SCORE]: 'medium',
  [AiTaskType.DEDUP_VERIFY]: 'medium',
  [AiTaskType.EVENT_CLUSTER]: 'medium',
  [AiTaskType.DAILY_DRAFT]: 'strong',
};

/**
 * 哪些任务在预算耗尽（100%）后**仍可继续**。
 *
 * `docs/08` 的原话是「100% 非关键任务暂停」，即存在「关键任务」。
 * 本模块把**只有 `DAILY_DRAFT`** 视为关键 —— 它是唯一有硬性外部时刻表的产出
 * （`docs/00`：日报目标 08:00 发布），停掉它意味着当天没有日报可审。
 * 其余任务都是「早一天晚一天都在」的候选池加工，预算耗尽就该停下来等次日。
 *
 * ⚠ 这是设计取舍，已记入 HANDOFF。若产品上认为评分也必须保证，改这张表即可。
 */
export const CRITICAL_TASKS: ReadonlySet<AiTaskType> = new Set([AiTaskType.DAILY_DRAFT]);

/** 该任务在预算耗尽时是否仍允许执行。 */
export function isCriticalTask(taskType: AiTaskType): boolean {
  return CRITICAL_TASKS.has(taskType);
}

/* ------------------------------------------------------------------ */
/* 采样温度                                                            */
/* ------------------------------------------------------------------ */

/**
 * 各任务的采样温度。
 *
 * 全部取 0：本模块做的是**评分、分类、翻译**，三者都要求
 * 「同一份输入尽量得到同一个输出」。
 *
 * 这不是洁癖。`finalScore` 是 Agent 07 审核列表的排序键、
 * Agent 10 前台的门槛；如果重跑一次分数就变，那么：
 * - 重试（schema invalid 会重试 1 次）会得到与首次不同的分数；
 * - prompt 改版后重评分会让历史分数失去可比性；
 * - 管理员无法复现自己昨天看到的排序。
 *
 * 温度 0 不保证确定性（上游实现、并发批处理都会引入差异），
 * 但它是我们能控制的那一半。
 */
export const TASK_TEMPERATURE: Readonly<Record<AiTaskType, number>> = {
  [AiTaskType.LANGUAGE_DETECT]: 0,
  [AiTaskType.TRANSLATE]: 0,
  [AiTaskType.CLASSIFY]: 0,
  [AiTaskType.SCORE]: 0,
  [AiTaskType.DEDUP_VERIFY]: 0,
  [AiTaskType.EVENT_CLUSTER]: 0,
  [AiTaskType.DAILY_DRAFT]: 0,
};

/* ------------------------------------------------------------------ */
/* 失败分类                                                            */
/* ------------------------------------------------------------------ */

/**
 * AI 调用失败的分类。**这张表决定 retry 策略**（`docs/13`）：
 *
 * | kind            | 重试 | 语义                                   |
 * | --------------- | ---- | -------------------------------------- |
 * | TRANSIENT       | 3 次 | 超时 / 429 / 5xx —— 等一会儿可能就好了  |
 * | SCHEMA_INVALID  | 1 次 | 模型答了，但不是我们要的结构            |
 * | UNSUPPORTED     | 0 次 | 该 provider / model 不支持这个任务      |
 * | NOT_CONFIGURED  | 0 次 | env 没配 —— 重试没有意义               |
 * | UNAUTHORIZED    | 0 次 | 上游明确拒绝我们的凭据 —— 重试会烧额度    |
 * | BUDGET_EXCEEDED | 0 次 | 今日预算耗尽 —— 重试只会继续撞墙         |
 * | PERMANENT       | 0 次 | 4xx 之类的确定性错误                    |
 */
export const AI_FAILURE_KINDS = [
  'TRANSIENT',
  'SCHEMA_INVALID',
  'UNSUPPORTED',
  'NOT_CONFIGURED',
  'UNAUTHORIZED',
  'BUDGET_EXCEEDED',
  'CONTENT_NOT_FOUND',
  'PERMANENT',
] as const;

export type AiFailureKind = (typeof AI_FAILURE_KINDS)[number];

/**
 * 失败分类 → 业务错误码。
 *
 * 每个分类**恰好**对应一个码，避免出现「同一个语义两个码」
 * （`packages/contracts/src/errors.ts` 的硬性规则）。
 */
export const FAILURE_KIND_TO_ERROR_CODE: Readonly<Record<AiFailureKind, string>> = {
  TRANSIENT: 'AI_REQUEST_FAILED',
  SCHEMA_INVALID: 'AI_RESPONSE_INVALID',
  UNSUPPORTED: 'AI_TASK_UNSUPPORTED',
  NOT_CONFIGURED: 'AI_NOT_CONFIGURED',
  UNAUTHORIZED: 'AI_PROVIDER_UNAUTHORIZED',
  BUDGET_EXCEEDED: 'AI_BUDGET_EXCEEDED',
  CONTENT_NOT_FOUND: 'AI_CONTENT_NOT_FOUND',
  PERMANENT: 'AI_REQUEST_FAILED',
};

/* ------------------------------------------------------------------ */
/* 调用结果 / 用量                                                      */
/* ------------------------------------------------------------------ */

/** 一次完成的 AI 调用结果。 */
export type AiCompletionResult = {
  /** 模型返回的原始文本（预期是 JSON）。 */
  text: string;
  inputTokens: number | null;
  outputTokens: number | null;
  /** 上游自报的模型名（可能与我们请求的不同，例如别名解析后的名字）。 */
  model: string;
  durationMs: number;
};
