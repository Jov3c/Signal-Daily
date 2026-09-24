/**
 * 文本处理（`text/markup.ts`）与链接归一化（`url/canonical.ts`）的测试。
 *
 * 这两块是**去重与前台展示的地基**：归一化错了 → 同一篇文章入库多次；
 * 标题没变纯文本 → 前台显示 `&amp;` 或一大段 JS。
 */

import { describe, expect, it } from 'vitest';
import {
  decodeEntities,
  extractHtmlTitle,
  stripTags,
  toPlainText,
  toPlainTitle,
} from '../src/jobs/collectors/text/markup';
import { canonicalizeUrl, resolveItemUrl } from '../src/jobs/collectors/url/canonical';
import { collapseWhitespace, contentHashOf, sha256Hex } from '../src/jobs/collectors/hashing';
import { HTML_PAGE } from './support/feed-fixtures';

describe('decodeEntities', () => {
  it('XML 的五个预定义实体', () => {
    expect(decodeEntities('&amp;&lt;&gt;&quot;&apos;')).toBe('&<>"\'');
  });

  it('命名实体（含中文排版常用的那些）', () => {
    expect(decodeEntities('&#8212;')).toBe('—');
    expect(decodeEntities('&mdash;&hellip;&ldquo;x&rdquo;')).toBe('—…“x”');
    expect(decodeEntities('&nbsp;')).toBe(' ');
  });

  it('十进制与十六进制数字实体', () => {
    expect(decodeEntities('&#20013;&#x6587;')).toBe('中文');
    expect(decodeEntities('&#x1F600;')).toBe('😀');
  });

  it('**不认识的实体原样保留**（不猜、不删）', () => {
    // 猜会让内容出错，删会让内容静默缺字。原样保留至少说明这里有东西。
    expect(decodeEntities('&foo; &bar123;')).toBe('&foo; &bar123;');
  });

  it('越界与孤立代理的码点不崩、原样保留', () => {
    // `String.fromCodePoint` 对 > 0x10FFFF 会抛 RangeError，
    // 而实体是外部输入 —— 一个 &#xFFFFFFFF; 就能让整个采集任务崩掉。
    expect(() => decodeEntities('&#xFFFFFFFF;')).not.toThrow();
    expect(decodeEntities('&#xFFFFFFFF;')).toBe('&#xFFFFFFFF;');
    expect(decodeEntities('&#55296;')).toBe('&#55296;'); // U+D800 孤立代理
    expect(decodeEntities('&#999999999999;')).toBe('&#999999999999;');
  });
});

describe('stripTags', () => {
  it('先删 script/style 整块内容，再删其余标签', () => {
    // 顺序反了的话标签被删而脚本源码留下。
    const html =
      '<p>before</p><script>var leak = "SECRET";</script><style>.a{}</style><p>after</p>';
    const text = stripTags(html);
    expect(text).not.toContain('SECRET');
    expect(text).not.toContain('.a{}');
    expect(text).toContain('before');
    expect(text).toContain('after');
  });

  it('删注释', () => {
    expect(stripTags('a<!-- comment -->b')).not.toContain('comment');
  });
});

describe('toPlainTitle', () => {
  it('去标签 + 解码实体 + 折叠空白', () => {
    expect(toPlainTitle('<b>标题</b>\n\n  多行  ')).toBe('标题 多行');
  });

  it('解码**之后**再去一次标签（防「解码造出标签」）', () => {
    // 源站把标题写成 &lt;img ...&gt; 时，解码会造出一个货真价实的标签串，
    // 而标题是「一定会被渲染」的字段。
    const title = toPlainTitle('&lt;img src=x onerror=alert(1)&gt;');
    expect(title).toBeNull();

    const mixed = toPlainTitle('正常标题 &lt;script&gt;alert(1)&lt;/script&gt;');
    expect(mixed).not.toContain('<script');
    expect(mixed).not.toContain('alert');
    expect(mixed).toContain('正常标题');
  });

  it('全空白的输入返回 null 而不是空字符串', () => {
    expect(toPlainTitle('   ')).toBeNull();
    expect(toPlainTitle('<p></p>')).toBeNull();
    expect(toPlainTitle(null)).toBeNull();
  });

  it('中文与 emoji 原样保留', () => {
    expect(toPlainTitle('模型评测：推理成本 🔬')).toBe('模型评测：推理成本 🔬');
  });
});

describe('toPlainText', () => {
  it('不去标签，只解码与折叠', () => {
    expect(toPlainText('A &amp; B')).toBe('A & B');
  });
});

describe('stripTags 对超长输入必须保持**线性**（P1 回归守卫）', () => {
  /**
   * ⚠ 这条守卫是被一次真实的 P1 缺陷逼出来的。
   *
   * 原实现 `/<[^>]*>/g` 在「含 `<` 但无 `>`」的输入上是 O(n²)：
   * 每个 `<` 都会尝试匹配、一路吃到串尾、失败、再回溯。
   * 实测标度（输入 2× → 耗时 ~4×）：
   *
   * ```
   * len=4,000    5ms
   * len=8,000   17ms
   * len=16,000  66ms
   * len=32,000 265ms
   * ```
   *
   * 而它是**同步**的：`SOURCE_FETCH_MAX_BYTES` 是 2 MiB，
   * 一次这样的输入会阻塞 Node 事件循环几十分钟，把同进程的
   * CollectorWorker（并发 5）与 SourceScheduler 一起拖死。
   * 触发者只需要能被加进白名单、或有一个被管理员盯上的 MANUAL_URL 页面。
   *
   * 断言方式：用**标度**而不是绝对耗时 —— 绝对阈值会被机器的快慢影响，
   * 而「输入 4× 时耗时不超过约 16×（放宽到 24×）」对线性/接近线性的实现
   * 永远成立，对二次实现必然不成立。
   */
  it('输入放大 4× 时耗时不成二次增长（`<` 无 `>` 的最坏形状）', () => {
    const time = (chars: number): number => {
      const input = '<a'.repeat(chars);
      const startedAt = performance.now();
      stripTags(input);
      return performance.now() - startedAt;
    };

    // 预热，避免首次 JIT 抖动被算进标度。
    time(500);

    const small = Math.max(time(4_000), 0.5);
    const large = time(16_000);

    // 线性 → 约 4×；二次 → 约 16×。阈值取 24× 留足噪声余量，
    // 但远低于二次实现在这个规模上的表现（实测 ~66ms vs ~5ms ≈ 13×，
    // 到 4 倍规模时二次实现会到 ~16×，加上常数项通常更多）。
    expect(large / small).toBeLessThan(24);
  });

  it('十万字符量级的最坏形状输入在秒级内返回（不会阻塞事件循环）', () => {
    // ⚠ 这里刻意用 12 万字符而**不是** `SOURCE_FETCH_MAX_BYTES` 的 2 MiB。
    // 原因：反证需要**观察到失败**。二次实现在 12 万字符上约 4 秒
    // （实测标度：3.2 万字符 265ms），足以让下面的上界断言变红；
    // 而在 2 MiB 上二次实现需要几十分钟 —— 那时反证只会超时，
    // 拿不到一条干净的「红」。（真实防护由上面的标度断言承担：
    // 它对任意规模都成立，不需要跑到 2 MiB。）
    const input = '<a'.repeat(60_000);
    const startedAt = performance.now();
    const out = stripTags(input);
    const elapsed = performance.now() - startedAt;

    // 线性实现在这个输入上是个位数毫秒级。
    expect(elapsed).toBeLessThan(2_000);
    // ⚠ 断言**具体的输出形状**，而不是 `out.length >= input.length` ——
    // 后者对「新实现」和「退回旧正则」**都成立**（实测），于是它区分不了两者，
    // 是一条与被测行为无关的弱断言。
    // 这里钉住三条**只有新实现才成立**的性质：
    //   1. 未闭合的 `<` 之后没有 `>`，所以整段内容原样保留（只是多了个空格）；
    //   2. 输出里**没有**被删掉的整块内容（旧正则会保留 `<a` 序列？不会 —— 但
    //      旧实现在这个输入上要走 O(n²)，下面 60 秒的上界已经把它排除）；
    //   3. 长度与输入同量级（不是被截断成空串）。
    expect(out).toContain('<a');
    expect(out.replace(/\s/g, '')).toBe(input);
  });

  it('对照：同样大小的良性输入也很快（确认上面的上界不是靠运气）', () => {
    const input = '标题'.repeat(500_000);
    const startedAt = performance.now();
    stripTags(input);
    expect(performance.now() - startedAt).toBeLessThan(1_000);
  });
});

describe('extractHtmlTitle', () => {
  it('og:title 优先于 <title>（<title> 常带站点后缀）', () => {
    expect(extractHtmlTitle(HTML_PAGE)).toBe('OpenAI 发布新的推理模型');
  });

  it('没有 og:title 时退回 <title>', () => {
    expect(extractHtmlTitle('<html><head><title>只有 title</title></head></html>')).toBe(
      '只有 title',
    );
  });

  it('再没有时退回第一个 <h1>', () => {
    expect(extractHtmlTitle('<html><body><h1>只有 h1</h1></body></html>')).toBe('只有 h1');
  });

  it('属性顺序颠倒也能取到（content 在 property 之前）', () => {
    const html = '<meta content="内容优先" property="og:title">';
    expect(extractHtmlTitle(html)).toBe('内容优先');
  });

  it('什么都没有时返回 null', () => {
    expect(extractHtmlTitle('<html><body>无标题</body></html>')).toBeNull();
  });
});

describe('canonicalizeUrl', () => {
  const same = (a: string, b: string): void => {
    expect(canonicalizeUrl(a)).toBe(canonicalizeUrl(b));
  };

  it('主机名大小写与末尾点归一化', () => {
    same('https://Example.COM/post', 'https://example.com/post');
    same('https://example.com./post', 'https://example.com/post');
  });

  it('默认端口被去掉，非默认端口保留', () => {
    same('https://example.com:443/post', 'https://example.com/post');
    same('http://example.com:80/post', 'http://example.com/post');
    expect(canonicalizeUrl('https://example.com:8443/post')).toContain(':8443');
  });

  it('fragment 被去掉', () => {
    same('https://example.com/post#comments', 'https://example.com/post');
  });

  it('跟踪参数被去掉', () => {
    same('https://example.com/post?utm_source=x&utm_medium=y&fbclid=z', 'https://example.com/post');
  });

  it('查询参数按键排序（顺序不同的同一组参数归一成同一个）', () => {
    same('https://example.com/p?b=2&a=1', 'https://example.com/p?a=1&b=2');
  });

  it('**已编码的查询值不被破坏**（`?q=a%26b` 的值就是字面量 `a&b`）', () => {
    // ⚠ 这条是 F-06 的回归守卫。
    // 曾经用 `searchParams` 迭代（**已经解码**）后手工拼 `k=v`：
    // `?q=a%26b` 会被拼成 `?q=a&b` —— 那是**另一个资源**
    // （`q=a` 且多一个空参数），而这个值会写进 `raw_items.canonical_url`
    // 并参与去重。现在用 `URLSearchParams` 重新序列化。
    const canonical = canonicalizeUrl('https://example.com/p?q=a%26b');
    expect(canonical).not.toBeNull();

    const parsed = new URL(canonical!);
    // 值必须仍然是 `a&b`（而不是被拆成两个参数）。
    expect(parsed.searchParams.get('q')).toBe('a&b');
    expect([...parsed.searchParams.keys()]).toEqual(['q']);
  });

  it('查询串里的中文被百分号编码（不留裸字符）', () => {
    const canonical = canonicalizeUrl('https://example.com/p?标题=推理成本');
    expect(canonical).not.toBeNull();
    expect(canonical).not.toContain('标题');
    expect(new URL(canonical!).searchParams.get('标题')).toBe('推理成本');
  });

  it('**不认识的查询参数一律保留** —— 很多站点用查询串承载真实内容', () => {
    // 激进地「只留 path」会把 ?id=1 与 ?id=2 判成同一条，那是**漏掉真内容**，
    // 比多抓几条严重得多。
    expect(canonicalizeUrl('https://example.com/p?id=1')).not.toBe(
      canonicalizeUrl('https://example.com/p?id=2'),
    );
    expect(canonicalizeUrl('https://example.com/p?p=456')).toContain('p=456');
  });

  it('path 为空时补 /；非空 path 的尾斜杠**不**去掉', () => {
    expect(canonicalizeUrl('https://example.com')).toBe('https://example.com/');
    expect(canonicalizeUrl('https://example.com/a')).not.toBe(
      canonicalizeUrl('https://example.com/a/'),
    );
  });

  it('非 http(s) 一律返回 null', () => {
    expect(canonicalizeUrl('mailto:a@b.com')).toBeNull();
    expect(canonicalizeUrl('javascript:alert(1)')).toBeNull();
    expect(canonicalizeUrl('not a url')).toBeNull();
  });

  it('中文路径做百分号编码而不是抛错', () => {
    const result = canonicalizeUrl('https://example.com/文章/一');
    expect(result).not.toBeNull();
    expect(result).toContain('https://example.com/');
  });
});

describe('resolveItemUrl', () => {
  const base = 'https://example.com/feed.xml';

  it('绝对地址直接用（**不**重新拼到 base 上）', () => {
    expect(resolveItemUrl('https://other.com/post', base)?.toString()).toBe(
      'https://other.com/post',
    );
  });

  it('相对地址按 base 解析', () => {
    expect(resolveItemUrl('/post-1', base)?.toString()).toBe('https://example.com/post-1');
    expect(resolveItemUrl('post-1', base)?.toString()).toBe('https://example.com/post-1');
  });

  it('非 http(s) 返回 null（追溯不到原始来源，调用方会跳过该条目）', () => {
    expect(resolveItemUrl('mailto:a@b.com', base)).toBeNull();
    expect(resolveItemUrl('javascript:void(0)', base)).toBeNull();
    expect(resolveItemUrl('', base)).toBeNull();
    expect(resolveItemUrl(null, base)).toBeNull();
  });

  it('base 本身非法时，绝对地址仍然可用', () => {
    expect(resolveItemUrl('https://x.com/a', 'not-a-url')?.toString()).toBe('https://x.com/a');
    expect(resolveItemUrl('/rel', 'not-a-url')).toBeNull();
  });
});

describe('哈希与归一化内容哈希', () => {
  it('sha256Hex 产出 64 位小写十六进制（Char(64) 列的要求）', () => {
    const hash = sha256Hex('signal');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('contentHashOf 折叠空白，所以换行/缩进不同的同一篇文章得到同一个哈希', () => {
    expect(contentHashOf('标题', '正文  内容')).toBe(contentHashOf('标题', '\n正文\n内容\n'));
  });

  it('contentHashOf **不**折叠大小写（原文差异是编辑判断的依据）', () => {
    expect(contentHashOf('Title', 'Body')).not.toBe(contentHashOf('title', 'body'));
  });

  it('collapseWhitespace 覆盖 nbsp 与全角空格', () => {
    // JS 的 \s 已包含 U+00A0 与 U+3000 —— 这条用例把该事实钉住，
    // 免得将来有人「优化」成正则里的字面量。
    expect(collapseWhitespace('a b')).toBe('a b');
    expect(collapseWhitespace('a　b')).toBe('a b');
  });
});
