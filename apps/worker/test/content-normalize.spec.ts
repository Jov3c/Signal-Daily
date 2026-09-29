/**
 * Normalize 的守卫 —— 流水线第一站，也是判断最密集的一站。
 *
 * 输入一律用**中文真实形态**：整页 HTML 带导航/侧栏/页脚、
 * RSS 片段、X 的纯文本帖、只有图片的帖。§23.4 第 4 问的教训是
 * 「用玩具输入测出来的绿是假的」。
 */

import { describe, expect, it } from 'vitest';
import { ContentPipelineStatus, ContentType, DomainErrorCode, SourceType } from '@signal/contracts';
import {
  CONTENT_LANGUAGE_FALLBACK,
  CONTENT_TITLE_MAX_CHARS,
  normalizeRawItem,
  type NormalizeInput,
} from '../src/jobs/content/normalize/normalize';

/** 一份最小可用的输入，各用例只覆盖自己关心的字段。 */
function input(overrides: Partial<NormalizeInput> = {}): NormalizeInput {
  return {
    rawItemId: '42',
    sourceId: '7',
    sourceType: SourceType.RSS,
    payload: { feedFormat: 'rss2' },
    externalId: 'post-1',
    originalUrl: 'https://example.com/posts/1',
    titleRaw: 'Anthropic 发布新的评测报告',
    bodyRaw: '<p>报告指出推理成本在 2026 年下降了约 40%。</p>',
    language: 'en',
    publishedAt: new Date('2026-09-29T02:00:00.000Z'),
    ...overrides,
  };
}

/** 取成功结果，失败则让测试以可读的方式挂掉。 */
function ok(result: ReturnType<typeof normalizeRawItem>) {
  if (!result.ok) throw new Error(`expected success, got ${result.code}: ${result.reason}`);
  return result.content;
}

describe('基本归一化', () => {
  it('RSS 片段 → ARTICLE，保留标题与正文', () => {
    const content = ok(normalizeRawItem(input()));

    expect(content.type).toBe(ContentType.ARTICLE);
    expect(content.title).toBe('Anthropic 发布新的评测报告');
    expect(content.bodyOriginal).toContain('推理成本在 2026 年下降了约 40%');
    expect(content.pipelineStatus).toBe(ContentPipelineStatus.INGESTED);
    expect(content.rawItemId).toBe('42');
    expect(content.sourceId).toBe('7');
  });

  it('MANUAL_URL 整页 → 只留正文，站点外壳不进 body', () => {
    const page = `<!DOCTYPE html><html><head><title>t</title></head><body>
      <nav><a href="/about">关于我们</a></nav>
      <article><h1>标题</h1><p>这是正文第一段。</p><p>这是第二段。</p></article>
      <footer><p>© 2026 某站 · 京ICP备00000000号</p></footer>
    </body></html>`;
    const content = ok(
      normalizeRawItem(input({ sourceType: SourceType.MANUAL_URL, bodyRaw: page })),
    );

    expect(content.bodySource).toBe('article');
    expect(content.bodyOriginal).toContain('这是正文第一段');
    expect(content.bodyOriginal).not.toContain('关于我们');
    expect(content.bodyOriginal).not.toContain('京ICP备');
  });

  it('正文里的 script / onclick 在落库前就被清掉', () => {
    const content = ok(
      normalizeRawItem(
        input({
          bodyRaw:
            '<p onclick="alert(1)">正文</p><script>fetch("//evil.example")</script>' +
            '<a href="javascript:alert(2)">链</a>',
        }),
      ),
    );

    expect(content.bodyOriginal).toContain('正文');
    expect(content.bodyOriginal).not.toMatch(/script/i);
    expect(content.bodyOriginal).not.toMatch(/onclick/i);
    expect(content.bodyOriginal).not.toContain('javascript:');
  });

  it('中文与 emoji 原样保留，不被转义成数字实体', () => {
    const content = ok(
      normalizeRawItem(input({ bodyRaw: '<p>模型 🚀 能力评测 —— 真的。</p>' })),
    );

    expect(content.bodyOriginal).toContain('模型 🚀 能力评测');
    expect(content.bodyOriginal).not.toMatch(/&#x/);
  });

  it('同样的输入产生同样的输出（纯函数，无隐式状态）', () => {
    const first = ok(normalizeRawItem(input()));
    const second = ok(normalizeRawItem(input()));
    expect(second).toEqual(first);
  });
});

describe('标题：三级回退', () => {
  it('有 titleRaw 时用它', () => {
    expect(ok(normalizeRawItem(input({ titleRaw: '来源给的标题' }))).title).toBe('来源给的标题');
  });

  it('titleRaw 缺失时从正文首段回退（HN self post / X 纯文本帖）', () => {
    const content = ok(
      normalizeRawItem(
        input({ titleRaw: null, bodyRaw: '<p>第一行就是全部内容。</p><p>这是第二段。</p>' }),
      ),
    );
    expect(content.title).toBe('第一行就是全部内容。');
  });

  it('titleRaw 是空白时也走回退（回退取的是**正文首段**，不是别的）', () => {
    const content = ok(normalizeRawItem(input({ titleRaw: '   ' })));
    expect(content.title).toBe('报告指出推理成本在 2026 年下降了约 40%。');
  });

  it('标题里的标签与实体被清掉', () => {
    const content = ok(
      normalizeRawItem(input({ titleRaw: '<b>加粗</b>标题 &amp; 实体' })),
    );
    expect(content.title).toBe('加粗标题 & 实体');
  });

  it('超长标题被截到 700 字符（对齐 VarChar(700)）', () => {
    const content = ok(normalizeRawItem(input({ titleRaw: '中'.repeat(1_000) })));
    expect(Array.from(content.title).length).toBe(CONTENT_TITLE_MAX_CHARS);
  });

  it('标题截断不劈开 emoji（按码点切）', () => {
    const content = ok(normalizeRawItem(input({ titleRaw: '🚀'.repeat(1_000) })));
    const chars = Array.from(content.title);
    expect(chars.length).toBe(CONTENT_TITLE_MAX_CHARS);
    expect(chars.every((c) => c === '🚀')).toBe(true);
    // 没有孤立代理项
    expect(Buffer.from(content.title, 'utf8').toString('utf8')).toBe(content.title);
  });

  it('只有图片、没有文字时用 URL 末段做占位标题（不写死「无标题」）', () => {
    const content = ok(
      normalizeRawItem(
        input({
          titleRaw: null,
          bodyRaw: '<img src="https://example.com/photo.png">',
          originalUrl: 'https://example.com/status/12345',
        }),
      ),
    );
    expect(content.title).toBe('12345');
  });
});

describe('正文边界', () => {
  it('没有正文时 bodyOriginal 为 null（标题帖仍然有效）', () => {
    const content = ok(normalizeRawItem(input({ bodyRaw: null })));
    expect(content.bodyOriginal).toBeNull();
    expect(content.bodySource).toBe('none');
    expect(content.title).toBe('Anthropic 发布新的评测报告');
  });

  it('正文是空白时不当作正文', () => {
    expect(ok(normalizeRawItem(input({ bodyRaw: '   \n  ' }))).bodyOriginal).toBeNull();
  });

  it('清洗后什么都不剩的正文 → null', () => {
    const content = ok(normalizeRawItem(input({ bodyRaw: '<script>only()</script>' })));
    expect(content.bodyOriginal).toBeNull();
  });

  it('标题与正文都为空 → CONTENT_EMPTY（不静默丢弃）', () => {
    const result = normalizeRawItem(input({ titleRaw: null, bodyRaw: null }));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.code).toBe(DomainErrorCode.CONTENT_EMPTY);
  });

  it('只有被丢弃的标签也算空', () => {
    const result = normalizeRawItem(
      input({ titleRaw: null, bodyRaw: '<script>a()</script><iframe></iframe>' }),
    );
    expect(result.ok).toBe(false);
  });

  it('超长正文被截断且有显式标记', () => {
    const content = ok(
      normalizeRawItem(input({ bodyRaw: `<p>${'中'.repeat(500_000)}</p>` })),
    );
    expect(content.bodyOriginal).toContain('已截断');
  });
});

describe('其它字段', () => {
  it('language 取自 raw_items；缺失时落 und（不猜）', () => {
    expect(ok(normalizeRawItem(input({ language: 'en' }))).language).toBe('en');
    expect(ok(normalizeRawItem(input({ language: null }))).language).toBe(
      CONTENT_LANGUAGE_FALLBACK,
    );
    expect(CONTENT_LANGUAGE_FALLBACK).toBe('und');
  });

  it('取正文里的第一张图片作为缩略图', () => {
    const content = ok(
      normalizeRawItem(
        input({ bodyRaw: '<p>x</p><img src="https://example.com/a.png"><img src="https://e.com/b.png">' }),
      ),
    );
    expect(content.imageUrl).toBe('https://example.com/a.png');
  });

  it('正文没有图片时 imageUrl 为 null', () => {
    expect(ok(normalizeRawItem(input())).imageUrl).toBeNull();
  });

  it('被清洗掉的图片（data: / javascript:）不会被选作缩略图', () => {
    const content = ok(
      normalizeRawItem(
        input({ bodyRaw: '<img src="data:image/png;base64,AAAA"><p>有文字</p>' }),
      ),
    );
    expect(content.imageUrl).toBeNull();
  });

  it('publishedAt 原样传递（可空）', () => {
    const at = new Date('2026-01-02T03:04:05.000Z');
    expect(ok(normalizeRawItem(input({ publishedAt: at }))).publishedAt).toEqual(at);
    expect(ok(normalizeRawItem(input({ publishedAt: null }))).publishedAt).toBeNull();
  });

  it('类型推导按 SourceType（含 GitHub 的 tagName 分支）', () => {
    const typeOf = (overrides: Partial<NormalizeInput>): ContentType =>
      ok(normalizeRawItem(input(overrides))).type;

    expect(typeOf({ sourceType: SourceType.RSS })).toBe(ContentType.ARTICLE);
    expect(typeOf({ sourceType: SourceType.X_USER })).toBe(ContentType.X_POST);
    expect(typeOf({ sourceType: SourceType.HACKER_NEWS, payload: {} })).toBe(ContentType.HN_STORY);
    expect(typeOf({ sourceType: SourceType.HUGGINGFACE, payload: {} })).toBe(ContentType.MODEL);
    expect(typeOf({ sourceType: SourceType.MANUAL_URL, payload: {} })).toBe(ContentType.ARTICLE);

    // GitHub 两种形态靠 payload.tagName 区分
    expect(typeOf({ sourceType: SourceType.GITHUB_REPO, payload: { repo: 'a/b', tagName: 'v1' } })).toBe(
      ContentType.GITHUB_RELEASE,
    );
    expect(typeOf({ sourceType: SourceType.GITHUB_REPO, payload: { repo: 'a/b' } })).toBe(
      ContentType.GITHUB_REPO,
    );
  });
});

describe('畸形输入不抛错', () => {
  it.each([
    ['未闭合标签', '<p>没闭合'],
    ['纯 HTML 注释', '<!-- 只有注释 -->'],
    ['大量尖括号', '<'.repeat(2_000)],
    ['嵌套 article', '<html><body><article><article><p>x</p></article></article></body></html>'],
    ['只有 DOCTYPE', '<!DOCTYPE html>'],
  ])('%s', (_name, bodyRaw) => {
    expect(() => normalizeRawItem(input({ bodyRaw }))).not.toThrow();
  });
});
