/**
 * 模型价格表与成本估算。
 *
 * ── 为什么价格是代码常量而不是 env ────────────────────────────────────
 * `docs/20` 只给了 `AI_MODEL_CHEAP / MEDIUM / STRONG` 三个**自由字符串**，
 * 以及一个 `AI_DEFAULT_BASE_URL`（任何 OpenAI-compatible 端点）。
 * 模型名是部署方随便填的（`gpt-4o-mini`、`deepseek-chat`、本地 ollama 的
 * `qwen2.5:7b`……），**无法用一张固定的 env 表定价**。
 *
 * 而 `AI_DAILY_BUDGET_USD` 要生效就必须有个价格。三个选择：
 *
 * 1. 只记 token、成本永远 null → **预算永远不会触发**，等于没有预算。
 *    这是最糟的：看着有预算，实际是一行不生效的配置。
 * 2. 新增 env 让部署方填价格 → `docs/20` 是冻结契约，
 *    §20 明令「任何代理不得新增未记录 env」，要改就得走 CCR。
 * 3. **代码内价格表 + 未知名保守兜底价**（本实现）。
 *
 * 选 3 的理由：它不新增契约，且**兜底价刻意取高**——宁可让预算早一点触发
 * （管理员会收到告警并去看），也不要因为低估而静默超支。低估是静默失败，
 * 高估是可见的噪音，这个项目一贯选后者（同 Agent 02 的 SMTP、Agent 04 的 X 凭据）。
 *
 * ⚠ 设计取舍，已记入 HANDOFF：**未知名模型走兜底价，不是真实价格**。
 * 若部署方用的模型不在表里，应把单价补进 `MODEL_PRICE_TABLE`
 * （属于本模块的代码常量，不涉及公共契约）。
 */

import type { AiTaskType } from '@signal/contracts';

/** 每 100 万 token 的美元单价。 */
export type ModelPrice = {
  /** 输入（prompt）单价，USD / 1M tokens。 */
  inputPerMillionUsd: number;
  /** 输出（completion）单价，USD / 1M tokens。 */
  outputPerMillionUsd: number;
};

/**
 * 已知模型的单价表。
 *
 * 键是**模型名的小写前缀**匹配（见 `findPrice`），这样
 * `gpt-4o-mini-2024-07-18` 这样的带日期后缀的名字也能命中 `gpt-4o-mini`。
 *
 * ⚠ 价格会过期。它是**估算**，用于预算闸门，不是账务依据。
 * 上游应始终以 provider 的账单为准。
 */
export const MODEL_PRICE_TABLE: Readonly<Record<string, ModelPrice>> = {
  // OpenAI
  'gpt-4o-mini': { inputPerMillionUsd: 0.15, outputPerMillionUsd: 0.6 },
  'gpt-4o': { inputPerMillionUsd: 2.5, outputPerMillionUsd: 10 },
  'gpt-4.1-mini': { inputPerMillionUsd: 0.4, outputPerMillionUsd: 1.6 },
  'gpt-4.1': { inputPerMillionUsd: 2, outputPerMillionUsd: 8 },
  // Anthropic（通过 OpenAI-compatible 网关时也会用到）
  'claude-sonnet-5': { inputPerMillionUsd: 3, outputPerMillionUsd: 15 },
  'claude-haiku-4-5': { inputPerMillionUsd: 1, outputPerMillionUsd: 5 },
  // DeepSeek
  'deepseek-chat': { inputPerMillionUsd: 0.27, outputPerMillionUsd: 1.1 },
  'deepseek-reasoner': { inputPerMillionUsd: 0.55, outputPerMillionUsd: 2.19 },
};

/**
 * 未知模型的兜底单价 —— **刻意取高**（见文件头说明）。
 *
 * 取在已知表里最贵的一档之上，确保「表里没有的模型」不会因为便宜而被放过去。
 */
export const FALLBACK_MODEL_PRICE: ModelPrice = {
  inputPerMillionUsd: 5,
  outputPerMillionUsd: 20,
};

/** 查价结果。`matched` 让调用方知道是否走了兜底价，可据此告警。 */
export type PriceLookup = {
  price: ModelPrice;
  /** 命中的价格表键；走兜底价时为 `null`。 */
  matchedKey: string | null;
};

/**
 * 按模型名查价。
 *
 * 匹配规则：模型名**小写后以价格表键开头**即命中，取**最长的命中键**
 * （这样 `gpt-4.1-mini` 不会被 `gpt-4.1` 抢走）。
 */
export function findPrice(model: string): PriceLookup {
  const normalized = model.trim().toLowerCase();
  let best: { key: string; price: ModelPrice } | null = null;

  for (const [key, price] of Object.entries(MODEL_PRICE_TABLE)) {
    if (!normalized.startsWith(key)) continue;
    if (best === null || key.length > best.key.length) {
      best = { key, price };
    }
  }

  if (best === null) {
    return { price: FALLBACK_MODEL_PRICE, matchedKey: null };
  }
  return { price: best.price, matchedKey: best.key };
}

/**
 * 估算一次调用的成本（USD）。
 *
 * 缺 token 数时返回 `null` 而不是 `0` —— `0` 会让预算统计**静默少算**，
 * 而 `null` 在汇总时可以被显式区分（见 `budget.ts` 的说明）。
 */
export function estimateCostUsd(params: {
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
}): number | null {
  const { inputTokens, outputTokens } = params;
  if (inputTokens === null && outputTokens === null) return null;

  const { price } = findPrice(params.model);
  const input = ((inputTokens ?? 0) / 1_000_000) * price.inputPerMillionUsd;
  const output = ((outputTokens ?? 0) / 1_000_000) * price.outputPerMillionUsd;

  return roundUsd(input + output);
}

/**
 * 金额保留 6 位小数 —— 对齐 `ai_runs.estimated_cost_usd` 的 `DECIMAL(12,6)`。
 *
 * 不做这一步的话，Prisma 写入时会被数据库静默截断，
 * 而内存里的值与库里的值不一致，会让「预算统计」和「实际落库」对不上。
 */
export function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

/**
 * 各任务的输入上限（字符）。超出的正文会被 `untrusted.ts` 截断。
 *
 * 作用有两个：控成本，以及**减少 prompt injection 的可用面**
 * （注入指令越靠后越容易被截掉，且超长正文本身就是一种攻击载荷）。
 */
export const MAX_INPUT_CHARS: Readonly<Record<AiTaskType, number>> = {
  LANGUAGE_DETECT: 2_000,
  TRANSLATE: 20_000,
  CLASSIFY: 8_000,
  SCORE: 12_000,
  DEDUP_VERIFY: 8_000,
  EVENT_CLUSTER: 12_000,
  DAILY_DRAFT: 40_000,
};
