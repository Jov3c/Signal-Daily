/**
 * 结构化输出校验的守卫。
 *
 * 最重要的两组：
 * 1. **多余字段必须失败**（`.strict()`）。`docs/08` 要求 AI 不能改写
 *    Source Tier / 不能自称官方 —— 如果模型试图输出 `sourceTier`，
 *    那必须是一次**可见的失败**，而不是被静默丢弃。
 * 2. **围栏与前后缀文本要被容忍**。真实 OpenAI-compatible 端点经常
 *    返回 ```json 围栏，把它当成 schema invalid 会白花一次钱。
 */

import { describe, expect, it } from 'vitest';
import { AiTaskType } from '@signal/contracts';
import { classifyScoreOutputSchema } from '../src/jobs/ai/schema/classify-score.schema';
import { extractJsonObject } from '../src/jobs/ai/schema/json-text';
import { normalizeLanguageCode, isValidLanguageCode } from '../src/jobs/ai/schema/language';
import { translateOutputSchema } from '../src/jobs/ai/schema/translate.schema';
import { parseStructuredOutput } from '../src/jobs/ai/schema/validate';
import { scoreOutputJson, translateOutputJson } from './support/ai-fakes';

const TASK = { taskType: AiTaskType.SCORE };

describe('JSON 提取', () => {
  it('接受裸 JSON 对象', () => {
    expect(extractJsonObject('{"a":1}')).toEqual({ ok: true, value: { a: 1 } });
  });

  it('剥掉 ```json 围栏', () => {
    const fenced = '```json\n{"a":1}\n```';
    expect(extractJsonObject(fenced)).toEqual({ ok: true, value: { a: 1 } });
  });

  it('剥掉无语言标记的围栏', () => {
    expect(extractJsonObject('```\n{"a":1}\n```')).toEqual({ ok: true, value: { a: 1 } });
  });

  it('容忍前后缀解说文字（截取第一个 { 到最后一个 }）', () => {
    const withProse = '好的，这是结果：\n{"a":1}\n希望对你有帮助。';
    expect(extractJsonObject(withProse)).toEqual({ ok: true, value: { a: 1 } });
  });

  it('非 JSON 返回 not_json', () => {
    expect(extractJsonObject('这不是 JSON')).toEqual({ ok: false, reason: 'not_json' });
  });

  it('被截断的 JSON 不尝试修复，按 not_json 处理', () => {
    expect(extractJsonObject('{"a": 1, "b":')).toEqual({ ok: false, reason: 'not_json' });
  });

  it('数组不算对象', () => {
    expect(extractJsonObject('[1,2,3]')).toEqual({ ok: false, reason: 'not_an_object' });
  });
});

describe('评分输出 schema', () => {
  it('接受一份合法的中文理由输出', () => {
    const parsed = parseStructuredOutput({
      text: scoreOutputJson(),
      schema: classifyScoreOutputSchema,
      ...TASK,
    });
    expect(parsed.dimensions.credibility).toBe(90);
    expect(parsed.reason).toContain('官方一手');
    expect(parsed.topics).toEqual(['ai-models']);
  });

  it('**拒绝** 模型试图输出的 sourceTier / official（strict）', () => {
    // 这是 docs/08「AI 不能修改 Source Tier / 不能自己宣布官方」在
    // 输出契约上的落点：这些字段没有容身之处。
    const attempt = scoreOutputJson({ sourceTier: 'S', official: true });
    expect(() =>
      parseStructuredOutput({ text: attempt, schema: classifyScoreOutputSchema, ...TASK }),
    ).toThrowError(/does not match the required schema/);
  });

  it('拒绝任何未声明的多余字段', () => {
    const attempt = scoreOutputJson({ confidence: 0.99 });
    expect(() =>
      parseStructuredOutput({ text: attempt, schema: classifyScoreOutputSchema, ...TASK }),
    ).toThrowError(/does not match the required schema/);
  });

  it('拒绝越界分数（> 100 / < 0）', () => {
    for (const bad of [101, -1]) {
      const attempt = scoreOutputJson({
        dimensions: {
          importance: bad,
          relevance: 80,
          credibility: 90,
          novelty: 70,
          density: 75,
          readValue: 82,
        },
      });
      expect(() =>
        parseStructuredOutput({ text: attempt, schema: classifyScoreOutputSchema, ...TASK }),
      ).toThrowError(/does not match the required schema/);
    }
  });

  it('拒绝缺维度的输出（不能靠部分分数蒙混过关）', () => {
    const attempt = scoreOutputJson({
      dimensions: { importance: 80, relevance: 80, credibility: 80, novelty: 80, density: 80 },
    });
    expect(() =>
      parseStructuredOutput({ text: attempt, schema: classifyScoreOutputSchema, ...TASK }),
    ).toThrowError(/does not match the required schema/);
  });

  it('拒绝非 kebab-case 的主题 slug（避免写进匹配不上任何 Topic 的值）', () => {
    const attempt = scoreOutputJson({ topics: ['AI 模型'] });
    expect(() =>
      parseStructuredOutput({ text: attempt, schema: classifyScoreOutputSchema, ...TASK }),
    ).toThrowError(/does not match the required schema/);
  });

  it('topics 允许为空数组（模型认为不属于任何已有主题）', () => {
    const parsed = parseStructuredOutput({
      text: scoreOutputJson({ topics: [] }),
      schema: classifyScoreOutputSchema,
      ...TASK,
    });
    expect(parsed.topics).toEqual([]);
  });

  it('失败时抛 AiError(SCHEMA_INVALID)，而不是裸 Error', () => {
    try {
      parseStructuredOutput({ text: '不是 JSON', schema: classifyScoreOutputSchema, ...TASK });
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toMatchObject({ kind: 'SCHEMA_INVALID', code: 'AI_RESPONSE_INVALID' });
    }
  });

  it('错误详情不回显完整原始文本（避免把采集正文带进日志）', () => {
    const huge = `不是 JSON ${'中'.repeat(5_000)}`;
    try {
      parseStructuredOutput({ text: huge, schema: classifyScoreOutputSchema, ...TASK });
      throw new Error('should have thrown');
    } catch (error) {
      const details = (error as { details?: { rawTextPreview?: string } }).details;
      expect(details?.rawTextPreview?.length ?? 0).toBeLessThan(600);
    }
  });
});

describe('翻译输出 schema', () => {
  it('接受合法输出', () => {
    const parsed = parseStructuredOutput({
      text: translateOutputJson(),
      schema: translateOutputSchema,
      taskType: AiTaskType.TRANSLATE,
    });
    expect(parsed.translatedText).toBe('这是一段中文译文。');
  });

  it('**拒绝**模型试图回传 originalText（docs/00：翻译不得覆盖原文）', () => {
    const attempt = translateOutputJson({ originalText: '被改写的原文' });
    expect(() =>
      parseStructuredOutput({
        text: attempt,
        schema: translateOutputSchema,
        taskType: AiTaskType.TRANSLATE,
      }),
    ).toThrowError(/does not match the required schema/);
  });

  it('拒绝空译文', () => {
    const attempt = translateOutputJson({ translatedText: '' });
    expect(() =>
      parseStructuredOutput({
        text: attempt,
        schema: translateOutputSchema,
        taskType: AiTaskType.TRANSLATE,
      }),
    ).toThrowError(/does not match the required schema/);
  });

  it('summary 可选', () => {
    const withoutSummary = JSON.stringify({ translatedText: '中文。', detectedLanguage: 'en' });
    const parsed = parseStructuredOutput({
      text: withoutSummary,
      schema: translateOutputSchema,
      taskType: AiTaskType.TRANSLATE,
    });
    expect(parsed.summary).toBeUndefined();
  });
});

describe('语言代码规范化', () => {
  it('把各种写法收敛到 ll / ll-RR', () => {
    expect(normalizeLanguageCode('en')).toBe('en');
    expect(normalizeLanguageCode('EN')).toBe('en');
    expect(normalizeLanguageCode('zh-CN')).toBe('zh-CN');
    expect(normalizeLanguageCode('zh_cn')).toBe('zh-CN');
    expect(normalizeLanguageCode('Chinese')).toBe('zh');
    expect(normalizeLanguageCode('English')).toBe('en');
  });

  it('无法塞进 CHAR(5) 的写法回退到主语言（而不是被数据库截断）', () => {
    expect(normalizeLanguageCode('zh-Hans-CN')).toBe('zh');
    expect(normalizeLanguageCode('zh-Hans')).toBe('zh');
  });

  it('非法输入返回 null', () => {
    expect(normalizeLanguageCode('')).toBeNull();
    expect(normalizeLanguageCode('zzz')).toBeNull();
    expect(normalizeLanguageCode(42)).toBeNull();
    expect(normalizeLanguageCode(null)).toBeNull();
  });

  it('规范化后的结果一定满足 CHAR(5)', () => {
    for (const input of ['en', 'zh-CN', 'Chinese', 'zh-Hans-CN', 'pt-BR', 'ja']) {
      const normalized = normalizeLanguageCode(input);
      expect(normalized).not.toBeNull();
      expect(normalized!.length).toBeLessThanOrEqual(5);
      expect(isValidLanguageCode(normalized!)).toBe(true);
    }
  });
});
