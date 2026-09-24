/**
 * 结构化输出的统一入口：**模型文本 → 校验过的对象**。
 *
 * 所有任务都必须走这里，不允许任何 handler 自己 `JSON.parse` ——
 * 因为「失败时算哪一类错」直接决定了重试策略（`docs/13`：
 * schema invalid 只重试 1 次），而这个判断只能有一处。
 */

import type { ZodType } from 'zod';
import { aiResponseInvalidError } from '../ai.errors';
import { extractJsonObject } from './json-text';

/** 原始文本在错误详情里的最大长度。 */
const RAW_TEXT_PREVIEW_CHARS = 500;

function preview(text: string): string {
  return text.length <= RAW_TEXT_PREVIEW_CHARS
    ? text
    : `${text.slice(0, RAW_TEXT_PREVIEW_CHARS)}…[truncated]`;
}

/**
 * 解析并校验模型的输出。
 *
 * @throws `AiError`（`kind: 'SCHEMA_INVALID'`）—— 调用方据此拿到
 *         `AI_RETRY.schemaInvalid`（重试 1 次）。
 */
export function parseStructuredOutput<T>(params: {
  text: string;
  schema: ZodType<T>;
  taskType: string;
}): T {
  const extracted = extractJsonObject(params.text);

  if (!extracted.ok) {
    throw aiResponseInvalidError(
      `AI output for ${params.taskType} is not a JSON object (${extracted.reason})`,
      { taskType: params.taskType, rawTextPreview: preview(params.text) },
    );
  }

  const parsed = params.schema.safeParse(extracted.value);
  if (!parsed.success) {
    throw aiResponseInvalidError(
      `AI output for ${params.taskType} does not match the required schema`,
      {
        taskType: params.taskType,
        // 只保留路径与原因。**不回显完整的 `input`** —— 它是未经校验的
        // 模型输出，可能带上一段采集正文，而错误详情会进日志（docs/14）。
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          code: issue.code,
          message: issue.message,
        })),
      },
    );
  }

  return parsed.data;
}
