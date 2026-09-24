/**
 * AI 模块的**写入范围**守卫 —— 扫整个模块目录，不只是 `ai.service.ts`。
 *
 * ── 这个文件为什么存在（独立审查 P2）────────────────────────────────
 * 第一版把这几条约束写成了「扫 `ai.service.ts` 的源码」的断言。
 * 但 `ai.service.ts` 里**一次 Prisma 调用都没有** —— 真正写库的全部在
 * `prisma-ai-run.repository.ts`。于是那条断言对目标文件恒真，
 * 而把它要守的东西改坏（例如给写入加一个 `pipelineStatus: 'APPROVED'`）
 * 时，**886 项单测 + 21 项集成测试全绿**。
 *
 * 同时，两处注释引用了 `ai-score-write-scope.spec.ts`，而该文件**并不存在**
 * —— 声称被守住的约束实际上没有任何东西在守。
 *
 * 现在这个文件真的存在，并且：
 * - 扫描范围是 `src/jobs/ai/**` 的**全部** `.ts`（新增文件自动纳入）；
 * - 断言的模式是**写操作**而不是字段名出现（否则解释性注释会把守卫顶红，
 *   等于惩罚好注释）；
 * - 剥注释后再扫，并**反证剥注释本身有效**。
 *
 * 行为层与真库层的对应断言在 `ai-db.integration.spec.ts`（前后快照对比）。
 * 两者都要：静态扫描覆盖**所有**代码路径，真库快照覆盖**真实 SQL 语义**。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const MODULE_DIR = fileURLToPath(new URL('../src/jobs/ai', import.meta.url));

/** 递归收集模块目录下的全部 `.ts` 文件。 */
function collectSourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      found.push(...collectSourceFiles(full));
      continue;
    }
    if (entry.endsWith('.ts')) found.push(full);
  }
  return found;
}

/**
 * 去掉注释。
 *
 * 本模块的注释里大量引用 `pipelineStatus` / `sources` 这些名字
 * （正是在解释「为什么不能碰它们」）。不剥注释的话，写得越清楚的注释
 * 越容易把守卫顶红。
 */
function stripComments(source: string): string {
  return (
    source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      // 前置 `[^:]` 避免把 `https://` 当成行注释起点
      .replace(/(^|[^:])\/\/.*$/gm, '$1')
  );
}

/** 全部源码（剥注释）。 */
function moduleSources(): { file: string; code: string; raw: string }[] {
  return collectSourceFiles(MODULE_DIR).map((file) => {
    const raw = readFileSync(file, 'utf8');
    return { file: file.slice(MODULE_DIR.length + 1), code: stripComments(raw), raw };
  });
}

/**
 * 取出所有 Prisma **写调用**的实参文本。
 *
 * 用配平括号精确切出 `update({ ... })` 的实参，而不是取固定长度的窗口 ——
 * 窗口会溢出到下一条语句，把「读投影」误判成「写」。
 *
 * 为什么需要它：`bodyOriginal` 在本模块里合法地出现在**读投影类型**
 * （`AiContentRecord.bodyOriginal`）上，只有出现在**写调用的实参**里才是违规。
 * 第一版直接匹配 `/bodyOriginal\s*:/` 就把读投影打成了违规。
 */
function writeCallArguments(code: string): string[] {
  const out: string[] = [];
  const pattern = /\.(?:update|updateMany|upsert|create|createMany|delete|deleteMany)\(/g;

  for (const match of code.matchAll(pattern)) {
    const open = (match.index ?? 0) + match[0].length - 1;
    let depth = 0;
    for (let index = open; index < code.length; index += 1) {
      const character = code[index];
      if (character === '(') depth += 1;
      else if (character === ')') {
        depth -= 1;
        if (depth === 0) {
          out.push(code.slice(open, index + 1));
          break;
        }
      }
    }
  }
  return out;
}

describe('扫描器本身', () => {
  it('真的扫到了模块里的每个文件（不是空跑）', () => {
    const files = collectSourceFiles(MODULE_DIR).map((file) => file.slice(MODULE_DIR.length + 1));

    expect(files.length).toBeGreaterThan(20);
    // 真正写库的那个文件必须在扫描范围内 —— 第一版就是漏了它。
    expect(files).toContain('prisma-ai-run.repository.ts');
    // 以及各个可能的写入点
    expect(files).toContain('ai.service.ts');
    expect(files).toContain('prisma-job-run.repository.ts');
  });

  it('剥注释有效（否则下面的约束会因为我们自己的注释而变红）', () => {
    // `ai.service.ts` 的文件头解释了「为什么不写 pipelineStatus」——
    // 所以它的**原文**里有这个名字，剥掉注释后**代码**里必须没有。
    // 不剥注释的话，写得越清楚的注释越容易把守卫顶红。
    const service = moduleSources().find((s) => s.file === 'ai.service.ts');
    expect(service).toBeDefined();

    expect(service!.raw).toContain('pipelineStatus');
    expect(service!.code).not.toContain('pipelineStatus');

    // 且不误伤 URL 里的 `//`
    expect(stripComments("const u = 'https://example.com';")).toContain('https://example.com');
  });
});

describe('docs/08 的硬约束（静态扫描）', () => {
  it('模块里没有任何对 sources 表的写操作', () => {
    // docs/08：「AI 不能修改 Source Tier / 不能自己宣布某来源官方」
    for (const { file, code } of moduleSources()) {
      expect(code, `${file} 出现了对 sources 的写`).not.toMatch(
        /\.source\.(update|updateMany|upsert|create|delete|deleteMany)/,
      );
    }
  });

  it('模块里没有任何对 job_runs 之外审计表的越界写', () => {
    // 只允许这些表被写：contents / ai_runs / job_runs。读别的表可以。
    const allowedWriteTargets = ['content', 'aiRun', 'jobRun'];
    const writePattern =
      /\.(?:prisma|tx)\.([a-zA-Z]+)\.(update|updateMany|upsert|create|createMany|delete|deleteMany)/g;

    for (const { file, code } of moduleSources()) {
      for (const match of code.matchAll(writePattern)) {
        expect(allowedWriteTargets, `${file} 写了未在允许清单里的表: ${match[1]}`).toContain(
          match[1],
        );
      }
    }
  });

  it('模块里没有碰 contents.pipelineStatus（状态机归 Agent 05）', () => {
    for (const { file, code } of moduleSources()) {
      expect(code, `${file} 碰了 pipelineStatus`).not.toContain('pipelineStatus');
    }
  });

  it('模块里没有写 ContentTopic（分类结果交给 Agent 05 落库）', () => {
    for (const { file, code } of moduleSources()) {
      expect(code, `${file} 写了 ContentTopic`).not.toMatch(/contentTopic\.(create|upsert|delete)/);
    }
  });

  it('模块里没有把模型输出写回 body_original（docs/00：翻译不覆盖原文）', () => {
    // 只查**写调用的实参**：`bodyOriginal` 作为读投影类型是合法的
    // （`AiContentRecord.bodyOriginal` 就是我们从库里读出来的原文）。
    for (const { file, code } of moduleSources()) {
      for (const args of writeCallArguments(code)) {
        expect(args, `${file} 的写调用里出现了 bodyOriginal`).not.toContain('bodyOriginal');
      }
    }
  });

  it('写调用提取器本身有效（不是空跑）', () => {
    const sample = `
      await tx.content.update({ where: { id }, data: { bodyTranslated: x } });
      const record = { bodyOriginal: null };
    `;
    const args = writeCallArguments(stripComments(sample));
    expect(args.join('\n')).toContain('bodyTranslated');
    // 非写调用的对象字面量不应被收进来
    expect(args.join('\n')).not.toContain('bodyOriginal');
  });

  it('模块里没有 shell / eval / 任意 SQL（docs/14：Worker 不具备这些能力）', () => {
    for (const { file, code } of moduleSources()) {
      expect(code, `${file} 引入了危险的执行能力`).not.toMatch(
        /child_process|execSync|spawnSync|\beval\s*\(|new Function|\bvm\.|queryRaw|executeRaw|\$runCommandRaw/,
      );
    }
  });
});
