/**
 * `AiProvider` 端口 —— `docs/08`：「业务代码只调用统一 `AiProvider`」。
 *
 * 业务代码（`ai.service.ts` 与所有 Job handler）**只能**依赖这个接口，
 * 不得直接 `fetch`、不得 import 具体实现。这样换 provider
 * （OpenAI-compatible → Anthropic / Gemini，见 `docs/08`）时，
 * 改动被限制在 `provider/` 目录内。
 *
 * 与 Agent 02/03/04 的端口模式一致：全部外部依赖都是可注入的 provider token，
 * 因此单元测试可以在**不联网**的情况下跑完整条流水线；
 * 真实 HTTP 语义由 `ai-provider-openai.spec.ts` 打本地 HTTP server 验证。
 */

/** 注入 token。 */
export const AI_PROVIDER = 'AI_PROVIDER';

export type AiMessageRole = 'system' | 'user' | 'assistant';

export type AiMessage = {
  role: AiMessageRole;
  content: string;
};

export type AiCompletionRequest = {
  /** 模型名（由 `TASK_MODEL_TIER` + `AiConfig.models` 决定，不由业务代码自由填）。 */
  model: string;
  messages: readonly AiMessage[];
  /**
   * 是否要求上游返回 JSON object。
   *
   * 这只是**提示**。真正的结构化保证是本模块自己的 schema 校验
   * （见 `schema/`）——上游说「我返回 JSON」不等于它一定返回合法 JSON，
   * 更不等于它一定返回我们要的字段。
   */
  expectJsonObject: boolean;
  /** 采样温度。评分类任务用 0，让同一份输入尽量得到同一个分数。 */
  temperature: number;
  /** 覆盖配置里的默认超时（毫秒）。 */
  timeoutMs?: number;
};

export type AiCompletionResult = {
  /** 模型返回的原始文本。 */
  text: string;
  /** 上游自报的输入 token 数；未提供时为 `null`（**不要当作 0**）。 */
  inputTokens: number | null;
  /** 上游自报的输出 token 数；未提供时为 `null`。 */
  outputTokens: number | null;
  /** 实际提供服务的模型名。 */
  model: string;
  /** 本次调用耗时（毫秒）。 */
  durationMs: number;
};

/**
 * 统一 AI 提供方。
 *
 * 实现**必须**把失败收敛为 `AiError`（带正确的 `kind`），
 * 因为 `kind` 决定了 BullMQ 的重试次数（见 `ai.errors.ts`）。
 * 抛出裸 `Error` 会让调用方只能按「未知错误」处理，进而重试不该重试的请求。
 */
export interface AiProvider {
  /** provider 名（落 `ai_runs.provider`）。 */
  readonly name: string;
  complete(request: AiCompletionRequest): Promise<AiCompletionResult>;
}
