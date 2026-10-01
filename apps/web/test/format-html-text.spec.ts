/**
 * `htmlToPlainText` 与它改变的两处展示语义的守卫。
 *
 * ── 为什么会有这个文件 ──────────────────────────────────────────────
 * 2026-10-01 修 P1-02（正文 HTML 被当纯文本渲染）时发现：`bodyOriginal` 是
 * **清洗过的 HTML**，而有三处把它当纯文本用。其中两处**不是**「该渲染成 HTML
 * 却渲染成了文本」，而是**本来就该是纯文本**、只是忘了剥标签：
 *
 * ```text
 * 卡片标题   <h3>{title}</h3>   标题里不该出现块级元素，标签会原样显示
 * 阅读时长   按字符数估         标签被计入 → 时长偏高
 * ```
 *
 * 所以加了 `htmlToPlainText()` 并在这两处调用它。这个文件守住那个转换。
 *
 * ⚠ **它不是安全边界。** 真正把内容当 HTML 渲染的只有 `ArticleBody`
 *（以及 X 动态正文与后台原文，同一契约），它们的输入已过 worker 的白名单清洗。
 * 这里做的是**显示语义**的转换 —— 断言的重点是「剥干净」与「不误伤」，
 * 而不是「能防住注入」。
 */

import { describe, expect, it } from 'vitest';
import { htmlToPlainText, readingMinutes } from '../lib/format';

describe('htmlToPlainText', () => {
  it('剥掉标签、留下文字', () => {
    expect(htmlToPlainText('<p>第一段</p><p>第二段</p>')).toBe('第一段 第二段');
  });

  it('块级元素之间不会把词粘在一起', () => {
    // ⚠ 这里用空格而不是空串替换标签，正是为了这个：`</p><p>` 直接删掉会得到
    // 「第一段第二段」，而它们是两段。
    expect(htmlToPlainText('<p>a</p><p>b</p>')).toBe('a b');
  });

  it('连带内容丢掉 script / style（它们不该出现在卡片标题或字数里）', () => {
    expect(htmlToPlainText('<p>正文</p><script>var x=1</script>')).toBe('正文');
    expect(htmlToPlainText('<style>p{color:red}</style><p>正文</p>')).toBe('正文');
  });

  it('常见实体被还原', () => {
    expect(htmlToPlainText('a &amp; b')).toBe('a & b');
    expect(htmlToPlainText('&lt;p&gt;')).toBe('<p>');
    expect(htmlToPlainText('&quot;x&quot;')).toBe('"x"');
    expect(htmlToPlainText('&nbsp;间隙&nbsp;')).toBe('间隙');
  });

  it('⚠ 实体只解一次：`&amp;lt;` 应当变成 `&lt;` 而不是 `<`', () => {
    // 顺序陷阱：先解 `&amp;` 的话，`&amp;lt;` → `&lt;` → 再被下一步解成 `<`，
    // 一次解码变成两次。`&amp;` 必须放在最后。
    expect(htmlToPlainText('&amp;lt;script&amp;gt;')).toBe('&lt;script&gt;');
  });

  it('纯文本原样通过（幂等）', () => {
    expect(htmlToPlainText('就是一句普通的话')).toBe('就是一句普通的话');
    const once = htmlToPlainText('<p>一句话</p>');
    expect(htmlToPlainText(once)).toBe(once);
  });

  it('空白被压平、首尾被裁掉', () => {
    expect(htmlToPlainText('  <p>  a   b  </p>  ')).toBe('a b');
  });

  it('null / undefined / 空 → 空串（调用方靠它回退）', () => {
    expect(htmlToPlainText(null)).toBe('');
    expect(htmlToPlainText(undefined)).toBe('');
    expect(htmlToPlainText('<p></p>')).toBe('');
  });
});

describe('readingMinutes 按纯文本计数', () => {
  it('⚠ HTML 标签不计入字数（旧实现下这条必红）', () => {
    // 350 字/分钟。造一段「标签占大头」的 HTML：
    // 旧实现直接 `.length` 会把标签算进去，得出的分钟数明显偏大。
    const text = '正文'.repeat(350); // 纯文本 700 字 → 2 分钟
    const html = `<p>${'正文'.repeat(350)}</p>`;

    expect(readingMinutes(text)).toBe(2);
    expect(readingMinutes(html), '标签不该被算进字数').toBe(2);
  });

  it('带大量标签时不再把时长撑大', () => {
    // 正文固定 350 字（= 1 分钟），外面套 500 个空 `<p>` 标签。
    // 旧实现直接数 `.length`：350 + 500×7 ≈ 3850 字符 → 11 分钟。
    const body = '正'.repeat(350);
    const padded = `<p>${body}</p>${'<p></p>'.repeat(500)}`;

    expect(readingMinutes(body)).toBe(1);
    expect(readingMinutes(padded), '标签不该把时长撑大').toBe(1);
  });

  it('最少 1 分钟（原型里没有 0 min read）', () => {
    expect(readingMinutes('')).toBe(1);
    expect(readingMinutes(null)).toBe(1);
    expect(readingMinutes('<p></p>')).toBe(1);
  });
});
