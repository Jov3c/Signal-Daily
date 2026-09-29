/**
 * 源码注释的**提前闭合**守卫。
 *
 * ── 为什么值得一个文件 ──────────────────────────────────────────────
 * 本模块在开发中**两次**踩到同一个坑：在块注释里写 glob 路径
 *（形如 `apps` + `/` + `*` + `/` + `test`，或者 `modules` + `/` + `*` + `/` + `clock.ts`），
 * 其中的**星号紧跟斜杠**会**提前闭合块注释** —— 剩下的注释文字变成代码。
 *
 * 两次的报错都离题万里：
 *
 * ```text
 * clock.ts(32,1): error TS1160: Unterminated template literal.
 * publishing-db.integration.spec.ts: ReferenceError: test is not defined
 * ```
 *
 * 第一条看半天以为是自己写错了模板字符串，第二条以为是 vitest 配置问题。
 * **真正的原因（注释提前闭合）一个字都没提。**
 *
 * TypeScript 当然会报错，所以这不是「漏检」；问题是**诊断成本**。
 * 一条能直接说出原因的守卫，把二十分钟的困惑换成一秒钟的提示。
 *
 * ⚠ 范围**只覆盖 Agent 08 自己的目录**（`apps/worker/src/jobs/publishing/**`
 * 与 `apps/api/src/modules/{daily,featured}/**`）。
 * 这是一个仓库级的隐患，建议 Agent 14 在集成阶段把它提到根级、
 * 覆盖全部源码 —— 但按 §9「不顺手重构别人的区域」，本模块不越界。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/** Agent 08 拥有的源码目录（相对仓库的 `apps/`）。 */
const OWNED_DIRS = [
  'api/src/modules/daily',
  'api/src/modules/featured',
  'worker/src/jobs/publishing',
];

/** Agent 08 拥有的测试目录。 */
const OWNED_TEST_DIRS = ['api/test', 'worker/test'];

/**
 * 会提前闭合块注释的字符序列。
 *
 * 只找**星号紧跟斜杠**：正常写在注释里的星号后面通常是空格或文字，
 * 所以「星号 + 斜杠」这个组合在中文注释正文里几乎只会因为**误写 glob** 而出现。
 */
const COMMENT_CLOSER = /\*\//;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full));
      continue;
    }
    if (entry.endsWith('.ts') || entry.endsWith('.mts')) out.push(full);
  }
  return out;
}

/**
 * 找出「块注释正文里出现了星号紧跟斜杠」的行。
 *
 * 判定方式是**逐行**看：如果某一行里出现该序列，而这一行**不是**注释的
 * 结束行（结束行的特征是去掉首尾空白后正好由星号加斜杠收尾），就报出来。
 *
 * 实现刻意简单（不做完整解析）：它只需要在**真实会犯的错**上命中，
 * 而真实会犯的错都是「一行中文里混进一个 glob」。
 *
 * ⚠ 写这个文件时我自己在注释里写了一个**字面的**结束序列，
 * 于是这个守卫文件**自己**编译不过 —— 第三次踩同一个坑。
 * 这正是它值得存在的原因：这个错误的发生概率不低，而报错信息指不到原因。
 */
function offendingLines(source: string): { line: number; text: string }[] {
  const found: { line: number; text: string }[] = [];
  const lines = source.split('\n');

  let inBlockComment = false;

  lines.forEach((text, index) => {
    const trimmed = text.trim();

    if (!inBlockComment) {
      // 进入块注释：本行有 `/*` 且之后没有立刻闭合
      const open = text.indexOf('/*');
      if (open !== -1) {
        const closeAfter = text.indexOf('*/', open + 2);
        if (closeAfter === -1) inBlockComment = true;
      }
      return;
    }

    // 已经在块注释里。若本行**就是**结束行（以 `*/` 结尾），正常，退出。
    if (trimmed.endsWith('*/')) {
      // 但要小心：`... 说明文字 */ 后面还有字` 不是结束行
      const closeAt = text.indexOf('*/');
      const after = text.slice(closeAt + 2).trim();
      if (after === '') {
        inBlockComment = false;
        return;
      }
    }

    // 在块注释正文里出现了 `*` + `/` → 这就是提前闭合
    if (COMMENT_CLOSER.test(text)) {
      found.push({ line: index + 1, text: trimmed });
      // 提前闭合之后已经不在注释里了
      inBlockComment = false;
    }
  });

  return found;
}

describe('源码注释不得提前闭合（本模块踩过两次的坑）', () => {
  it('Agent 08 的源码目录里没有「注释正文里出现星号加斜杠」', () => {
    const appsRoot = fileURLToPath(new URL('../..', import.meta.url));
    const offenders: string[] = [];

    for (const dir of OWNED_DIRS) {
      for (const file of walk(join(appsRoot, dir))) {
        for (const hit of offendingLines(readFileSync(file, 'utf8'))) {
          offenders.push(`${file.replace(appsRoot, 'apps/')}:${String(hit.line)}  ${hit.text}`);
        }
      }
    }

    expect(
      offenders,
      '注释里出现的「星号 + 斜杠」会**提前闭合块注释**，剩下的文字会变成代码，' +
        '而报错信息（未闭合模板字符串 / xxx is not defined）完全指不到真正的原因。' +
        '把 glob 改写成不含该序列的说法即可（例如不要写带星号的路径）。',
    ).toEqual([]);
  });

  it('**有牙齿**：合成样本必须被命中（否则上面那条是空跑）', () => {
    const bad = ['/**', ' * 看 apps/*/test 目录', ' * 说明', ' */', 'export const x = 1;'].join(
      '\n',
    );
    const hits = offendingLines(bad);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.line).toBe(2);
    expect(hits[0]?.text).toContain('apps/*/test');
  });

  it('正常的注释、以及以星号斜杠**结尾**的注释行，都不算命中', () => {
    const good = [
      '/**',
      ' * 这一行有个星号 * 后面是空格，正常。',
      ' * 斜杠 / 单独出现也正常。',
      ' * 数字 2 * 3 = 6 也正常。',
      ' */',
      'export const x = 1;',
    ].join('\n');
    expect(offendingLines(good)).toEqual([]);

    const inline = '/* 单行块注释 */ export const y = 2;';
    expect(offendingLines(inline)).toEqual([]);

    const lineComment = '// 行注释里写 apps/*/test 完全没问题';
    expect(offendingLines(lineComment)).toEqual([]);
  });

  it('覆盖到了 Agent 08 的全部源码目录（目录改名/删除会让这条红）', () => {
    const appsRoot = fileURLToPath(new URL('../..', import.meta.url));
    for (const dir of OWNED_DIRS) {
      const files = walk(join(appsRoot, dir));
      expect(files.length, `${dir} 应当是存在的源码目录`).toBeGreaterThan(0);
    }
    // 顺带钉住测试目录也真的能扫到（避免 walk 悄悄返回空）
    const testFiles = walk(join(appsRoot, 'worker/test')).filter((file) =>
      file.endsWith('.spec.ts'),
    );
    expect(testFiles.length).toBeGreaterThan(0);
    expect(OWNED_TEST_DIRS.length).toBe(2);
  });
});
