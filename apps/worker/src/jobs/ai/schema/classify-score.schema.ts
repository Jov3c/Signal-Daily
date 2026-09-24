/**
 * `ai.classify-score` 的结构化输出契约。
 *
 * ── 为什么每个 schema 都用 `.strict()` ───────────────────────────────
 * `.strict()` 让 zod **拒绝任何未声明的字段**。这不是洁癖，是安全边界：
 *
 * `docs/08` 要求「AI 不能修改 Source Tier / 不能自己宣布某来源官方」。
 * 这条规则在实现上有两层：第一层是模型**没有写库的能力**，
 * 第二层是即使模型在输出里塞了 `{"sourceTier":"S","official":true}`，
 * 这个字段也**没有地方可去** —— schema 会直接判整份输出非法。
 *
 * 如果用了默认的非 strict 模式，多余字段会被静默丢弃，
 * 我们就永远不会知道有人在尝试这条路。**静默丢弃 = 看不见的攻击**。
 *
 * ── 为什么 `ai.classify-score` 不分成两次调用 ────────────────────────
 * 任务名（`docs/13`）本身就是 `ai.classify-score` —— 分类与评分在同一次
 * 调用里产出。分两次调用会让成本翻倍而信息量不变（同一个模型、
 * 同一份正文、同一份上下文）。`AiTaskType.CLASSIFY` 仍然保留在契约里，
 * 供将来真正的独立分类任务使用（例如只做主题回填而不重算分数）。
 */

import { z } from 'zod';

/** 单个维度：0–100。 */
const scoreValue = z.number().finite().min(0).max(100);

/** 分类结果里的主题 slug。 */
const topicSlug = z
  .string()
  .trim()
  .min(1)
  .max(80)
  // 主题 slug 由管理员在 `topics` 表里维护（Agent 01 seed 了 8 个），
  // 形态是 kebab-case。模型返回中文主题名是无效的 —— 让它失败，
  // 而不是把一个匹配不上任何 Topic 行的字符串写进 aiAnalysis。
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'topic slug must be kebab-case');

export const classifyScoreOutputSchema = z
  .object({
    dimensions: z
      .object({
        importance: scoreValue,
        relevance: scoreValue,
        credibility: scoreValue,
        novelty: scoreValue,
        density: scoreValue,
        readValue: scoreValue,
      })
      .strict(),
    /** 推荐理由 —— 落 `contents.recommendation_reason`，管理员在审核页要读它。 */
    reason: z.string().trim().min(1).max(4_000),
    /** 命中的主题 slug。允许为空（模型认为不属于任何已有主题）。 */
    topics: z.array(topicSlug).max(8).optional(),
    /** 模型判断的原文语言（宽松输入，由 `normalizeLanguageCode` 收敛）。 */
    detectedLanguage: z.string().trim().min(1).max(40).optional(),
  })
  .strict();

export type ClassifyScoreOutput = z.infer<typeof classifyScoreOutputSchema>;
