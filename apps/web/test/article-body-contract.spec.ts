/**
 * 文章正文渲染的**结构性守卫** —— 读源码文本断言。
 *
 * ── 这条守卫在防什么（清单 P1-02）──────────────────────────────────
 * 后端两条正文列的**生产契约不同**：
 *
 * ```text
 * bodyOriginal   清洗过的**安全 HTML**（worker normalize.ts → sanitizeArticleHtml，
 *                白名单在 apps/worker/src/jobs/content/html/policy.ts）
 * bodyTranslated AI 生成的**纯文本**
 * ```
 *
 * 但它们曾经**都被当纯文本渲染**（`{paragraphs(original)}`）。后果是带 HTML 的
 * 正文把 `<p>` 原样显示成可见文字 —— 一个「数据契约与渲染不一致」的缺陷。
 * 修复后：原文走 `dangerouslySetInnerHTML`，译文继续走 React 文本。
 *
 * ── 为什么用源码扫描，而不是渲染测试 ────────────────────────────────
 * 这里要钉的是一条**结构性**性质：「谁允许进入 innerHTML」。它跨越
 * `ArticleBody` 一个元件，用真浏览器只能点到当前 DOM，而这是**全量**扫描
 *（同 `visual-contract.spec.ts` 的理由）。真浏览器的行为验证另有其事 ——
 * 见 `e2e/article-html.spec.ts`。
 *
 * ⚠ 必须先**去注释**再断言（同 `visual-contract.spec.ts`）：
 * 本文件、以及 `article-client.tsx` 的说明注释里都会**引用**旧写法
 *（「原来错在把 original 当纯文本」）与 `dangerouslySetInnerHTML` 这个词。
 * 不剥注释就会把说明文字当成违规 —— 这个仓库专门踩过这个坑。
 *
 * ── 断言的是「表达式」不是「字符串」────────────────────────────────
 * 光断言源码里出现 `original` 是不够的：写成
 * `__html: translated` 再在别处提一句 `original` 也能骗过。所以这里
 * **解析出每个 `dangerouslySetInnerHTML={{ __html: <expr> }}` 的表达式**，
 * 逐一对表达式本身做断言。
 */

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const APP = fileURLToPath(new URL('..', import.meta.url));

/** 读一个源文件。 */
function read(relativePath: string): string {
  return readFileSync(join(APP, relativePath), 'utf8');
}

/** 去注释后的源码（理由见文件头）。 */
function codeOf(relativePath: string): string {
  return read(relativePath)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

const ARTICLE_CLIENT = 'components/article-client.tsx';

/**
 * 取出源码里每个 `dangerouslySetInnerHTML={{ __html: <expr> }}` 的**表达式**。
 *
 * 故意用 `[^}]+?` 而不是宽松的 `.*`：`__html` 的取值在本仓库都是单个
 * 标识符（`original` / `THEME_BOOTSTRAP_SCRIPT`），一旦有人写成含 `}` 的
 * 复杂表达式，这里会**解析不到**（守卫失效）而不是静默放过 —— 由下面的
 * 「守卫本身有效」用例负责把这种情况变成红。
 */
function innerHtmlExpressions(source: string): string[] {
  return [
    ...source.matchAll(/dangerouslySetInnerHTML\s*=\s*\{\{\s*__html\s*:\s*([^}]+?)\s*\}\}/g),
  ].map((match) => (match[1] ?? '').trim());
}

/** 收集 `app/` 与 `components/` 下所有 `.tsx`（相对 APP 的路径）。 */
function allTsxFiles(): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(join(APP, dir), { withFileTypes: true })) {
      const child = join(dir, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (entry.name.endsWith('.tsx')) found.push(child);
    }
  };
  walk('app');
  walk('components');
  return found;
}

describe('⚠ 正文渲染契约：original 是安全 HTML、translated 是纯文本', () => {
  it('`bodyOriginal` 是唯一进入 `dangerouslySetInnerHTML` 的正文（且就是 `original`）', () => {
    const expressions = innerHtmlExpressions(codeOf(ARTICLE_CLIENT));
    expect(
      expressions,
      '`ArticleBody` 里应当**恰好一次**注入，且注入的是 `original`。' +
        '若这里变成 `translated`，就是把 AI 生成的纯文本当 HTML 执行 —— 典型的 XSS。',
    ).toEqual(['original']);
  });

  it('`bodyTranslated` 仍然走 React 文本（`paragraphs(translated)`），没有被改成 innerHTML', () => {
    const source = codeOf(ARTICLE_CLIENT);
    expect(source, '译文应当继续交给 React 转义').toContain('paragraphs(translated)');
    // 旧写法（原文当纯文本）必须已经消失，否则意味着修复被回滚。
    expect(source, '原文不该再走纯文本切段').not.toContain('paragraphs(original)');
  });

  it('整个 web 应用里，没有任何 `translated` 进过 `dangerouslySetInnerHTML`', () => {
    // 全量扫描：即使将来有人在别的页面（而不是 ArticleBody）里注入译文，也要红。
    const offenders: string[] = [];
    for (const file of allTsxFiles()) {
      for (const expression of innerHtmlExpressions(codeOf(file))) {
        if (/translated/i.test(expression)) offenders.push(`${file} → __html: ${expression}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('守卫本身有效：它在真实源码上确实解析到了注入表达式（防止空跑）', () => {
    const source = codeOf(ARTICLE_CLIENT);
    expect(source).toContain('dangerouslySetInnerHTML');
    expect(innerHtmlExpressions(source).length).toBeGreaterThan(0);

    // 反向对照：把注入目标换掉之后，解析**必须**能区分出来。
    // 否则上面那条 `toEqual(['original'])` 可能只是恒真。
    const tampered = source.replace('__html: original', '__html: translated');
    expect(innerHtmlExpressions(tampered)).toEqual(['translated']);
  });

  it('扫到了预期的文件数（防止 walk 空跑）', () => {
    const files = allTsxFiles().map((file) => file.replace(/\\/g, '/'));
    expect(files).toContain(ARTICLE_CLIENT);
    expect(files.length).toBeGreaterThan(10);
  });
});
