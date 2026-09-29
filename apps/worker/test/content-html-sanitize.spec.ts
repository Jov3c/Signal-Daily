/**
 * HTML 清洗的守卫 —— `docs/14` 的五条要求逐条覆盖。
 *
 * ⚠ 本模块**没有经过独立审查**（本次由用户要求只用一个 Agent 开发）。
 * 因此这里的用例是刻意写厚的：既覆盖文档要求的每一条，
 * 也覆盖常见的绕过手法（实体编码、大小写、畸形嵌套、命名空间混淆）。
 *
 * 测试数据用**中文真实形态**（§23.4 第 4 问）：Signal 的正文是中文，
 * 用纯 ASCII 探针会让「实体解码把中文弄坏」这类问题显示为绿。
 */

import { describe, expect, it } from 'vitest';
import {
  MAX_SANITIZE_INPUT_CHARS,
  SANITIZE_TRUNCATION_MARKER,
  hasSubstantiveContent,
  sanitizeArticleHtml,
} from '../src/jobs/content/html/sanitize';
import { htmlToPlainText } from '../src/jobs/content/html/plain-text';

const clean = (html: string): string => sanitizeArticleHtml(html) ?? '';

describe('docs/14 第 1 条：删除 script', () => {
  it('script 标签连同内容一起删除（不是只丢标签）', () => {
    const out = clean('<p>正文</p><script>alert("xss")</script>');
    expect(out).toContain('正文');
    expect(out).not.toContain('script');
    expect(out).not.toContain('alert');
  });

  it('script 的内容不会被当成正文留下', () => {
    const out = clean('<p>前</p><script>var secret = "不该出现在正文里";</script><p>后</p>');
    expect(out).not.toContain('secret');
    expect(out).not.toContain('不该出现在正文里');
  });

  it('大小写与属性变体同样被删（<SCRIPT> / <script src>）', () => {
    expect(clean('<SCRIPT>bad()</SCRIPT>')).not.toContain('bad');
    expect(clean('<script src="//evil.example/x.js"></script>')).not.toContain('evil.example');
  });

  it('畸形嵌套 <scr<script>ipt> 不会漏出一个可执行标签', () => {
    const out = clean('<scr<script>ipt>alert(1)</scr</script>ipt>');

    // 安全性质只有一条：输出里**不存在可执行的 script 标签**。
    expect(out).not.toMatch(/<script/i);
    // 而且剩下的 `>` 必须是**转义过的**（`&gt;`）——
    // 未转义的 `>` 才意味着有东西从字符串里「逃出去」变成了标记。
    expect(out).not.toContain('ipt>alert');
    expect(out).toContain('&gt;');

    // 说明：残留的 `alert(1)` 二字是被转义的**文本**，不是标记，
    // 出现在正文里只是难看，不构成 XSS —— 所以这里刻意不断言它不存在。
    // 断言「文本里不能出现 alert」是过度断言，会把「转义正确」误判成失败。
  });
});

describe('docs/14 第 2 条：删除 event handler', () => {
  it.each([
    ['onclick', '<p onclick="alert(1)">正文</p>', '正文'],
    ['onload', '<p onload="alert(1)">正文</p>', '正文'],
    ['onmouseover', '<p onmouseover="alert(1)">正文</p>', '正文'],
  ])('%s 被剥掉', (_name, html, expectedText) => {
    const out = clean(html);
    expect(out).not.toMatch(/\son[a-z]+\s*=/i);
    expect(out).not.toContain('alert');
    expect(out).toContain(expectedText);
  });

  it('img 上的 onerror 被剥掉（图片本身保留）', () => {
    const out = clean('<img src="https://example.com/a.png" onerror="alert(1)">');
    expect(out).not.toMatch(/\son[a-z]+\s*=/i);
    expect(out).not.toContain('alert');
    expect(out).toContain('https://example.com/a.png');
  });

  it('任意未在白名单里的属性都进不来（不是逐个列黑名单）', () => {
    const out = clean('<p data-x="1" aria-hidden="true" contenteditable="true" tabindex="0">正文</p>');
    expect(out).not.toContain('data-x');
    expect(out).not.toContain('contenteditable');
    expect(out).not.toContain('tabindex');
    expect(out).toContain('正文');
  });
});

describe('docs/14 第 3 条：iframe 默认删除', () => {
  it('iframe 被删除', () => {
    const out = clean('<p>正文</p><iframe src="https://evil.example/"></iframe><p>后文</p>');
    expect(out).not.toContain('iframe');
    expect(out).not.toContain('evil.example');
    expect(out).toContain('后文');
  });

  it.each(['object', 'embed', 'svg', 'canvas', 'form', 'button', 'input'])(
    '%s 也被删除（同为嵌入/交互类风险面）',
    (tag) => {
      const out = clean(`<p>正文</p><${tag}></${tag}>`);
      expect(out).not.toContain(`<${tag}`);
      expect(out).toContain('正文');
    },
  );
});

describe('docs/14 第 4 条：style 白名单', () => {
  it('只放行 text-align 的合法值', () => {
    const out = clean('<p style="text-align:center">居中</p>');
    expect(out).toContain('居中');
    expect(out).toMatch(/text-align:\s*center/i);
  });

  it('视觉欺骗类样式一律被剥掉（position / 透明 / 覆盖）', () => {
    const out = clean(
      '<p style="position:fixed;top:0;left:0;width:100%;height:100%;z-index:9999;' +
        'opacity:0;background:url(https://evil.example/x)">看起来是正文</p>',
    );
    expect(out).not.toContain('position');
    expect(out).not.toContain('z-index');
    expect(out).not.toContain('opacity');
    expect(out).not.toContain('evil.example');
    expect(out).toContain('看起来是正文');
  });

  it('text-align 的非法值也不放行', () => {
    const out = clean('<p style="text-align:expression(alert(1))">x</p>');
    expect(out).not.toContain('expression');
  });

  it('未声明的属性位置上的 style 同样无效（style 只在白名单属性内）', () => {
    const out = clean('<p style="text-align:center">正文</p>');
    expect(out).toMatch(/text-align/);
    // 但 style 不在 allowedAttributes 里 —— 它之所以还能出现，
    // 是因为 allowedStyles 显式放行；其它任何属性都进不来。
    const outWithOther = clean('<p class="x" id="y" style="text-align:center">正文</p>');
    expect(outWithOther).not.toContain('class');
    expect(outWithOther).not.toContain('id=');
  });
});

describe('docs/14 第 5 条：URL scheme 白名单', () => {
  it('javascript: 被剥掉', () => {
    const out = clean('<a href="javascript:alert(1)">点我</a>');
    expect(out).not.toContain('javascript');
    expect(out).toContain('点我');
  });

  it('实体编码的 javascript: 同样被剥掉', () => {
    const out = clean('<a href="&#106;avascript:alert(1)">点我</a>');
    expect(out).not.toMatch(/javascript/i);
  });

  it('大小写 / 空白 / 换行变体都被处理', () => {
    for (const href of ['JaVaScRiPt:alert(1)', 'java\tscript:alert(1)', '  javascript:alert(1)']) {
      const out = clean(`<a href="${href}">x</a>`);
      expect(out).not.toMatch(/javascript:/i);
    }
  });

  it('data: 与 vbscript: 被剥掉', () => {
    expect(clean('<img src="data:text/html;base64,PHNjcmlwdD4=">')).not.toContain('base64');
    expect(clean('<a href="vbscript:msgbox(1)">x</a>')).not.toContain('vbscript');
  });

  it('http / https / mailto / 站内相对链接被保留', () => {
    expect(clean('<a href="https://example.com/a">a</a>')).toContain('https://example.com/a');
    expect(clean('<a href="http://example.com/a">a</a>')).toContain('http://example.com/a');
    expect(clean('<a href="mailto:x@example.com">a</a>')).toContain('mailto:x@example.com');
    expect(clean('<a href="/posts/1">a</a>')).toContain('/posts/1');
  });

  it('协议相对 URL 被拒（//evil.example 会继承页面 scheme）', () => {
    const out = clean('<img src="//evil.example/x.png">');
    expect(out).not.toContain('evil.example');
  });

  it('外链被加固 rel=noopener noreferrer + target=_blank', () => {
    const out = clean('<a href="https://example.com/a">外链</a>');
    expect(out).toMatch(/rel="noopener noreferrer"/);
    expect(out).toMatch(/target="_blank"/);
  });
});

describe('真实形态：中文正文', () => {
  it('中文与中英文混排原样保留', () => {
    const html =
      '<p>Anthropic 发布了新的模型能力评测报告，指出推理成本下降了约 40%。</p>' +
      '<p>报告称 "the cost of inference has dropped substantially"。</p>';
    const out = clean(html);
    expect(out).toContain('推理成本');
    expect(out).toContain('Anthropic');
    expect(out).toContain('dropped substantially');
  });

  it('中文标点与书名号不被当作标签处理', () => {
    const out = clean('<p>《信号》是一个「编辑型」阅读平台 —— 真的。</p>');
    expect(out).toContain('《信号》');
    expect(out).toContain('「编辑型」');
  });

  it('实体编码的中文被正确解码', () => {
    expect(clean('<p>&#20013;&#25991;</p>')).toContain('中文');
  });

  it('emoji 不被破坏（代理对完整）', () => {
    const out = clean('<p>模型 🚀 能力</p>');
    expect(out).toContain('🚀');
    expect(Buffer.from(out, 'utf8').toString('utf8')).toBe(out);
  });

  it('保留段落 / 标题 / 列表 / 引用 / 代码等结构', () => {
    const html =
      '<h2>标题</h2><p>段落</p><ul><li>一</li><li>二</li></ul>' +
      '<blockquote>引用</blockquote><pre><code>const a = 1;</code></pre>';
    const out = clean(html);
    for (const tag of ['<h2>', '<p>', '<ul>', '<li>', '<blockquote>', '<pre>', '<code>']) {
      expect(out).toContain(tag);
    }
  });
});

describe('边界', () => {
  it('null → null（不是空字符串）', () => {
    expect(sanitizeArticleHtml(null)).toBeNull();
  });

  it('空串 → null', () => {
    expect(sanitizeArticleHtml('')).toBeNull();
    expect(sanitizeArticleHtml('   \n  ')).toBeNull();
  });

  it('只有标签没有内容 → null', () => {
    expect(sanitizeArticleHtml('<p></p><p>  </p>')).toBeNull();
  });

  it('只有被丢弃标签的 HTML → null（清洗后什么都不剩）', () => {
    expect(sanitizeArticleHtml('<script>only code</script><iframe></iframe>')).toBeNull();
  });

  it('未闭合标签被修复而不是抛出', () => {
    const out = sanitizeArticleHtml('<p>没闭合的段落<div>块');
    expect(out).not.toBeNull();
    expect(out).toContain('没闭合的段落');
  });

  it('超长输入被截断并留下显式标记', () => {
    const huge = `<p>${'中'.repeat(MAX_SANITIZE_INPUT_CHARS + 1_000)}</p>`;
    const out = clean(huge);
    expect(out).toContain(SANITIZE_TRUNCATION_MARKER);
  });

  it('hasSubstantiveContent 按「有没有文字**或图片**」判断，不看长度', () => {
    expect(hasSubstantiveContent('<p></p><p></p>')).toBe(false);
    expect(hasSubstantiveContent('<p>  </p>')).toBe(false);
    expect(hasSubstantiveContent('<p>字</p>')).toBe(true);
    expect(hasSubstantiveContent(null)).toBe(false);
    // ⚠ 图片算「有内容」是刻意的：`docs/00` 允许 X 的图片帖这类
    // 没有正文文字的内容，只按文字判断会把它们整条丢掉。
    expect(hasSubstantiveContent('<img src="https://example.com/a.png">')).toBe(true);
  });

  it('清洗是幂等的（清洗过的再清洗一次结果不变）', () => {
    const once = clean('<p onclick="x">正文<script>bad()</script><a href="https://e.com">链</a></p>');
    expect(clean(once)).toBe(once);
  });
});

describe('纯文本投影（给 AI 用）', () => {
  it('去标签、块级之间留空行、折叠空白', () => {
    const text = htmlToPlainText('<p>第一段</p><p>第二段</p>');
    expect(text).toBe('第一段\n\n第二段');
  });

  it('br 变成单个换行', () => {
    expect(htmlToPlainText('<p>上<br>下</p>')).toBe('上\n下');
  });

  it('列表项各自成行', () => {
    expect(htmlToPlainText('<ul><li>一</li><li>二</li></ul>')).toBe('一\n\n二');
  });

  it('中文与 emoji 保留', () => {
    expect(htmlToPlainText('<p>推理成本 🚀 下降</p>')).toBe('推理成本 🚀 下降');
  });

  it('null → null，空 → null', () => {
    expect(htmlToPlainText(null)).toBeNull();
    expect(htmlToPlainText('<p>  </p>')).toBeNull();
  });

  it('连续空白被折叠（AI 不需要缩进空白）', () => {
    expect(htmlToPlainText('<p>a     b\t\tc</p>')).toBe('a b c');
  });
});
