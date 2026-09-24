/**
 * `AiRepository` 端口 —— AI 模块的持久化契约。
 *
 * 端口化的理由与 Agent 02/03/04 一致：单元测试可以用内存替身完整验证
 * 服务层行为（预算闸门、失败分类、AiRun 生命周期），不需要 MySQL；
 * 真实 SQL 语义再由 `ai-db.integration.spec.ts` 在真库上跑一遍。
 *
 * ── AiRun 的两阶段写入 ───────────────────────────────────────────────
 * `startAiRun()` 先落一条 `RUNNING`，跑完再 `finishAiRun()`。
 * 为什么不一次性在结束后写：
 *
 * 1. **在途调用可见**。`RUNNING` 行让运维能看到「现在有几个 AI 调用在飞」，
 *    而一次性写入会让一次卡住的调用在库里完全不可见。
 * 2. **失败也要留痕**。失败路径与成功路径走同一个收尾方法，
 *    不会出现「成功有记录、失败没记录」的不对称。
 *
 * 代价是崩溃时可能留下一条永远 `RUNNING` 的行。这被接受：
 * 它有上界（`requestTimeoutMs` 内必然结束或超时），
 * 而且「有一条可疑的 RUNNING」本身就是有用的信号，比彻底没有记录好。
 */

import type { AiRunStatus, AiTaskType } from '@signal/contracts';
import type { AiSpendSummary } from './budget';
import type { EvidenceProjection, SourceIdentity } from './evidence-context';

/** 注入 token。 */
export const AI_REPOSITORY = 'AI_REPOSITORY';

/** 供 AI 分析的内容投影（含来源身份，一次读出，避免 N+1）。 */
export type AiContentRecord = {
  id: string;
  title: string;
  bodyOriginal: string | null;
  bodyTranslated: string | null;
  language: string;
  eventId: string | null;
  source: SourceIdentity & { name: string };
};

/** 可选主题。 */
export type AiTopicRecord = {
  slug: string;
  name: string;
};

/** 开始一次 AiRun 的输入。 */
export type StartAiRunInput = {
  contentId: string | null;
  taskType: AiTaskType;
  provider: string;
  model: string;
  promptVersion: string;
};

/** 收尾时要写的产物。 */
export type AiArtifact =
  | {
      kind: 'score';
      /** 六维分数 + finalScore（**只含分数列**，见 `scoring.ts`）。 */
      scoreUpdate: Record<string, number>;
      /** 落 `contents.recommendation_reason`。 */
      recommendationReason: string;
      /** 落 `contents.ai_analysis` 的完整结构化输出。 */
      aiAnalysis: Record<string, unknown>;
    }
  | {
      kind: 'translation';
      /** 落 `contents.body_translated`。**不写任何原文列**（`docs/00`）。 */
      bodyTranslated: string;
      aiAnalysis: Record<string, unknown>;
    }
  | { kind: 'none' };

/** 收尾一次 AiRun。 */
export type FinishAiRunInput = {
  aiRunId: string;
  /** 产物要写到哪条内容上。`null` 表示这次 run 不绑定内容。 */
  contentId: string | null;
  status: AiRunStatus;
  inputTokens: number | null;
  outputTokens: number | null;
  estimatedCostUsd: number | null;
  durationMs: number;
  errorCode: string | null;
  /**
   * 产物。**只在成功时非空** —— 失败时传 `{kind:'none'}`，
   * 保证「写了一半的分数」不会留在库里。
   */
  artifact: AiArtifact;
};

export interface AiRepository {
  /** 读一条内容及其来源身份。不存在返回 `null`。 */
  findContent(contentId: string): Promise<AiContentRecord | null>;

  /**
   * 读某个事件的全部证据。
   *
   * 刻意按 `eventId` 读**全部**证据而不是只读 primary：
   * `independentSourceCount` 与 `hasOfficialConfirmation` 都需要看全量。
   */
  findEventEvidences(eventId: string): Promise<EvidenceProjection[]>;

  /** 读可选主题列表（供分类使用）。 */
  listTopics(): Promise<AiTopicRecord[]>;

  /** 落一条 `RUNNING` 的 AiRun，返回其 id。 */
  startAiRun(input: StartAiRunInput): Promise<string>;

  /**
   * 收尾 AiRun，并在**同一事务内**写入产物。
   *
   * 同一事务是必需的：否则可能出现「AiRun 记成 SUCCEEDED，但分数没写进去」，
   * 于是内容永远停在没分数的状态而 AiRun 说它成功了 —— 两边都无法自证。
   */
  finishAiRun(input: FinishAiRunInput): Promise<void>;

  /** 统计 `[from, to)` 内的成本合计（预算闸门用）。 */
  sumCostUsdBetween(from: Date, to: Date): Promise<AiSpendSummary>;
}
