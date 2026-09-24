/**
 * AI 模块的错误类型与 **retry 策略映射**。
 *
 * `docs/13` 对 AI 的重试有明确的分档要求：
 * 「AI：timeout/429/5xx 3 次；schema invalid 1 次；unsupported 不 retry。」
 *
 * 因此这里的 `kind` 不是装饰：它是**入队时 `attempts` 的唯一来源**。
 * 如果分类错了，一个永久失败会被重试 3 次（烧钱），
 * 或者一个瞬时抖动会被直接判死（内容永远拿不到分）。
 */

import { AI_RETRY, AppError, type RetryPolicy } from '@signal/contracts';
import type { AiFailureKind } from './ai.types';
import { FAILURE_KIND_TO_ERROR_CODE } from './ai.types';

/** 不重试。 */
const NO_RETRY: RetryPolicy = { attempts: 0, backoff: null };

/** `AiFailureKind` → BullMQ 重试策略。 */
export function retryPolicyFor(kind: AiFailureKind): RetryPolicy {
  switch (kind) {
    case 'TRANSIENT':
      return AI_RETRY.transient;
    case 'SCHEMA_INVALID':
      return AI_RETRY.schemaInvalid;
    case 'UNSUPPORTED':
      // 契约里就有一个 attempts=0 的 unsupported 策略，直接复用。
      return AI_RETRY.unsupported;
    case 'NOT_CONFIGURED':
    case 'UNAUTHORIZED':
    case 'BUDGET_EXCEEDED':
    case 'CONTENT_NOT_FOUND':
    case 'PERMANENT':
      return NO_RETRY;
    default: {
      // 穷尽性检查：新增 kind 却忘了给策略时，这里编译不过。
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

/**
 * AI 模块的统一错误。
 *
 * 继承 `AppError` 是为了复用 `packages/contracts/src/errors.ts` 的错误码规则与
 * `defaultHttpStatusForCode()`；Worker 不提供 HTTP，`httpStatus` 在这里
 * 只作为「这个码在 API 层会是什么」的一致信息，不参与 worker 的行为。
 */
export class AiError extends AppError {
  readonly kind: AiFailureKind;
  /** 上游返回的 HTTP status（若有），仅用于诊断。 */
  readonly upstreamStatus: number | null;

  constructor(params: {
    kind: AiFailureKind;
    safeMessage: string;
    cause?: unknown;
    upstreamStatus?: number | null;
    details?: unknown;
  }) {
    super({
      code: FAILURE_KIND_TO_ERROR_CODE[params.kind],
      safeMessage: params.safeMessage,
      details: params.details ?? null,
      ...(params.cause === undefined ? {} : { cause: params.cause }),
    });
    this.name = 'AiError';
    this.kind = params.kind;
    this.upstreamStatus = params.upstreamStatus ?? null;
    Error.captureStackTrace?.(this, AiError);
  }

  /** 本错误对应的 BullMQ 重试策略。 */
  get retryPolicy(): RetryPolicy {
    return retryPolicyFor(this.kind);
  }

  override toString(): string {
    return `${this.code} (${this.kind}): ${this.safeMessage}`;
  }
}

/* ------------------------------------------------------------------ */
/* 便捷构造                                                            */
/* ------------------------------------------------------------------ */

/** `docs/20` 的 AI 配置缺失 —— **不静默降级**，与 Agent 02 的 SMTP 同一取舍。 */
export function aiNotConfiguredError(missing: readonly string[]): AiError {
  return new AiError({
    kind: 'NOT_CONFIGURED',
    safeMessage: `AI provider is not configured (missing: ${missing.join(', ')})`,
    details: { missing },
  });
}

/** 今日预算耗尽，且该任务不是关键任务。 */
export function aiBudgetExceededError(params: {
  taskType: string;
  spentUsd: number;
  budgetUsd: number;
}): AiError {
  return new AiError({
    kind: 'BUDGET_EXCEEDED',
    safeMessage:
      `AI daily budget exhausted: spent $${params.spentUsd} of $${params.budgetUsd}; ` +
      `non-critical task ${params.taskType} is paused until the next business day`,
    details: params,
  });
}

/** 上游明确拒绝凭据（401/403）—— 与 Agent 04 的 `SOURCE_FETCH_UNAUTHORIZED` 同一语义。 */
export function aiUnauthorizedError(status: number): AiError {
  return new AiError({
    kind: 'UNAUTHORIZED',
    safeMessage: 'AI provider rejected our credentials (check AI_DEFAULT_API_KEY)',
    upstreamStatus: status,
  });
}

/** 瞬时失败：超时 / 429 / 5xx。 */
export function aiTransientError(params: {
  safeMessage: string;
  upstreamStatus?: number | null;
  cause?: unknown;
}): AiError {
  return new AiError({
    kind: 'TRANSIENT',
    safeMessage: params.safeMessage,
    upstreamStatus: params.upstreamStatus ?? null,
    ...(params.cause === undefined ? {} : { cause: params.cause }),
  });
}

/** 模型答了，但不是我们要的结构。 */
export function aiResponseInvalidError(safeMessage: string, details?: unknown): AiError {
  return new AiError({ kind: 'SCHEMA_INVALID', safeMessage, details });
}

/** 该 provider / model 不支持这个任务。 */
export function aiTaskUnsupportedError(safeMessage: string): AiError {
  return new AiError({ kind: 'UNSUPPORTED', safeMessage });
}

/** 确定性 4xx —— 重试没有意义。 */
export function aiPermanentError(params: {
  safeMessage: string;
  upstreamStatus?: number;
  details?: unknown;
}): AiError {
  return new AiError({
    kind: 'PERMANENT',
    safeMessage: params.safeMessage,
    upstreamStatus: params.upstreamStatus ?? null,
    details: params.details,
  });
}

/**
 * `contentId` 在库里不存在。
 *
 * 不可重试：重试同一个不存在的 id 只会得到同样的结果，
 * 而它通常意味着上游（Agent 05）传错了 id 或者内容刚被删掉 ——
 * 需要人去看，不是需要机器再试。
 */
export function aiContentNotFoundError(contentId: string): AiError {
  return new AiError({
    kind: 'CONTENT_NOT_FOUND',
    safeMessage: `Content not found: ${contentId}`,
    details: { contentId },
  });
}

/**
 * 该任务在本模块尚未实现（`prompts/registry.ts` 里登记为 `null`）。
 *
 * 与 `aiTaskUnsupportedError` 的区别：那个是**上游 provider** 不支持，
 * 这个是**我们**还没做。对运维而言前者要去换模型，后者要去看排期。
 */
export function aiTaskNotImplementedError(taskType: string): AiError {
  return new AiError({
    kind: 'UNSUPPORTED',
    safeMessage: `AI task is not implemented by this worker yet: ${taskType}`,
    details: { taskType },
  });
}

export function isAiError(value: unknown): value is AiError {
  return value instanceof AiError;
}
