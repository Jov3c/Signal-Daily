/**
 * `ai.translate` 的结构化输出契约。
 *
 * `docs/00`：**翻译永远不能覆盖原文**。这一点在数据库层已经由
 * `bodyOriginal` / `bodyTranslated` 两列并存保证（Agent 01），
 * 在本 schema 里体现为：输出的键叫 `translatedText`，**没有任何键叫
 * `originalText`** —— 模型即使想「顺手改一下原文」也没有字段可放。
 */

import { z } from 'zod';
import { MAX_INPUT_CHARS } from '../pricing';

/**
 * 译文长度上限。
 *
 * 第一版这里是 `z.string().min(1)` —— **没有上限**，而同一份 schema 里
 * `summary` 有 `.max(2_000)`、`reason` 有 `.max(4_000)`，只有译文敞开。
 * 独立审查把它标为 P3：被注入或以复读方式失控的模型输出可以把任意大小的
 * 文本写进 `contents.body_translated`（`LongText`，展示用列），
 * 一次任务 = 一次无界写入。输入侧有 `MAX_INPUT_CHARS.TRANSLATE = 20_000`，
 * 输出侧却完全没有 —— 这个不对称是疏漏，不是取舍。
 *
 * 取输入上限的 **8 倍**：中文译文相对英文原文通常更长（1.5–2 倍），
 * 8 倍给了充足余量，同时把「无界」变成「有界且可预期」。
 */
export const TRANSLATED_TEXT_MAX_CHARS = MAX_INPUT_CHARS.TRANSLATE * 8;

export const translateOutputSchema = z
  .object({
    /** 中文译文。落 `contents.body_translated`。 */
    translatedText: z.string().min(1).max(TRANSLATED_TEXT_MAX_CHARS),
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
