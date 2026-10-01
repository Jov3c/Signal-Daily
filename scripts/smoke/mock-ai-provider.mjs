#!/usr/bin/env node
/**
 * Mock AI Provider —— 冒烟测试专用的「OpenAI-compatible」本地服务。
 *
 * ── 为什么需要它 ────────────────────────────────────────────────────
 * 清单 P2-06 要求「先做可重复的 staging/manual smoke」。真实链路必须真跑，
 * 但 **AI Provider 是外部依赖、会产生真实调用成本**，所以用本地 mock 代替。
 *
 * ── 形状是从哪段代码推出来的（不是凭印象写的）────────────────────────
 * 逐条对着 `apps/worker/src/jobs/ai/provider/openai-compatible.provider.ts` 抄：
 *
 *   - 请求 URL：`${baseUrl}/chat/completions`（同文件 L65）
 *   - 请求体：`{ model, messages:[{role,content}], temperature,
 *     response_format?:{type:'json_object'} }`（同文件 L106–L119）
 *     —— 注意：`response_format` **只在 expectJsonObject 时**出现。
 *   - 成功响应：必须是 `{ model, choices:[{message:{content}}], usage }`，
 *     其中 `content` 可以是 string 或 `[{type:'text',text}]`（同文件 L252–L278）。
 *     我们返回 string 这一种（标准 chat completions）。
 *   - token 用量：`usage.prompt_tokens` / `usage.completion_tokens`
 *     （同文件 L287–L300）。缺失会记成 null 并让成本统计「少算」——
 *     所以我们**必须给**，哪怕数字是编的。
 *
 * 另外两处决定输出内容的代码：
 *   - 任务判定：`prompts/registry.ts` 的 system prompt 与
 *     `prompts/build-messages.ts` 的 user message（L90 / L107）。
 *     用户消息分别以「任务：为以下内容评分与分类。」与
 *     「任务：把以下正文翻译成简体中文，并给出中文摘要。」开头 —— 用它区分任务。
 *   - 输出字段必须精确匹配 `schema/classify-score.schema.ts`（`.strict()`）
 *     与 `schema/translate.schema.ts`（`.strict()`）：多一个键都会被判非法。
 *     topics 还必须是 kebab-case 的 slug（`^[a-z0-9]+(?:-[a-z0-9]+)*$`）。
 *
 * ── marker 的作用（可重复验证）──────────────────────────────────────
 * `SMOKE_AI_MARKER` 会被塞进译文（落 `contents.body_translated`）与摘要。
 * 冒烟脚本随后用 FULLTEXT 搜这个 marker：既能证明「AI 产物真的落库」，
 * 也能证明「Search 能搜到已发布内容」，且**不依赖真实 feed 的具体标题**。
 *
 * 用法：
 *   node scripts/smoke/mock-ai-provider.mjs            # 默认 127.0.0.1:3899
 *   SMOKE_MOCK_PORT=4000 node scripts/smoke/mock-ai-provider.mjs
 */

import { createServer } from 'node:http';

const HOST = process.env.SMOKE_MOCK_HOST ?? '127.0.0.1';
const PORT = Number(process.env.SMOKE_MOCK_PORT ?? 3899);
const MARKER = process.env.SMOKE_AI_MARKER ?? 'smoke-marker';

/** 固定分数：让同一次运行内的结果可预期（真实 prompt 温度也是 0）。 */
const SCORE_DIMENSIONS = {
  importance: 88,
  relevance: 86,
  credibility: 90,
  novelty: 79,
  density: 74,
  readValue: 83,
};

/** 真实 seed 的 8 个主题之一（`prisma/seed.ts`）。必须是 kebab-case slug。 */
const SCORE_TOPICS = ['ai-models'];

/**
 * 从 messages 里判定任务类型。
 *
 * 依据是 `build-messages.ts` 的 user message 首句（见文件头）。刻意用
 * 两个 `includes` 而不是精确相等：mock 不该因为 prompt 版本升级而失效。
 */
function detectTask(body) {
  const messages = body?.messages ?? [];
  // 只看 **system** 消息：它由 prompt registry 生成，不受不可信正文影响。
  const system = messages
    .filter((message) => message?.role === 'system')
    .map((message) => (typeof message?.content === 'string' ? message.content : ''))
    .join('\n');

  // ⚠ 用 prompt 里 JSON 模板的**键名**（纯 ASCII）做判定，而不是中文句子：
  // 中文依赖运行环境的编码（Windows 控制台/终端可能不是 UTF-8），
  // 而键名是 `prompts/registry.ts` 里逐字写死的（SCORE 有 `dimensions`、
  // TRANSLATE 有 `translatedText`）。这样 mock 不因编码或本地化而失效。
  if (system.includes('translatedText')) return 'TRANSLATE';
  if (system.includes('dimensions')) return 'SCORE';

  // 中文兜底（system 缺失或 prompt 被改到没有上述键时）。
  if (system.includes('翻译')) return 'TRANSLATE';
  if (system.includes('评分') || system.includes('打分')) return 'SCORE';

  const text = messages
    .map((message) => (typeof message?.content === 'string' ? message.content : ''))
    .join('\n');
  return text.includes('translatedText') ? 'TRANSLATE' : 'SCORE';
}

function buildContent(task) {
  if (task === 'TRANSLATE') {
    // 形状必须与 `translateOutputSchema`（.strict()）逐字一致。
    return JSON.stringify({
      translatedText:
        `【冒烟测试译文】${MARKER}\n\n` +
        '本段文字由 mock AI provider 生成，仅用于验证「翻译产物真的写入 contents.body_translated」。',
      detectedLanguage: 'en',
      summary: `冒烟测试摘要 ${MARKER}（mock 生成）`,
    });
  }
  // 形状必须与 `classifyScoreOutputSchema`（.strict()）逐字一致。
  return JSON.stringify({
    dimensions: SCORE_DIMENSIONS,
    reason: `冒烟测试评分理由 ${MARKER}：mock provider 按固定分数返回，用于验证评分链路。`,
    topics: SCORE_TOPICS,
    detectedLanguage: 'en',
  });
}

/** 粗略的 token 估算（只为让成本统计拿到一个非 null 的数字）。 */
function estimateTokens(body, content) {
  const inputChars = (body?.messages ?? []).reduce(
    (total, message) => total + (typeof message?.content === 'string' ? message.content.length : 0),
    0,
  );
  return {
    prompt_tokens: Math.max(1, Math.ceil(inputChars / 4)),
    completion_tokens: Math.max(1, Math.ceil(content.length / 4)),
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${HOST}:${PORT}`);

  if (req.method === 'GET' && url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, marker: MARKER }));
    return;
  }

  // OpenAI-compatible 的端点：`{baseUrl}/chat/completions`。
  // 兼容带不带 `/v1` 前缀两种 baseUrl。
  if (
    req.method === 'POST' &&
    (url.pathname === '/chat/completions' || url.pathname.endsWith('/chat/completions'))
  ) {
    let body;
    try {
      body = JSON.parse((await readBody(req)) || '{}');
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'invalid JSON request body' } }));
      return;
    }

    const task = detectTask(body);
    const content = buildContent(task, body);
    const usage = estimateTokens(body, content);

    // 记到 stderr：runner 收起来当诊断日志（stdout 留给别的用途）。
    process.stderr.write(
      `[mock-ai] ${task} model=${String(body?.model)} response_format=${JSON.stringify(
        body?.response_format ?? null,
      )}\n`,
    );

    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'chatcmpl-smoke',
        object: 'chat.completion',
        // `parseSuccess()` 优先用响应里的 model，取不到才回退请求里的。
        model: typeof body?.model === 'string' ? body.model : 'smoke-model',
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: { ...usage, total_tokens: usage.prompt_tokens + usage.completion_tokens },
      }),
    );
    return;
  }

  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: { message: `no route for ${req.method} ${url.pathname}` } }));
});

server.listen(PORT, HOST, () => {
  process.stderr.write(`[mock-ai] listening on http://${HOST}:${PORT} (marker=${MARKER})\n`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    // 兜底：连接没断干净也要退出。
    setTimeout(() => process.exit(0), 500).unref();
  });
}
