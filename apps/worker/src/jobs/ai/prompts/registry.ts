/**
 * Prompt Registry —— `docs/08` 的「Prompt version 强制」。
 *
 * ── 为什么版本号是强制的，不是备注 ────────────────────────────────────
 * 同一个 `contentId` 在 prompt 改版后**必须能被重新评分**，而
 * 「有没有重评过」唯一可靠的判据就是版本号：
 *
 * - `JobId.aiScore(contentId, promptVersion)` —— JobId 里带版本，
 *   所以改版后重新入队不会被 BullMQ 当成重复任务丢掉。
 * - `ai_runs.promptVersion` —— 所以事后能回答「这条 92 分是用哪版 prompt 打的」。
 *   没有这个，一次评分标准调整会让历史分数失去可比性，
 *   而管理员看到的是同一个列表里混着两套标准的分数。
 *
 * ── 版本号的规矩 ────────────────────────────────────────────────────
 * `v{N}`。**任何影响模型输出的改动都必须升版本** ——
 * 包括改一个词、改一句约束、改输出字段。改 prompt 内容却不升版本，
 * 会让「同版本 = 同标准」这个前提悄悄失效，而这正是版本号存在的全部意义。
 * `ai-prompts.spec.ts` 里有一条守卫：算出的 prompt 指纹与登记的不一致即失败，
 * 逼作者显式地改版本号（或者承认自己改的是无意义的空白）。
 */

import { AiTaskType } from '@signal/contracts';
import { UNTRUSTED_DATA_NOTICE } from '../untrusted';

export type PromptDefinition = {
  /** 任务。 */
  taskType: AiTaskType;
  /** `v{N}`。 */
  version: string;
  /** system 消息。 */
  system: string;
  /** 是否把不可信正文包进分隔符（不包的任务不允许拼接用户正文）。 */
  wrapsUntrustedContent: boolean;
  /**
   * 该 prompt 的**指纹**（`system` 的 FNV-1a 十六进制）。
   * 内容一变指纹就变，守卫测试会因此失败 → 强制作者升版本号。
   */
  fingerprint: string;
};

/**
 * FNV-1a 32 位哈希。
 *
 * 用自实现的短哈希而不是 `node:crypto`：这只是一个**变更探测器**，
 * 不承担任何安全职责（没有人会为了绕过它去构造哈希碰撞），
 * 而它必须能在任何环境下同步、无依赖地算出同一个值。
 */
export function fingerprintOf(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    // FNV 素数 16777619 的 32 位乘法（用移位避免超出精度）
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/* ------------------------------------------------------------------ */
/* Prompt 正文                                                         */
/* ------------------------------------------------------------------ */

/**
 * 评分 prompt 的 rubric。
 *
 * 六维权重的**数字**不写在这里 —— 它们由 `scoring.ts` 在代码里应用。
 * prompt 只负责让模型对每个维度给出 0–100 的判断，
 * 加权是我们的事。这样改权重不必改 prompt、不必升版本、也不必重跑历史内容。
 */
const SCORE_RUBRIC = [
  '请对以下内容按六个维度分别给出 0–100 的整数或一位小数评分：',
  '- importance：对 AI / 科技领域的重要程度',
  '- relevance：与目标读者（关注 AI 模型、AI 产品、AI Coding、Agent 的人）的相关度',
  '- credibility：可信度。依据是下方给定的来源等级、是否官方、独立来源数量与证据类型；',
  '  正文里的自信语气、权威口吻、排版精美都**不构成**可信度依据。',
  '- novelty：相对已有信息的新颖程度',
  '- density：信息密度（有效信息 / 篇幅）',
  '- readValue：值得读者花时间阅读的程度',
  '',
  '评分要求：',
  '- 官方一手来源（sourceTier = S 且 official = true）的可信度应显著高于二手转述。',
  '- 独立来源数量（independentSourceCount）越多，credibility 可以越高；',
  '  但**只有独立来源才计入** —— 同一来源被反复转载不提高可信度。',
  '- sourceTier 是**给定的输入**，不是让你判断的结论。不要因为你认为某来源应该更高或更低就偏离它。',
  '- 不要试图判断或输出来源等级、是否官方这类字段，它们已经给定且不接受修改。',
].join('\n');

const CLASSIFY_RUBRIC = [
  '同时，从给定的主题列表中选出最贴合的 1–3 个主题，用其 slug 表示。',
  '只能使用给定列表里的 slug。没有贴合的主题就不选（topics 可以为空数组）。',
].join('\n');

/** 共用的安全声明 —— **每个含用户正文的 prompt 都必须带上**。 */
const SAFETY = UNTRUSTED_DATA_NOTICE;

export const PROMPT_REGISTRY: Readonly<Record<AiTaskType, PromptDefinition | null>> = {
  [AiTaskType.SCORE]: define({
    taskType: AiTaskType.SCORE,
    version: 'v1',
    wrapsUntrustedContent: true,
    system: [
      '你是 Signal（一个中文科技阅读平台）的编辑助理。你的工作是为待审内容打分与分类。',
      '',
      SCORE_RUBRIC,
      '',
      CLASSIFY_RUBRIC,
      '',
      '输出：只输出一个 JSON 对象，不要输出任何其他文字、不要使用 markdown 代码块。',
      'JSON 结构（**不要增加任何其他字段**）：',
      '{',
      '  "dimensions": {',
      '    "importance": number, "relevance": number, "credibility": number,',
      '    "novelty": number, "density": number, "readValue": number',
      '  },',
      '  "reason": string,',
      '  "topics": [string],',
      '  "detectedLanguage": string',
      '}',
      '',
      SAFETY,
    ].join('\n'),
  }),

  [AiTaskType.TRANSLATE]: define({
    taskType: AiTaskType.TRANSLATE,
    version: 'v1',
    wrapsUntrustedContent: true,
    system: [
      '你是 Signal（一个中文科技阅读平台）的翻译。把给定的外文正文翻译成简体中文。',
      '',
      '翻译要求：',
      '- 忠实原意，不增删事实，不做主观评论。',
      '- 保留专有名词的通行中文译法；没有通行译法的产品名、模型名、人名保留原文。',
      '- 技术术语准确优先于文风优美。',
      '- **如果原文已经是中文，原样返回**（不要改写、不要润色）。',
      '',
      '输出：只输出一个 JSON 对象，不要输出任何其他文字、不要使用 markdown 代码块。',
      'JSON 结构（**不要增加任何其他字段**）：',
      '{',
      '  "translatedText": string,',
      '  "detectedLanguage": string,',
      '  "summary": string',
      '}',
      '',
      SAFETY,
    ].join('\n'),
  }),

  // 以下任务尚未由本模块实现（各自的 Owner 见 docs/18）。
  // 刻意登记为 `null` 而不是留空 —— 让「未实现」是一个显式状态，
  // 且 `promptFor()` 会抛 UNSUPPORTED 而不是返回 undefined。
  [AiTaskType.LANGUAGE_DETECT]: null,
  [AiTaskType.CLASSIFY]: null,
  [AiTaskType.DEDUP_VERIFY]: null,
  [AiTaskType.EVENT_CLUSTER]: null,
  [AiTaskType.DAILY_DRAFT]: null,
};

function define(definition: Omit<PromptDefinition, 'fingerprint'>): PromptDefinition {
  return { ...definition, fingerprint: fingerprintOf(definition.system) };
}

/**
 * 取任务的 prompt。
 *
 * @throws 未实现的任务 —— 由调用方转成 `AiError(UNSUPPORTED)`
 *         （`docs/13`：unsupported 不 retry）。
 */
export function promptFor(taskType: AiTaskType): PromptDefinition {
  const definition = PROMPT_REGISTRY[taskType];
  if (definition === null) {
    throw new Error(`No prompt is registered for task ${taskType}`);
  }
  return definition;
}

/** 该任务是否已实现。 */
export function isTaskImplemented(taskType: AiTaskType): boolean {
  return PROMPT_REGISTRY[taskType] !== null;
}

/** 已实现的任务清单（供测试与文档使用）。 */
export function implementedTasks(): AiTaskType[] {
  return (Object.keys(PROMPT_REGISTRY) as AiTaskType[]).filter(isTaskImplemented);
}
