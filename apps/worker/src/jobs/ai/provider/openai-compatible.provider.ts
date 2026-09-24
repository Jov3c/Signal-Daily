/**
 * OpenAI-compatible Chat Completions 实现（`docs/08`：「支持 OpenAI-compatible」）。
 *
 * 只依赖 Node 22 内置的全局 `fetch` —— 不引入任何 HTTP 客户端依赖。
 * 这一点是有意的：Worker 已经因为 BullMQ 背了 `ioredis`，
 * 而 `fetch` + `AbortSignal.timeout()` 足以覆盖「POST 一段 JSON、等一段 JSON」。
 *
 * ── 错误分类是本文件里唯一真正需要小心的地方 ────────────────────────
 * `docs/13` 对 AI 的重试分了三档，而 HTTP status 到这三档的映射
 * 并不是一一对应的，几个容易搞错的点：
 *
 * - **401 / 403 绝不能当瞬时失败**。它们是「凭据不对」，
 *   重试同一份坏 key 只会把额度烧光、把账号锁掉。
 *   （与 Agent 04 的 `SOURCE_FETCH_UNAUTHORIZED` 同一取舍。）
 * - **429 是瞬时失败**，哪怕它看起来像 4xx。
 * - **400 里有两种东西**：真的请求写错了（不该重试），
 *   以及「这个端不认 `response_format`」（`docs/13` 的 unsupported，也不该重试）。
 *   两者都不重试，但**错误码不同**，因为管理员要做的事不同。
 */

import type { AiConfig } from '../ai.config';
import {
  aiPermanentError,
  aiResponseInvalidError,
  aiTaskUnsupportedError,
  aiTransientError,
  aiUnauthorizedError,
} from '../ai.errors';
import type { AiCompletionRequest, AiCompletionResult, AiProvider } from './provider';

/** 上游返回体里出现这些词时，400 判为「不支持」而不是「请求写错」。 */
const UNSUPPORTED_HINTS = ['response_format', 'json_object', 'not supported', 'unsupported'];

/** OpenAI-compatible 的响应封套（只声明我们真正读取的部分）。 */
type ChatCompletionResponse = {
  model?: unknown;
  choices?: unknown;
  usage?: unknown;
};

type ChatCompletionErrorBody = {
  error?: { message?: unknown; type?: unknown };
};

export class OpenAiCompatibleProvider implements AiProvider {
  readonly name: string;

  constructor(
    private readonly config: Pick<AiConfig, 'baseUrl' | 'apiKey' | 'provider' | 'requestTimeoutMs'>,
    /** 便于测试注入；默认用全局 fetch。 */
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.name = config.provider;
  }

  async complete(request: AiCompletionRequest): Promise<AiCompletionResult> {
    const { baseUrl } = this.config;
    if (baseUrl === null) {
      // 端口层的兜底：服务层应当已经在更早的位置挡掉了未配置的情况，
      // 走到这里说明有人绕过了 `AiService`。仍然给一个带 kind 的错误，
      // 而不是让 `fetch(undefined)` 抛出一个无法分类的 TypeError。
      throw aiTransientError({ safeMessage: 'AI base URL is not configured' });
    }

    const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
    const startedAt = Date.now();
    const timeoutMs = request.timeoutMs ?? this.config.requestTimeoutMs;

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: this.buildHeaders(),
        body: JSON.stringify(this.buildBody(request)),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      // 网络层失败一律瞬时：ECONNRESET / DNS 抖动 / 超时都属于「再试一次可能就好」。
      throw aiTransientError({
        safeMessage: `AI request failed before a response was received (timeout ${timeoutMs}ms)`,
        cause: error,
      });
    }

    const durationMs = Date.now() - startedAt;

    if (!response.ok) {
      throw await this.toError(response);
    }

    return this.parseSuccess(response, request, durationMs);
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json',
    };
    // 空 key 是合法的（本地 ollama / vLLM 之类不鉴权），此时不发 Authorization。
    if (this.config.apiKey !== null && this.config.apiKey !== '') {
      headers.authorization = `Bearer ${this.config.apiKey}`;
    }
    return headers;
  }

  private buildBody(request: AiCompletionRequest): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: request.model,
      messages: request.messages.map((message) => ({
        role: message.role,
        content: message.content,
      })),
      temperature: request.temperature,
    };
    if (request.expectJsonObject) {
      body.response_format = { type: 'json_object' };
    }
    return body;
  }

  private async parseSuccess(
    response: Response,
    request: AiCompletionRequest,
    durationMs: number,
  ): Promise<AiCompletionResult> {
    const raw = await response.text();

    let parsed: ChatCompletionResponse;
    try {
      parsed = JSON.parse(raw) as ChatCompletionResponse;
    } catch (error) {
      // 200 + 非 JSON：网关/反代抽风时会吐 HTML 错误页。
      // 判为瞬时 —— 重试一次通常就好了，代价很低。
      throw aiTransientError({
        safeMessage: 'AI provider returned a 200 response with a non-JSON body',
        cause: error,
      });
    }

    const text = extractMessageText(parsed);
    if (text === null) {
      // 封套本身就不对（缺 choices / 缺 message.content）。
      // 这不是瞬时问题，重试同一个端点只会得到同样的形状。
      throw aiPermanentError({
        safeMessage: 'AI provider response is missing choices[0].message.content',
        upstreamStatus: response.status,
      });
    }

    const usage = extractUsage(parsed);
    return {
      text,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      model: typeof parsed.model === 'string' && parsed.model !== '' ? parsed.model : request.model,
      durationMs,
    };
  }

  private async toError(response: Response): Promise<Error> {
    const status = response.status;
    const body = await safeText(response);

    if (status === 401 || status === 403) {
      return aiUnauthorizedError(status);
    }

    if (status === 429 || status >= 500) {
      return aiTransientError({
        safeMessage: `AI provider transient failure (HTTP ${status})`,
        upstreamStatus: status,
      });
    }

    if (status === 400 || status === 422) {
      const message = extractUpstreamMessage(body) ?? '';
      if (looksUnsupported(message)) {
        return aiTaskUnsupportedError(
          `AI provider does not support this request shape (HTTP ${status}): ${message}`,
        );
      }
      return aiPermanentError({
        safeMessage: `AI provider rejected the request (HTTP ${status}): ${message}`,
        upstreamStatus: status,
      });
    }

    if (status === 404) {
      // 404 在 OpenAI-compatible 端点上最常见的原因是**模型名写错**。
      return aiPermanentError({
        safeMessage: `AI provider endpoint or model not found (HTTP 404): ${extractUpstreamMessage(body) ?? ''}`,
        upstreamStatus: status,
      });
    }

    return aiPermanentError({
      safeMessage: `AI provider returned an unexpected status (HTTP ${status})`,
      upstreamStatus: status,
    });
  }
}

function looksUnsupported(message: string): boolean {
  const lower = message.toLowerCase();
  return UNSUPPORTED_HINTS.some((hint) => lower.includes(hint));
}

/**
 * 读取上游错误信息，用于诊断。
 *
 * ⚠ 注意这里只取 `error.message`，而且**只用于日志与错误信息**，
 * 不会拼进任何对外响应。上游的原文可能包含我们请求的片段，
 * 而请求里带着采集正文 —— 不能整段回显（`docs/14`）。
 */
function extractUpstreamMessage(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as ChatCompletionErrorBody;
    const message = parsed.error?.message;
    return typeof message === 'string' ? truncate(message, 300) : null;
  } catch {
    return truncate(body, 300);
  }
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

/**
 * 取出 `choices[0].message.content`。
 *
 * 兼容两种形态：
 * - `string`（标准 chat completions）
 * - `Array<{type:'text', text:string}>`（多模态 / 部分网关）
 */
function extractMessageText(parsed: ChatCompletionResponse): string | null {
  const choices = parsed.choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;

  const first = choices[0] as { message?: { content?: unknown } } | undefined;
  const content = first?.message?.content;
  if (typeof content === 'string') return content;

  if (Array.isArray(content)) {
    const parts = content
      .map((part) => {
        const text = (part as { text?: unknown } | null)?.text;
        return typeof text === 'string' ? text : '';
      })
      .filter((text) => text !== '');
    return parts.length === 0 ? null : parts.join('');
  }

  return null;
}

/**
 * 读取 token 用量。
 *
 * 缺失时返回 `null` 而不是 `0`：`0` 会让成本估算得到「$0」，
 * 于是预算统计静默少算（见 `pricing.ts` 与 `budget.ts` 的说明）。
 * 这里宁可让成本是 `null`（会被单独计数并在快照里暴露），也不要一个假的 0。
 */
function extractUsage(parsed: ChatCompletionResponse): {
  inputTokens: number | null;
  outputTokens: number | null;
} {
  const usage = parsed.usage as
    { prompt_tokens?: unknown; completion_tokens?: unknown } | undefined;
  if (usage === undefined || usage === null) {
    return { inputTokens: null, outputTokens: null };
  }
  return {
    inputTokens: toTokenCount(usage.prompt_tokens),
    outputTokens: toTokenCount(usage.completion_tokens),
  };
}

function toTokenCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * 结构化输出校验失败时用的构造器 —— 由 `ai.service.ts` 在 schema 校验失败时调用，
 * 放在这里是为了让「provider 报的错」与「schema 报的错」用同一个 `AiError` 体系。
 */
export function invalidStructuredOutput(safeMessage: string, details?: unknown): Error {
  return aiResponseInvalidError(safeMessage, details);
}
