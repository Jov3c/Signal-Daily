/**
 * 正文提取 与 ContentType 推导的守卫。
 *
 * 测试数据用**中文真实形态**：fixture 模拟的是中文科技博客的整页 HTML
 * （导航 / 侧栏 / 页脚 / 正文），不是 `<div>a</div>` 这种玩具输入 ——
 * §23.4 第 4 问的教训是「测试数据偏离真实形态，绿灯就毫无意义」。
 */

import { describe, expect, it } from 'vitest';
import { ContentType, SourceType } from '@signal/contracts';
import { extractArticleBody } from '../src/jobs/content/html/extract';
import { deriveContentType } from '../src/jobs/content/normalize/content-type';

/** 一张典型的整页：中文导航 + 侧栏 + 正文 + 页脚。 */
const FULL_PAGE = `<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>模型评测报告 - 某科技博客</title></head>
<body>
  <header class="site-header">
    <nav><a href="/">首页</a> <a href="/about">关于我们</a> <a href="/privacy">隐私政策</a></nav>
  </header>
  <div class="layout">
    <aside class="sidebar"><h3>热门文章</h3><ul><li>侧栏里的另一篇文章</li></ul></aside>
    <article class="post">
      <h1>Anthropic 发布新的模型能力评测报告</h1>
      <p>报告指出推理成本在 2026 年下降了约 40%。</p>
      <p>业内普遍认为这会加速 Agent 类产品的落地。</p>
      <img src="https://example.com/chart.png" alt="成本对比图">
    </article>
  </div>
  <footer class="site-footer"><p>© 2026 某科技博客 · 京ICP备00000000号</p></footer>
</body>
</html>`;

describe('正文提取：整页 HTML', () => {
  it('优先取 <article>，而不是整个 body', () => {
    const result = extractArticleBody(FULL_PAGE);

    expect(result.container).toBe('article');
    expect(result.html).toContain('推理成本在 2026 年下降了约 40%');
    // 站点外壳不应该跟着进正文
    expect(result.html).not.toContain('隐私政策');
    expect(result.html).not.toContain('京ICP备');
    expect(result.html).not.toContain('侧栏里的另一篇文章');
  });

  it('没有 <article> 时退回 <main>', () => {
    const page = `<html><body><nav>导航</nav><main><p>正文在这里</p></main><footer>页脚</footer></body></html>`;
    const result = extractArticleBody(page);
    expect(result.container).toBe('main');
    expect(result.html).toContain('正文在这里');
    expect(result.html).not.toContain('导航');
  });

  it('role="main" 也算 <main>', () => {
    const page = `<html><body><div role="main"><p>正文</p></div><footer>页脚</footer></body></html>`;
    const result = extractArticleBody(page);
    expect(result.container).toBe('main');
    expect(result.html).toContain('正文');
  });

  it('没有语义标签时退回 <body>（保留全部内容，不丢东西）', () => {
    const page = `<html><body><div class="a"><p>老式页面正文</p></div></body></html>`;
    const result = extractArticleBody(page);
    expect(result.container).toBe('body');
    expect(result.html).toContain('老式页面正文');
  });

  it('一页多个 <article> 时取文本最长的那个（首页卡片场景）', () => {
    const page = `<html><body>
      <article><h2>短卡片</h2><p>一句话摘要</p></article>
      <article><h2>长文</h2><p>${'正文内容。'.repeat(50)}</p></article>
    </body></html>`;
    const result = extractArticleBody(page);
    expect(result.html).toContain('长文');
    expect(result.html).not.toContain('短卡片');
  });

  it('空的 <article> 占位会被跳过', () => {
    const page = `<html><body><article></article><main><p>真正的正文</p></main></body></html>`;
    const result = extractArticleBody(page);
    expect(result.html).toContain('真正的正文');
  });
});

describe('正文提取：片段（RSS 的 content:encoded）', () => {
  it('没有 html/body 时原样返回，标记为 fragment', () => {
    const fragment = '<p>第一段</p><p>第二段</p>';
    const result = extractArticleBody(fragment);
    expect(result.container).toBe('fragment');
    expect(result.html).toBe(fragment);
  });

  it('中文片段不被改动', () => {
    const fragment = '<p>《信号》是一个「编辑型」阅读平台。</p>';
    expect(extractArticleBody(fragment).html).toBe(fragment);
  });

  it('空输入不抛错', () => {
    expect(() => extractArticleBody('')).not.toThrow();
    expect(extractArticleBody('').container).toBe('fragment');
  });
});

describe('正文提取：畸形输入不抛错', () => {
  it.each([
    ['未闭合标签', '<html><body><article><p>没闭合'],
    ['嵌套 article', '<html><body><article><article><p>嵌套</p></article></article></body></html>'],
    ['只有 html 没有 body', '<html><head><title>t</title></head></html>'],
    ['大量尖括号', '<html><body><article>' + '<'.repeat(500) + '正文' + '</article></body></html>'],
  ])('%s', (_name, html) => {
    expect(() => extractArticleBody(html)).not.toThrow();
  });
});

describe('ContentType 推导（与六个适配器逐条对齐）', () => {
  it('无歧义的五种来源', () => {
    expect(deriveContentType(SourceType.RSS, {})).toBe(ContentType.ARTICLE);
    expect(deriveContentType(SourceType.X_USER, {})).toBe(ContentType.X_POST);
    expect(deriveContentType(SourceType.HACKER_NEWS, {})).toBe(ContentType.HN_STORY);
    expect(deriveContentType(SourceType.HUGGINGFACE, {})).toBe(ContentType.MODEL);
    expect(deriveContentType(SourceType.MANUAL_URL, {})).toBe(ContentType.ARTICLE);
  });

  it('GitHub：有 tagName → GITHUB_RELEASE', () => {
    expect(deriveContentType(SourceType.GITHUB_REPO, { repo: 'a/b', tagName: 'v1.2.0' })).toBe(
      ContentType.GITHUB_RELEASE,
    );
  });

  it('GitHub：没有 tagName → GITHUB_REPO', () => {
    expect(deriveContentType(SourceType.GITHUB_REPO, { repo: 'a/b', stars: 10 })).toBe(
      ContentType.GITHUB_REPO,
    );
  });

  it('GitHub：tagName 为空串 / null / 非字符串 → GITHUB_REPO（保守一侧）', () => {
    for (const payload of [
      { tagName: '' },
      { tagName: '   ' },
      { tagName: null },
      { tagName: 42 },
      {},
    ]) {
      expect(deriveContentType(SourceType.GITHUB_REPO, payload as never)).toBe(
        ContentType.GITHUB_REPO,
      );
    }
  });

  it('payload 为 null / undefined 时不抛错', () => {
    expect(deriveContentType(SourceType.RSS, null)).toBe(ContentType.ARTICLE);
    expect(deriveContentType(SourceType.GITHUB_REPO, undefined)).toBe(ContentType.GITHUB_REPO);
  });

  it('每种 SourceType 都有确定结果（新增类型必须登记）', () => {
    for (const sourceType of Object.values(SourceType)) {
      expect(() => deriveContentType(sourceType, null)).not.toThrow();
    }
  });
});
