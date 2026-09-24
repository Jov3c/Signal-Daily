/**
 * 从模型返回的文本里取出 JSON。
 *
 * 即使请求里带了 `response_format: {type:'json_object'}`，真实世界里的
 * OpenAI-compatible 端点仍会时不时返回：
 *
 * - 外面套一层 ```` ```json ```` 围栏
 * - 前面加一句「好的，这是结果：」
 * - 后面跟一句「希望对你有帮助」
 *
 * 这些都不是「模型答错了」，而是**协议没被完全遵守**。
 * 如果直接 `JSON.parse` 整段文本就会失败，从而被判成 SCHEMA_INVALID ——
 * 结果是白重试一次、白花一次钱，而内容其实完全可用。
 *
 * 所以这里做一次**保守的**提取：只剥围栏、只截取第一个 `{` 到最后一个 `}`，
 * 且**仍然要求解析结果是一个对象**。不会试图修复被截断的 JSON
 * （那说明输出真的不完整，应当按 schema invalid 处理）。
 */

/** 去掉 ```` ```json ... ``` ```` 围栏。 */
function stripCodeFence(text: string): string {
  const fenced = /^\s*```(?:json|JSON)?\s*\n([\s\S]*?)\n?\s*```\s*$/.exec(text);
  return fenced?.[1] ?? text;
}

export type JsonExtractionResult =
  { ok: true; value: unknown } | { ok: false; reason: 'not_json' | 'not_an_object' };

/** 从模型文本里提取 JSON 对象。 */
export function extractJsonObject(text: string): JsonExtractionResult {
  const stripped = stripCodeFence(text).trim();

  const firstBrace = stripped.indexOf('{');
  const lastBrace = stripped.lastIndexOf('}');
  const candidate =
    firstBrace !== -1 && lastBrace > firstBrace
      ? stripped.slice(firstBrace, lastBrace + 1)
      : stripped;

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return { ok: false, reason: 'not_json' };
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: 'not_an_object' };
  }

  return { ok: true, value: parsed };
}
