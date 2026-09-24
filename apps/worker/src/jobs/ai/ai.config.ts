/**
 * AI 配置 —— 从 `docs/20` 已有的 env 派生，**不新增任何环境变量**。
 *
 * 用到的 5 个变量全部已在 `docs/20-environment-variables.md` 里：
 * `AI_DEFAULT_PROVIDER` / `AI_DEFAULT_BASE_URL` / `AI_DEFAULT_API_KEY` /
 * `AI_MODEL_CHEAP|MEDIUM|STRONG` / `AI_DAILY_BUDGET_USD`。
 */

import type { AppEnv } from '@signal/config';
import type { AiModelTier } from './ai.types';
import { AI_MODEL_TIERS } from './ai.types';

/** 注入 token。 */
export const AI_CONFIG = 'AI_CONFIG';

export type AiConfig = {
  /** `docs/20` 的 `AI_DEFAULT_PROVIDER`，默认 `openai-compatible`。 */
  provider: string;
  /** 未配置时为 `null` —— 调用方必须据此拒绝执行，不得静默跳过。 */
  baseUrl: string | null;
  /** 未配置时为 `null`。空 key 是合法的（本地 ollama 之类不需要鉴权）。 */
  apiKey: string | null;
  /** 各档位的模型名；该档未配置时为 `null`。 */
  models: Readonly<Record<AiModelTier, string | null>>;
  /** `AI_DAILY_BUDGET_USD`。 */
  dailyBudgetUsd: number;
  /** 单次请求超时（毫秒）。代码常量，不是 env。 */
  requestTimeoutMs: number;
};

/**
 * 默认请求超时。
 *
 * 取 90 秒：`DAILY_DRAFT` 是 strong 模型 + 最多 4 万字符输入，
 * 60 秒在真实网络下会误判成超时；再长则会让 `ai` 队列（并发 3）
 * 被慢请求占满，反而拖垮整条流水线。
 */
export const DEFAULT_AI_REQUEST_TIMEOUT_MS = 90_000;

export function createAiConfig(
  env: Pick<
    AppEnv,
    | 'AI_DEFAULT_PROVIDER'
    | 'AI_DEFAULT_BASE_URL'
    | 'AI_DEFAULT_API_KEY'
    | 'AI_MODEL_CHEAP'
    | 'AI_MODEL_MEDIUM'
    | 'AI_MODEL_STRONG'
    | 'AI_DAILY_BUDGET_USD'
  >,
  overrides: Partial<Pick<AiConfig, 'requestTimeoutMs'>> = {},
): AiConfig {
  return {
    provider: env.AI_DEFAULT_PROVIDER,
    baseUrl: env.AI_DEFAULT_BASE_URL ?? null,
    apiKey: env.AI_DEFAULT_API_KEY ?? null,
    models: {
      cheap: env.AI_MODEL_CHEAP ?? null,
      medium: env.AI_MODEL_MEDIUM ?? null,
      strong: env.AI_MODEL_STRONG ?? null,
    },
    dailyBudgetUsd: env.AI_DAILY_BUDGET_USD,
    requestTimeoutMs: overrides.requestTimeoutMs ?? DEFAULT_AI_REQUEST_TIMEOUT_MS,
  };
}

/** 该档位的模型名，未配置则抛给调用方决定（不要在这里静默回退到别的档位）。 */
export function modelFor(config: AiConfig, tier: AiModelTier): string | null {
  return config.models[tier];
}

/** 缺哪些配置 —— 用于把「为什么不能跑」讲清楚，而不是只报一个笼统的失败。 */
export function missingAiConfig(config: AiConfig): string[] {
  const missing: string[] = [];
  if (config.baseUrl === null) missing.push('AI_DEFAULT_BASE_URL');
  for (const tier of AI_MODEL_TIERS) {
    if (config.models[tier] === null) {
      missing.push(`AI_MODEL_${tier.toUpperCase()}`);
    }
  }
  return missing;
}
