/**
 * `AiService` — AI 编排的唯一入口。
 *
 * 职责链（每一步都必须发生，顺序不能换）：
 *
 * ```text
 * 预算闸门 → 读内容 → 读证据 → 组装上下文 → 取 prompt（含版本）
 *   → startAiRun(RUNNING)
 *   → 调 provider
 *   → schema 强校验
 *   → finishAiRun(SUCCEEDED, 产物)   ← 与产物同一事务
 * ```
 * 任何一步失败都走 `finishAiRun(FAILED)`，然后**原样抛出** ——
 * 不吞异常、不转成成功。重试与否由 `ai.worker.ts` 依据 `AiError.kind` 决定。
 *
 * ── 本服务不碰的东西（刻意的边界）──────────────────────────────────
 * - **不写 `contents.pipelineStatus`**。状态机归 Agent 05（流水线 Owner）。
 *   AI 跑完不代表内容就该进入待审 —— 那取决于流水线是否还有后续阶段。
 * - **不写 `ContentTopic`**。分类结果通过返回值交给 Agent 05，
 *   由它和 Content 的创建放在一起写，避免两个 Agent 争同一张关联表。
 * - **不写 `sources` 的任何列**。`docs/08` 的硬约束。
 */

import { Inject, Injectable } from '@nestjs/common';
import { AiRunStatus, AiTaskType } from '@signal/contracts';
import type { Logger } from '@signal/logger';
import { AI_CONFIG, missingAiConfig, modelFor, type AiConfig } from './ai.config';
import {
  aiContentNotFoundError,
  aiNotConfiguredError,
  aiPermanentError,
  aiTaskNotImplementedError,
  isAiError,
} from './ai.errors';
import { AI_REPOSITORY, type AiArtifact, type AiRepository } from './ai-run.repository';
import { AiBudgetGuard, type AiBudgetSnapshot, type AiSpendRepository } from './budget';
import type { AiClock } from './clock';
import { AI_CLOCK } from './clock';
import { buildEvidenceContext } from './evidence-context';
import { estimateCostUsd, findPrice } from './pricing';
import { AI_PROVIDER, type AiProvider } from './provider/provider';
import { buildMessages, type AiContentInput } from './prompts/build-messages';
import { promptFor } from './prompts/registry';
import { classifyScoreOutputSchema } from './schema/classify-score.schema';
import { normalizeLanguageCode } from './schema/language';
import { translateOutputSchema } from './schema/translate.schema';
import { parseStructuredOutput } from './schema/validate';
import { scoreContent, toContentScoreUpdate, type ScoreResult } from './scoring';
import { TASK_MODEL_TIER, TASK_TEMPERATURE, type AiFailureKind } from './ai.types';

/** 注入 token。 */
export const AI_LOGGER = 'AI_LOGGER';

/**
 * 一次任务里**由产物决定**的那部分结果。
 *
 * 单独一个类型（而不是 `Partial<AiTaskOutcome>`）是刻意的：
 * 每个字段都必须被显式赋成 `null` 或真实值，
 * 于是「TRANSLATE 忘了清掉 score」这类遗漏会在编译期被抓住。
 */
export type ArtifactOutcome = {
  /** 仅 `SCORE`：六维分数与档位。 */
  score: ScoreResult | null;
  /**
   * 仅 `SCORE`：命中的主题 slug。
   *
   * ⚠ **交给调用方写 `ContentTopic`** —— 见文件头的边界说明。
   */
  topics: string[];
  /** 仅 `TRANSLATE`：中文译文（已落库，这里回传便于调用方使用）。 */
  translatedText: string | null;
  /** 仅 `TRANSLATE`：中文摘要。**由调用方决定是否写 `contents.summary`**。 */
  summary: string | null;
  /** 模型判断的原文语言（已收敛成 `ll` / `ll-RR`）。 */
  detectedLanguage: string | null;
};

/** 一次成功的 AI 任务。 */
export type AiTaskOutcome = ArtifactOutcome & {
  taskType: AiTaskType;
  contentId: string;
  aiRunId: string;
  usage: {
    inputTokens: number | null;
    outputTokens: number | null;
    estimatedCostUsd: number | null;
  };
  budget: AiBudgetSnapshot;
};

@Injectable()
export class AiService {
  private readonly budgetGuard: AiBudgetGuard;

  constructor(
    @Inject(AI_CONFIG) private readonly config: AiConfig,
    @Inject(AI_PROVIDER) private readonly provider: AiProvider,
    @Inject(AI_REPOSITORY) private readonly repository: AiRepository,
    @Inject(AI_CLOCK) private readonly clock: AiClock,
    @Inject(AI_LOGGER) private readonly logger: Logger,
  ) {
    // 预算的支出统计由 `AiRepository.sumCostUsdBetween` 提供 ——
    // `AiRepository` 同时满足 `AiSpendRepository`，所以这里不需要第二个 provider。
    // （单独抽 `AI_SPEND_REPOSITORY` token 会让装配多一个「忘了绑定」的失败点，
    //  而它们背后必然是同一张 `ai_runs` 表。）
    const spend: AiSpendRepository = repository;
    this.budgetGuard = new AiBudgetGuard({
      spend,
      clock: this.clock,
      config: this.config,
    });
  }

  /** 当前业务日的预算快照（供健康检查 / 运维查询）。 */
  async budgetSnapshot(): Promise<AiBudgetSnapshot> {
    return this.budgetGuard.snapshot();
  }

  /**
   * 跑一个 AI 任务。
   *
   * @throws `AiError` —— 调用方应当用 `kind` 决定是否重试（`ai.worker.ts`）。
   */
  async runTask(input: { taskType: AiTaskType; contentId: string }): Promise<AiTaskOutcome> {
    const { taskType, contentId } = input;

    // 1) 预算闸门。放在最前面：先花掉一次 provider 调用再检查预算等于没有闸门。
    const budget = await this.budgetGuard.assertCanRun(taskType);
    if (budget.state === 'WARNING') {
      // `docs/08` 的「80% 告警」。落在模块边界上：真正的投递（邮件）属于
      // 通知域（Agent 08 / 11），本模块只提供带明确 code 的信号与可查询快照。
      this.logger.warn(
        {
          errorCode: 'AI_BUDGET_WARNING',
          businessDate: budget.businessDate,
          spentUsd: budget.spentUsd,
          budgetUsd: budget.budgetUsd,
          uncostedRuns: budget.uncostedRuns,
        },
        'AI daily budget has passed the 80% warning threshold',
      );
    }

    // 2) prompt 必须在调用 provider 之前取 —— 未实现的任务不该产生任何费用，
    //    也不该留下一条 AiRun。
    const prompt = promptForTask(taskType);

    // 3) 配置检查同样前置：缺 baseUrl / 缺该档模型时立刻失败。
    const model = modelFor(this.config, TASK_MODEL_TIER[taskType]);
    if (this.config.baseUrl === null || model === null) {
      throw aiNotConfiguredError(missingAiConfig(this.config));
    }

    // 4) 读内容与上下文。
    const content = await this.repository.findContent(contentId);
    if (content === null) throw aiContentNotFoundError(contentId);

    const [evidences, topics] = await Promise.all([
      content.eventId === null
        ? Promise.resolve([])
        : this.repository.findEventEvidences(content.eventId),
      taskType === AiTaskType.SCORE ? this.repository.listTopics() : Promise.resolve([]),
    ]);

    const { context: evidenceContext, diagnostics } = buildEvidenceContext({
      source: content.source,
      evidences,
    });
    if (diagnostics.primaryEvidenceCount > 1) {
      // 数据完整性问题：`docs/03` 要求一个 Event 最多一个 Primary Evidence，
      // 但 DB 层不强制（Agent 01 的说明）。本模块不修数据，只让它可见。
      this.logger.warn(
        {
          contentId,
          eventId: content.eventId,
          primaryEvidenceCount: diagnostics.primaryEvidenceCount,
        },
        'Event has more than one primary evidence; taking the lowest id deterministically',
      );
    }

    // 5) 组装消息并开跑。
    const aiContent: AiContentInput = {
      contentId: content.id,
      title: content.title,
      body: selectBody(content, taskType),
      sourceName: content.source.name,
      sourceIdentity: {
        kind: content.source.kind,
        tier: content.source.tier,
        official: content.source.official,
      },
      evidences,
      topics,
    };

    const messages = buildMessages({ prompt, content: aiContent, evidenceContext });
    const aiRunId = await this.repository.startAiRun({
      contentId: content.id,
      taskType,
      provider: this.provider.name,
      model,
      promptVersion: prompt.version,
    });

    const startedAt = this.clock.now();

    try {
      const completion = await this.provider.complete({
        model,
        messages,
        expectJsonObject: true,
        temperature: TASK_TEMPERATURE[taskType],
      });

      const { artifact, outcome } = this.buildArtifact({
        taskType,
        completion: completion.text,
        detectedLanguageHint: completion.model,
      });

      const estimatedCostUsd = estimateCostUsd({
        model,
        inputTokens: completion.inputTokens,
        outputTokens: completion.outputTokens,
      });
      this.warnIfUnpriced(model);

      await this.repository.finishAiRun({
        aiRunId,
        contentId: content.id,
        status: AiRunStatus.SUCCEEDED,
        inputTokens: completion.inputTokens,
        outputTokens: completion.outputTokens,
        estimatedCostUsd,
        durationMs: completion.durationMs,
        errorCode: null,
        artifact,
      });

      this.logger.info(
        {
          contentId: content.id,
          jobId: aiRunId,
          taskType,
          model,
          promptVersion: prompt.version,
          durationMs: completion.durationMs,
          estimatedCostUsd,
        },
        'ai task succeeded',
      );

      return {
        ...outcome,
        taskType,
        contentId: content.id,
        aiRunId,
        usage: {
          inputTokens: completion.inputTokens,
          outputTokens: completion.outputTokens,
          estimatedCostUsd,
        },
        budget,
      };
    } catch (error) {
      await this.recordFailure({ aiRunId, contentId: content.id, startedAt, error });
      throw error;
    }
  }

  /**
   * 把模型输出变成「要落库的产物 + 要回传给调用方的结果」。
   *
   * 这里是**唯一**做 schema 校验的地方 —— 所有任务都走 `parseStructuredOutput`，
   * 因此失败的分类（SCHEMA_INVALID）只有一处产出，重试策略也就只有一种。
   */
  private buildArtifact(params: {
    taskType: AiTaskType;
    completion: string;
    detectedLanguageHint: string;
  }): { artifact: AiArtifact; outcome: ArtifactOutcome } {
    const { taskType, completion } = params;

    if (taskType === AiTaskType.SCORE) {
      const parsed = parseStructuredOutput({
        text: completion,
        schema: classifyScoreOutputSchema,
        taskType,
      });

      const score = scoreContent(parsed.dimensions);
      const detectedLanguage = normalizeLanguageCode(parsed.detectedLanguage);

      return {
        artifact: {
          kind: 'score',
          scoreUpdate: toContentScoreUpdate(score),
          recommendationReason: parsed.reason,
          aiAnalysis: {
            taskType,
            promptVersion: promptForTask(taskType).version,
            dimensions: score.dimensions,
            weights: {
              importance: 25,
              relevance: 20,
              credibility: 20,
              novelty: 15,
              density: 10,
              readValue: 10,
            },
            finalScore: score.finalScore,
            band: score.band,
            reason: parsed.reason,
            // 分类结果也存进 aiAnalysis：即使 Agent 05 没有把 topics 写进
            // `content_topics`，管理员在审核页仍能看到模型当时选了什么。
            topics: parsed.topics ?? [],
            detectedLanguage,
          },
        },
        outcome: {
          score,
          topics: parsed.topics ?? [],
          translatedText: null,
          summary: null,
          detectedLanguage,
        },
      };
    }

    if (taskType === AiTaskType.TRANSLATE) {
      const parsed = parseStructuredOutput({
        text: completion,
        schema: translateOutputSchema,
        taskType,
      });
      const detectedLanguage = normalizeLanguageCode(parsed.detectedLanguage);

      return {
        artifact: {
          kind: 'translation',
          bodyTranslated: parsed.translatedText,
          aiAnalysis: {
            taskType,
            promptVersion: promptForTask(taskType).version,
            detectedLanguage,
            summary: parsed.summary ?? null,
          },
        },
        outcome: {
          score: null,
          topics: [],
          translatedText: parsed.translatedText,
          summary: parsed.summary ?? null,
          detectedLanguage,
        },
      };
    }

    // 走到这里说明 registry 登记了 prompt 但 buildArtifact 没实现 —— 是编程错误。
    throw aiPermanentError({
      safeMessage: `No artifact builder is implemented for task ${taskType}`,
    });
  }

  /** 记录失败收尾。**绝不因为记录失败而掩盖原始异常。** */
  private async recordFailure(params: {
    aiRunId: string;
    contentId: string;
    startedAt: Date;
    error: unknown;
  }): Promise<void> {
    const { aiRunId, contentId, startedAt, error } = params;
    const kind: AiFailureKind = isAiError(error) ? error.kind : 'PERMANENT';
    const errorCode = isAiError(error) ? String(error.code) : 'AI_REQUEST_FAILED';
    const durationMs = Math.max(0, this.clock.now().getTime() - startedAt.getTime());

    try {
      await this.repository.finishAiRun({
        aiRunId,
        contentId,
        status: AiRunStatus.FAILED,
        inputTokens: null,
        outputTokens: null,
        estimatedCostUsd: null,
        durationMs,
        errorCode,
        // 失败时**不写任何产物** —— 保证「写了一半的分数」不会留在库里。
        artifact: { kind: 'none' },
      });
    } catch (recordingError) {
      this.logger.error(
        { err: recordingError, contentId, jobId: aiRunId, errorCode },
        'failed to record AI run failure',
      );
    }

    this.logger.error(
      { err: error, contentId, jobId: aiRunId, errorCode, durationMs, failureKind: kind },
      'ai task failed',
    );
  }

  /** 模型不在价格表里时告警 —— 否则成本是兜底价，预算会偏离真实值。 */
  private warnIfUnpriced(model: string): void {
    const { matchedKey } = findPrice(model);
    if (matchedKey !== null) return;
    this.logger.warn(
      { model },
      'model is not in the price table; cost is estimated with the conservative fallback rate',
    );
  }
}

/**
 * 取任务的 prompt；未实现时抛 UNSUPPORTED。
 *
 * `promptFor` 抛的是裸 `Error`（它在 registry 里不知道 `AiError` 的存在），
 * 在这里统一收敛 —— 保证从 `AiService` 出去的错误**一定是 `AiError`**，
 * 于是 `ai.worker.ts` 的重试判断不需要处理「未知错误」这一类。
 */
function promptForTask(taskType: AiTaskType): ReturnType<typeof promptFor> {
  try {
    return promptFor(taskType);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('No prompt is registered')) {
      throw aiTaskNotImplementedError(taskType);
    }
    throw error;
  }
}

/**
 * 选用于分析的正文。
 *
 * - 翻译任务：给**原文**（`.bodyOriginal`）；没有原文就退回已有译文，
 *   但那通常意味着重复翻译，交给模型按「原文已是中文则原样返回」处理。
 * - 评分任务：**优先译文**。评分是给中文读者看的判断，
 *   用译文评分才与读者的实际阅读体验一致；
 *   没有译文时退回原文（此时模型会按外文判断，可接受）。
 */
function selectBody(
  content: { bodyOriginal: string | null; bodyTranslated: string | null; title: string },
  taskType: AiTaskType,
): string {
  if (taskType === AiTaskType.TRANSLATE) {
    return content.bodyOriginal ?? content.bodyTranslated ?? content.title;
  }
  return content.bodyTranslated ?? content.bodyOriginal ?? content.title;
}
