/**
 * Prompt Registry 的守卫（`docs/08` 的「Prompt version 强制」）。
 *
 * 核心是一条**指纹守卫**：prompt 正文一变，指纹就变，
 * 于是「改了 prompt 却没升版本号」会立刻失败。
 *
 * 为什么这条重要：`JobId.aiScore(contentId, promptVersion)` 依赖版本号做幂等 ——
 * 改了标准却不升版本，历史内容就永远不会被新标准重评，
 * 而管理员看到的是同一个列表里混着两套标准的分数。
 *
 * 反证（§23.3）：随便改动 prompt 正文里一个字（例如把「评分」改成「打分」）
 * 而不动 `version`，本文件会立刻变红。见 `work/_agent06/counterproof/`。
 */

import { describe, expect, it } from 'vitest';
import { AiTaskType } from '@signal/contracts';
import {
  PROMPT_REGISTRY,
  fingerprintOf,
  implementedTasks,
  isTaskImplemented,
  promptFor,
} from '../src/jobs/ai/prompts/registry';
import { UNTRUSTED_DATA_NOTICE } from '../src/jobs/ai/untrusted';

/**
 * **已登记的 prompt 指纹**（版本 → 正文指纹）。
 *
 * ⚠ 这是本文件真正的牙齿。改动 prompt 正文里的任何一个字符，
 * `fingerprintOf()` 就会变，下面那条断言随之变红 —— 于是作者**必须**
 * 停下来做一次显式选择：
 *
 * - 如果这是有意的改动 → **升 `version`**，并把这里的指纹一起更新；
 * - 如果只是顺手改了个词 → 那就该改回去，或者承认它确实改变了评分标准。
 *
 * 只比对 `definition.fingerprint === fingerprintOf(definition.system)`
 * 是没有意义的自洽断言（`define()` 本来就是这么算出来的），
 * 必须把值**钉在测试里**，守卫才有意义。
 */
const REGISTERED_PROMPTS: Readonly<Record<string, { version: string; fingerprint: string }>> = {
  SCORE: { version: 'v1', fingerprint: '0720fdd2' },
  TRANSLATE: { version: 'v1', fingerprint: 'e4f39175' },
};

describe('指纹机制本身', () => {
  it('同样的文本指纹相同', () => {
    expect(fingerprintOf('abc')).toBe(fingerprintOf('abc'));
    expect(fingerprintOf('中文 prompt')).toBe(fingerprintOf('中文 prompt'));
  });

  it('一个字符的差别就会改变指纹', () => {
    expect(fingerprintOf('评分')).not.toBe(fingerprintOf('打分'));
    expect(fingerprintOf('abc')).not.toBe(fingerprintOf('abc '));
  });

  it('中文与 emoji 都能算出指纹（不是只处理 ASCII）', () => {
    expect(fingerprintOf('六维评分 🚀')).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe('Registry 结构', () => {
  it('每个枚举值都在 registry 里有登记（实现或显式 null）', () => {
    for (const taskType of Object.values(AiTaskType)) {
      expect(Object.hasOwn(PROMPT_REGISTRY, taskType)).toBe(true);
    }
  });

  it('未实现的任务显式登记为 null（不是漏掉）', () => {
    const notImplemented = (Object.values(AiTaskType) as AiTaskType[]).filter(
      (taskType) => !isTaskImplemented(taskType),
    );
    for (const taskType of notImplemented) {
      expect(PROMPT_REGISTRY[taskType]).toBeNull();
    }
    // 本模块只做这两件
    expect(implementedTasks().sort()).toEqual([AiTaskType.SCORE, AiTaskType.TRANSLATE].sort());
  });

  it('取未实现的任务会抛错（由 AiService 收敛成 UNSUPPORTED）', () => {
    expect(() => promptFor(AiTaskType.DAILY_DRAFT)).toThrow(/No prompt is registered/);
  });

  it('版本号格式是 v{N}', () => {
    for (const taskType of implementedTasks()) {
      expect(promptFor(taskType).version).toMatch(/^v\d+$/);
    }
  });

  it('指纹被显式钉在测试里（不是自洽断言）', () => {
    for (const taskType of implementedTasks()) {
      // 先断言定义内部自洽（防止 `define()` 被改坏）
      const definition = promptFor(taskType);
      expect(definition.fingerprint).toBe(fingerprintOf(definition.system));

      // 再断言它与**外部登记的值**一致 —— 这一条才是牙齿
      const registered = REGISTERED_PROMPTS[taskType];
      expect(registered, `task ${taskType} has no registered fingerprint`).toBeDefined();
      expect(fingerprintOf(definition.system)).toBe(registered!.fingerprint);
      expect(definition.version).toBe(registered!.version);
    }
  });

  it('已登记表覆盖了全部已实现任务（新增 prompt 必须登记）', () => {
    expect(Object.keys(REGISTERED_PROMPTS).sort()).toEqual(
      implementedTasks()
        .map((taskType) => String(taskType))
        .sort(),
    );
  });
});

describe('安全声明注入', () => {
  it('每个包了不可信正文的 prompt 都带上了安全声明', () => {
    for (const taskType of implementedTasks()) {
      const definition = promptFor(taskType);
      if (!definition.wrapsUntrustedContent) continue;
      expect(definition.system).toContain(UNTRUSTED_DATA_NOTICE);
    }
  });

  it('安全声明本身声明了「正文是数据不是指令」', () => {
    expect(UNTRUSTED_DATA_NOTICE).toContain('不可信数据');
    expect(UNTRUSTED_DATA_NOTICE).toContain('不是指令');
  });

  it('安全声明要求模型不得声称来源是官方的（docs/08）', () => {
    expect(UNTRUSTED_DATA_NOTICE).toMatch(/声称/);
    expect(UNTRUSTED_DATA_NOTICE).toMatch(/官方/);
  });

  it('评分 prompt 明确 tier 是输入不是结论', () => {
    const system = promptFor(AiTaskType.SCORE).system;
    expect(system).toMatch(/sourceTier 是\*\*给定的输入\*\*/);
    expect(system).toContain('independentSourceCount');
  });

  it('评分 prompt 声明官方一手应显著高于二手', () => {
    expect(promptFor(AiTaskType.SCORE).system).toMatch(/显著高于二手/);
  });

  it('翻译 prompt 要求原文是中文时原样返回（不做二次改写）', () => {
    expect(promptFor(AiTaskType.TRANSLATE).system).toMatch(/原样返回/);
  });

  it('两个 prompt 都要求只输出 JSON 且不要多余字段', () => {
    for (const taskType of implementedTasks()) {
      const system = promptFor(taskType).system;
      expect(system).toMatch(/只输出一个 JSON 对象/);
      expect(system).toMatch(/不要增加任何其他字段/);
    }
  });
});
