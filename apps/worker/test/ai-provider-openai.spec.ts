/**
 * OpenAI-compatible provider 的守卫 —— **打真实 HTTP，不 mock `fetch`**。
 *
 * ── 为什么必须真起一个 server（§23.3）────────────────────────────────
 * 这个文件要验的东西有一半是**协议层面**的：URL 拼得对不对、
 * `Authorization` 发没发、`response_format` 的形状、超时是不是真的会中断。
 * 用 `vi.fn()` 替换 `fetch` 只能证明「我们调用了一个假函数」，
 * 拼错的路径、漏发的头、写反的 body 字段**一个都不会被发现** ——
 * 而那恰好是「接口看起来通了但模型永远收不到正文」的全部成因。
 *
 * 本地 server 同时让我们能构造真实上游会返回的各种畸形响应
 * （200 + HTML 错误页、缺 choices 的 JSON、纯文本 400），
 * 而这些正是错误分类最容易搞错的地方。
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OpenAiCompatibleProvider } from '../src/jobs/ai/provider/openai-compatible.provider';
import { createTestAiConfig, ok } from './support/ai-fakes';

type Handler = (request: IncomingMessage, body: unknown, response: ServerResponse) => void;

let server: Server;
let baseUrl: string;
let handler: Handler;
/** 最近一次收到的请求（用于断言请求形状）。 */
let lastRequest: { url: string; headers: IncomingMessage['headers']; body: unknown } | null = null;

function json(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(payload));
}

beforeAll(async () => {
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = raw;
      }
      lastRequest = { url: request.url ?? '', headers: request.headers, body: parsed };
      handler(request, parsed, response);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function provider(config: Partial<Parameters<typeof createTestAiConfig>[0]> = {}) {
  return new OpenAiCompatibleProvider(createTestAiConfig({ baseUrl, ...config }));
}

const REQUEST = {
  model: 'gpt-4o-mini',
  messages: [
    { role: 'system' as const, content: 'system prompt' },
    { role: 'user' as const, content: '用户正文' },
  ],
  expectJsonObject: true,
  temperature: 0,
};

describe('请求形状', () => {
  it('POST 到 {baseUrl}/chat/completions，并带上 bearer 头', async () => {
    handler = (_request, _body, response) =>
      json(response, 200, { model: 'gpt-4o-mini', choices: [{ message: { content: '{}' } }] });

    await provider({ apiKey: 'sk-test-123' }).complete(REQUEST);

    expect(lastRequest?.url).toBe('/chat/completions');
    expect(lastRequest?.headers.authorization).toBe('Bearer sk-test-123');
    expect(lastRequest?.headers['content-type']).toBe('application/json');
  });

  it('baseUrl 末尾带斜杠也不会拼出双斜杠', async () => {
    handler = (_request, _body, response) =>
      json(response, 200, { choices: [{ message: { content: '{}' } }] });

    await new OpenAiCompatibleProvider(
      createTestAiConfig({ baseUrl: `${baseUrl}/`, apiKey: 'k' }),
    ).complete(REQUEST);

    expect(lastRequest?.url).toBe('/chat/completions');
  });

  it('apiKey 为空时不发 Authorization（本地 ollama 之类不鉴权）', async () => {
    handler = (_request, _body, response) =>
      json(response, 200, { choices: [{ message: { content: '{}' } }] });

    await provider({ apiKey: '' }).complete(REQUEST);

    expect(lastRequest?.headers.authorization).toBeUndefined();
  });

  it('body 里带 model / messages / temperature / response_format', async () => {
    handler = (_request, _body, response) =>
      json(response, 200, { choices: [{ message: { content: '{}' } }] });

    await provider().complete(REQUEST);

    expect(lastRequest?.body).toEqual({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'system prompt' },
        { role: 'user', content: '用户正文' },
      ],
      temperature: 0,
      response_format: { type: 'json_object' },
    });
  });

  it('expectJsonObject 为 false 时不发 response_format', async () => {
    handler = (_request, _body, response) =>
      json(response, 200, { choices: [{ message: { content: '{}' } }] });

    await provider().complete({ ...REQUEST, expectJsonObject: false });

    expect(lastRequest?.body).not.toHaveProperty('response_format');
  });

  it('中文正文原样发出（不被转义损坏）', async () => {
    handler = (_request, _body, response) =>
      json(response, 200, { choices: [{ message: { content: '{}' } }] });

    await provider().complete({
      ...REQUEST,
      messages: [{ role: 'user', content: '模型推理成本下降了 40%' }],
    });

    const body = lastRequest?.body as { messages: { content: string }[] };
    expect(body.messages[0]?.content).toBe('模型推理成本下降了 40%');
  });
});

describe('成功响应解析', () => {
  it('解析 string 形态的 content 与 usage', async () => {
    handler = (_request, _body, response) =>
      json(response, 200, {
        model: 'gpt-4o-mini-2024-07-18',
        choices: [{ message: { content: '{"a":1}' } }],
        usage: { prompt_tokens: 120, completion_tokens: 30 },
      });

    const result = await provider().complete(REQUEST);

    expect(result.text).toBe('{"a":1}');
    expect(result.inputTokens).toBe(120);
    expect(result.outputTokens).toBe(30);
    // 上游自报的模型名优先（别名解析后的真实模型）
    expect(result.model).toBe('gpt-4o-mini-2024-07-18');
  });

  it('解析数组形态的 content（部分网关的多模态输出）', async () => {
    handler = (_request, _body, response) =>
      json(response, 200, {
        choices: [
          {
            message: {
              content: [
                { type: 'text', text: '{"a":' },
                { type: 'text', text: '1}' },
              ],
            },
          },
        ],
      });

    const result = await provider().complete(REQUEST);
    expect(result.text).toBe('{"a":1}');
  });

  it('usage 缺失时 token 为 null（**不是 0**，否则预算会静默少算）', async () => {
    handler = (_request, _body, response) =>
      json(response, 200, { choices: [{ message: { content: '{}' } }] });

    const result = await provider().complete(REQUEST);

    expect(result.inputTokens).toBeNull();
    expect(result.outputTokens).toBeNull();
  });

  it('上游没给 model 时回落到我们请求的模型名', async () => {
    handler = (_request, _body, response) =>
      json(response, 200, { choices: [{ message: { content: '{}' } }] });

    const result = await provider().complete(REQUEST);
    expect(result.model).toBe('gpt-4o-mini');
  });
});

describe('错误分类（决定重试次数，必须准确）', () => {
  it('401 → UNAUTHORIZED，且不重试', async () => {
    handler = (_request, _body, response) =>
      json(response, 401, { error: { message: 'invalid api key' } });

    await expect(provider().complete(REQUEST)).rejects.toMatchObject({
      kind: 'UNAUTHORIZED',
      code: 'AI_PROVIDER_UNAUTHORIZED',
      retryPolicy: { attempts: 0 },
    });
  });

  it('403 → UNAUTHORIZED（不是瞬时）', async () => {
    handler = (_request, _body, response) =>
      json(response, 403, { error: { message: 'forbidden' } });

    await expect(provider().complete(REQUEST)).rejects.toMatchObject({ kind: 'UNAUTHORIZED' });
  });

  it('429 → TRANSIENT（3 次）', async () => {
    handler = (_request, _body, response) =>
      json(response, 429, { error: { message: 'slow down' } });

    await expect(provider().complete(REQUEST)).rejects.toMatchObject({
      kind: 'TRANSIENT',
      retryPolicy: { attempts: 3 },
    });
  });

  it('500 → TRANSIENT', async () => {
    handler = (_request, _body, response) => json(response, 500, { error: { message: 'boom' } });
    await expect(provider().complete(REQUEST)).rejects.toMatchObject({ kind: 'TRANSIENT' });
  });

  it('503 → TRANSIENT', async () => {
    handler = (_request, _body, response) => json(response, 503, {});
    await expect(provider().complete(REQUEST)).rejects.toMatchObject({ kind: 'TRANSIENT' });
  });

  it('400 提到 response_format → UNSUPPORTED（换端点，不是重试）', async () => {
    handler = (_request, _body, response) =>
      json(response, 400, {
        error: { message: 'Unrecognized request argument supplied: response_format' },
      });

    await expect(provider().complete(REQUEST)).rejects.toMatchObject({
      kind: 'UNSUPPORTED',
      code: 'AI_TASK_UNSUPPORTED',
    });
  });

  it('400 是普通请求错误 → PERMANENT（不重试）', async () => {
    handler = (_request, _body, response) =>
      json(response, 400, { error: { message: 'messages must not be empty' } });

    await expect(provider().complete(REQUEST)).rejects.toMatchObject({
      kind: 'PERMANENT',
      retryPolicy: { attempts: 0 },
    });
  });

  it('404（模型名写错）→ PERMANENT 且错误信息里带上游原文', async () => {
    handler = (_request, _body, response) =>
      json(response, 404, { error: { message: 'model gpt-nope not found' } });

    await expect(provider().complete(REQUEST)).rejects.toMatchObject({
      kind: 'PERMANENT',
      safeMessage: expect.stringContaining('gpt-nope'),
    });
  });

  it('200 但返回 HTML（网关抽风）→ TRANSIENT', async () => {
    handler = (_request, _body, response) => {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<html>502 Bad Gateway</html>');
    };

    await expect(provider().complete(REQUEST)).rejects.toMatchObject({ kind: 'TRANSIENT' });
  });

  it('200 但 JSON 里没有 choices → PERMANENT（重试同一个端点没有意义）', async () => {
    handler = (_request, _body, response) =>
      json(response, 200, { id: 'x', object: 'chat.completion' });

    await expect(provider().complete(REQUEST)).rejects.toMatchObject({ kind: 'PERMANENT' });
  });

  it('200 但 message.content 是 null → PERMANENT', async () => {
    handler = (_request, _body, response) =>
      json(response, 200, { choices: [{ message: { content: null } }] });

    await expect(provider().complete(REQUEST)).rejects.toMatchObject({ kind: 'PERMANENT' });
  });

  it('连不上（端口关闭）→ TRANSIENT，而不是未分类的 TypeError', async () => {
    // 127.0.0.1:9 是 discard 端口，本机不可达
    const unreachable = new OpenAiCompatibleProvider(
      createTestAiConfig({ baseUrl: 'http://127.0.0.1:9', apiKey: 'k' }),
    );

    await expect(unreachable.complete(REQUEST)).rejects.toMatchObject({
      kind: 'TRANSIENT',
      code: 'AI_REQUEST_FAILED',
    });
  });

  it('上游挂着不响应 → 超时并被判为 TRANSIENT', async () => {
    handler = () => {
      /* 故意不响应，让客户端超时 */
    };
    const slowConfig = createTestAiConfig({ baseUrl, requestTimeoutMs: 200 });

    await expect(new OpenAiCompatibleProvider(slowConfig).complete(REQUEST)).rejects.toMatchObject({
      kind: 'TRANSIENT',
    });

    // 收尾：把挂起的连接放掉，避免影响后续用例
    setTimeout(() => server.closeAllConnections?.(), 0);
  }, 10_000);
});

describe('未配置', () => {
  it('baseUrl 为 null 时抛带 kind 的错误（不是 fetch(undefined) 的 TypeError）', async () => {
    const unconfigured = new OpenAiCompatibleProvider(createTestAiConfig({ baseUrl: null }));
    await expect(unconfigured.complete(REQUEST)).rejects.toMatchObject({
      code: 'AI_REQUEST_FAILED',
    });
  });
});

describe('默认成功结果工具', () => {
  it('ok() 生成的 usage 是数字而不是 null（测试语义清晰）', () => {
    const result = ok('{}');
    expect(typeof result.inputTokens).toBe('number');
  });
});
