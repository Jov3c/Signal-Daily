/**
 * `ai.translate` 的结构化输出契约。
 *
 * `docs/00`：**翻译永远不能覆盖原文**。这一点在数据库层已经由
 * `bodyOriginal` / `bodyTranslated` 两列并存保证（Agent 01），
 * 在本 schema 里体现为：输出的键叫 `translatedText`，**没有任何键叫
 * `originalText`** —— 模型即使想「顺手改一下原文」也没有字段可放。
 */

import { z } from 'zod';

export const translateOutputSchema = z
  .object({
    /** 中文译文。落 `contents.body_translated`。 */
    translatedText: z.string().min(1),
    /** 原文语言（宽松输入，由 `normalizeLanguageCode` 收敛）。 */
    detectedLanguage: z.string().trim().min(1).max(40),
    /**
     * 中文摘要。**可选** —— 落 `contents.summary` 由 Agent 05 决定
     * （见 HANDOFF 的「Integration Notes」：AI 不在流水线里抢写内容结构列）。
     */
    summary: z.string().trim().min(1).max(2_000).optional(),
  })
  .strict();

export type TranslateOutput = z.infer<typeof translateOutputSchema>;
