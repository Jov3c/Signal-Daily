/**
 * AI 模块测试用的替身。
 *
 * 与 Agent 02 的 `fakes.ts`、Agent 03 的 `source-fakes.ts` 同一原则：
 * 替身**刻意复刻真实实现的关键约束**，否则测试就是自证。这里复刻的是：
 *
 * - `startAiRun` 落的行初始为 `RUNNING`，且 `finishAiRun` 只能收尾一次
 *   （真实实现里是同一个 `ai_run` 行的 UPDATE）；
 * - **失败时产物必须为空**：`finishAiRun` 收到 `artifact.kind === 'none'` 时
 *   绝不改 `contents`，与真实实现的 `contentWriteFor()` 返回 `null` 一致；
 * - `sumCostUsdBetween` 按 `[from, to)` 过滤，并把 `estimatedCostUsd === null`
 *   的行**单独计数**而不计入合计 —— 这一条是预算诚实性的核心，
 *   替身必须同样复刻，否则「未计价 run 被静默少算」的 bug 在单测里看不见；
 * - 所有写入都会被记进 `writes`，供「AI 永不写 `sources`」这类断言使用。
 *
 * 真实 SQL 的等价断言由 `ai-db.integration.spec.ts` 在真 MySQL 上再跑一遍。
 */

import {
  AiRunStatus,
  AiTaskType,
  SourceKind,
  SourceTier,
  type EvidenceType,
} from '@signal/contracts';
import type { AiConfig } from '../../src/jobs/ai/ai.config';
import type { AiClock } from '../../src/jobs/ai/clock';
import type {
  AiArtifact,
  AiContentRecord,
  AiRepository,
  AiTopicRecord,
  FinishAiRunInput,
  StartAiRunInput,
} from '../../src/jobs/ai/ai-run.repository';
import type { AiSpendSummary } from '../../src/jobs/ai/budget';
import type { EvidenceProjection } from '../../src/jobs/ai/evidence-context';
import type {
  AiCompletionRequest,
  AiCompletionResult,
  AiProvider,
} from '../../src/jobs/ai/provider/provider';

/* ------------------------------------------------------------------ */
/* 时钟                                                                */
/* ------------------------------------------------------------------ */

export class FakeAiClock implements AiClock {
  constructor(private current: Date = new Date('2026-09-24T02:00:00.000Z')) {}

  now(): Date {
    return new Date(this.current.getTime());
  }

  set(instant: Date | string): void {
    this.current = typeof instant === 'string' ? new Date(instant) : instant;
  }

  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

/* ------------------------------------------------------------------ */
/* 仓储                                                                */
/* ------------------------------------------------------------------ */

/** 被记录的一次写入。 */
export type RecordedWrite = {
  table: 'contents' | 'ai_runs' | 'sources' | 'event_evidence' | 'content_topics';
  id: string;
  data: Record<string, unknown>;
};

export type SeedContent = Partial<Omit<AiContentRecord, 'id'>> & { id: string };
export type SeedAiRun = {
  id: string;
  contentId: string | null;
  taskType: AiTaskType;
  createdAt: Date;
  estimatedCostUsd: number | null;
  status?: AiRunStatus;
};

export class InMemoryAiRepository implements AiRepository {
  readonly writes: RecordedWrite[] = [];
  readonly contents = new Map<string, AiContentRecord>();
  readonly topics: AiTopicRecord[] = [];
  readonly aiRuns = new Map<string, SeedAiRun>();
  readonly evidencesByEvent = new Map<string, EvidenceProjection[]>();
  /** `contents.ai_analysis` 的替身（按任务分区）。 */
  readonly analysis = new Map<string, Record<string, unknown>>();

  private nextRunId = 1000;

  /** 让测试能注入「startAiRun 直接失败」这类故障。 */
  failStartAiRun: Error | null = null;
  /** 让测试能注入「finishAiRun 失败」以验证失败路径不被吞掉。 */
  failFinishAiRun: Error | null = null;

  seedContent(content: SeedContent): void {
    this.contents.set(content.id, {
      id: content.id,
      title: content.title ?? '默认标题',
      bodyOriginal: content.bodyOriginal ?? null,
      bodyTranslated: content.bodyTranslated ?? null,
      language: content.language ?? 'en',
      eventId: content.eventId ?? null,
      source: content.source ?? {
        name: 'Anthropic',
        kind: SourceKind.OFFICIAL,
        tier: SourceTier.S,
        official: true,
      },
    });
  }

  seedEvidences(eventId: string, evidences: EvidenceProjection[]): void {
    this.evidencesByEvent.set(eventId, evidences);
  }

  seedAiRun(run: SeedAiRun): void {
    this.aiRuns.set(run.id, run);
  }

  async findContent(contentId: string): Promise<AiContentRecord | null> {
    return this.contents.get(contentId) ?? null;
  }

  async findEventEvidences(eventId: string): Promise<EvidenceProjection[]> {
    return this.evidencesByEvent.get(eventId) ?? [];
  }

  async listTopics(): Promise<AiTopicRecord[]> {
    return this.topics;
  }

  async startAiRun(input: StartAiRunInput): Promise<string> {
    if (this.failStartAiRun !== null) throw this.failStartAiRun;

    const id = String((this.nextRunId += 1));
    this.aiRuns.set(id, {
      id,
      contentId: input.contentId,
      taskType: input.taskType,
      // 真实实现用 DB 的 `default(now())`；替身用固定时刻，
      // 这样「业务日区间过滤」的断言不依赖真实时间。
      createdAt: new Date('2026-09-24T02:00:00.000Z'),
      estimatedCostUsd: null,
      status: AiRunStatus.RUNNING,
    });
    this.writes.push({
      table: 'ai_runs',
      id,
      data: { ...input, status: AiRunStatus.RUNNING },
    });
    return id;
  }

  async finishAiRun(input: FinishAiRunInput): Promise<void> {
    if (this.failFinishAiRun !== null) throw this.failFinishAiRun;

    const run = this.aiRuns.get(input.aiRunId);
    if (run === undefined) {
      throw new Error(`finishAiRun on unknown ai run: ${input.aiRunId}`);
    }
    // 复刻真实实现的「同一次 run 只收尾一次」语义。
    if (run.status !== AiRunStatus.RUNNING && run.status !== undefined) {
      throw new Error(`ai run ${input.aiRunId} was already finished as ${run.status}`);
    }

    run.status = input.status;
    run.estimatedCostUsd = input.estimatedCostUsd;

    this.writes.push({
      table: 'ai_runs',
      id: input.aiRunId,
      data: {
        status: input.status,
        inputTokens: input.inputTokens,
        outputTokens: input.outputTokens,
        estimatedCostUsd: input.estimatedCostUsd,
        durationMs: input.durationMs,
        errorCode: input.errorCode,
      },
    });

    this.applyArtifact(input);
  }

  /** 与真实实现的 `contentWriteFor()` + `mergeAnalysisSection()` 一一对应。 */
  private applyArtifact(input: FinishAiRunInput): void {
    const artifact: AiArtifact = input.artifact;
    if (artifact.kind === 'none') return;
    if (input.contentId === null) return;

    const content = this.contents.get(input.contentId);
    if (content === undefined) {
      throw new Error(`artifact targets unknown content: ${input.contentId}`);
    }

    if (artifact.kind === 'score') {
      this.writes.push({
        table: 'contents',
        id: input.contentId,
        data: {
          ...artifact.scoreUpdate,
          recommendationReason: artifact.recommendationReason,
          aiAnalysis: this.mergeSection(input.contentId, 'score', artifact.aiAnalysis),
        },
      });
      return;
    }

    // 真实实现里这条 update 只写 bodyTranslated 与 aiAnalysis。
    this.writes.push({
      table: 'contents',
      id: input.contentId,
      data: {
        bodyTranslated: artifact.bodyTranslated,
        // 译文落到 `translatedBody`，供断言「绝不写 bodyOriginal」。
        translatedBody: artifact.bodyTranslated,
        aiAnalysis: this.mergeSection(input.contentId, 'translation', artifact.aiAnalysis),
      },
    });
  }

  /**
   * 复刻真实实现的**按任务分区合并**。
   *
   * 替身必须同样复刻这一条，否则「SCORE 与 TRANSLATE 互相覆盖」
   * 这个真 bug 在单测里看不见（真实情况正是如此：独立审查是在真库上发现的）。
   */
  private mergeSection(
    contentId: string,
    section: 'score' | 'translation',
    patch: Record<string, unknown>,
  ): Record<string, unknown> {
    const current = this.analysis.get(contentId) ?? {};
    const merged = { ...current, [section]: patch };
    this.analysis.set(contentId, merged);
    return merged;
  }

  /** 读回某条内容当前的 `ai_analysis`（供跨任务断言）。 */
  readAnalysis(contentId: string): Record<string, unknown> {
    return this.analysis.get(contentId) ?? {};
  }

  async sumCostUsdBetween(from: Date, to: Date): Promise<AiSpendSummary> {
    let totalUsd = 0;
    let uncostedRuns = 0;

    for (const run of this.aiRuns.values()) {
      if (run.createdAt < from || run.createdAt >= to) continue;
      if (run.estimatedCostUsd === null) {
        uncostedRuns += 1;
        continue;
      }
      totalUsd += run.estimatedCostUsd;
    }

    return { totalUsd, uncostedRuns };
  }

  /** 所有 `contents` 写入涉及的列名（供「写入范围」断言使用）。 */
  contentWriteColumns(): string[] {
    return this.writes
      .filter((write) => write.table === 'contents')
      .flatMap((write) => Object.keys(write.data));
  }

  /** 所有被写过的表名。 */
  writtenTables(): string[] {
    return [...new Set(this.writes.map((write) => write.table))];
  }
}

/* ------------------------------------------------------------------ */
/* Provider                                                            */
/* ------------------------------------------------------------------ */

/**
 * 可编排的 provider 替身。
 *
 * 与真实 provider 一样**把失败收敛成 `AiError`**（而不是抛裸 Error）——
 * 否则重试判定测的就不是真实路径。
 */
export class FakeAiProvider implements AiProvider {
  readonly name = 'fake-openai-compatible';
  readonly requests: AiCompletionRequest[] = [];

  private readonly queue: (AiCompletionResult | Error)[] = [];
  private fallback: AiCompletionResult = ok('{}');

  /** 依次返回的结果；用完后回落到 `setDefault`。 */
  push(result: AiCompletionResult | Error): this {
    this.queue.push(result);
    return this;
  }

  setDefault(result: AiCompletionResult): this {
    this.fallback = result;
    return this;
  }

  async complete(request: AiCompletionRequest): Promise<AiCompletionResult> {
    this.requests.push(request);
    const next = this.queue.shift() ?? this.fallback;
    if (next instanceof Error) throw next;
    return next;
  }

  /** 最后一次请求的完整 prompt 文本（system + user 拼接）。 */
  lastPromptText(): string {
    const request = this.requests.at(-1);
    if (request === undefined) throw new Error('no request has been made yet');
    return request.messages.map((message) => message.content).join('\n');
  }
}

/** 构造一个成功的补全结果。 */
export function ok(
  text: string,
  usage: { inputTokens?: number | null; outputTokens?: number | null; model?: string } = {},
): AiCompletionResult {
  return {
    text,
    inputTokens: usage.inputTokens === undefined ? 1_000 : usage.inputTokens,
    outputTokens: usage.outputTokens === undefined ? 200 : usage.outputTokens,
    model: usage.model ?? 'gpt-4o-mini',
    durationMs: 42,
  };
}

/* ------------------------------------------------------------------ */
/* 配置                                                                */
/* ------------------------------------------------------------------ */

/** 一份可用的 AI 配置。 */
export function createTestAiConfig(overrides: Partial<AiConfig> = {}): AiConfig {
  return {
    provider: 'openai-compatible',
    baseUrl: 'http://127.0.0.1:9/v1',
    apiKey: 'test-key',
    models: { cheap: 'gpt-4o-mini', medium: 'gpt-4o-mini', strong: 'gpt-4o' },
    dailyBudgetUsd: 5,
    requestTimeoutMs: 1_000,
    ...overrides,
  };
}

/* ------------------------------------------------------------------ */
/* 构造合法 / 非法的模型输出                                            */
/* ------------------------------------------------------------------ */

/**
 * 一份合法的评分输出（**中文理由**，与真实生产形态一致 ——
 * 见 §23.3：测试数据偏离真实形态会让绿灯失去意义）。
 */
export function scoreOutputJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    dimensions: {
      importance: 88,
      relevance: 80,
      credibility: 90,
      novelty: 70,
      density: 75,
      readValue: 82,
    },
    reason: '官方一手发布，信息密度高，对关注模型能力的读者有明确的阅读价值。',
    topics: ['ai-models'],
    detectedLanguage: 'en',
    ...overrides,
  });
}

/** 一份合法的翻译输出。 */
export function translateOutputJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    translatedText: '这是一段中文译文。',
    detectedLanguage: 'en',
    summary: '中文摘要。',
    ...overrides,
  });
}

/**
 * 一份合法的证据行。
 *
 * `sourceOfficial` 默认 `false`（与 `Source.official` 的默认值一致）——
 * 显式传 `true` 才能构造「官方来源的证据」。
 * 注意它与「内容所属来源的 official」是**两件事**（见 evidence-context.ts）。
 */
export function evidence(
  id: string,
  sourceId: string | null,
  evidenceType: EvidenceType,
  isPrimary = false,
  sourceOfficial: boolean | null = sourceId === null ? null : false,
): EvidenceProjection {
  return { id, sourceId, sourceOfficial, evidenceType, isPrimary };
}

export { AiTaskType, AiRunStatus };
