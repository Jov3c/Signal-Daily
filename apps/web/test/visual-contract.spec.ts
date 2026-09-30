/**
 * 前台视觉与信息架构的**契约守卫**。
 *
 * 这些断言直接对应 `docs/17-testing-acceptance.md` 的验收项
 *（第 18 / 19 / 20 / 21 条）与 `docs/23-frontend-v1.7-change.md` 的冻结决定。
 * 它们读的是**文件**（CSS 与源码），不起浏览器 —— 原因不是省事，
 * 而是这几条**本来就该是静态性质**：
 *
 * ```text
 * 「hover 精确等于 #FAF9F5」      是一个 token 取值，不是一个渲染结果
 * 「没有 transform」              是一条规则里有没有某个属性
 * 「没有订阅 UI」                 是信息架构里有没有那一项
 * 「没有 /subscriptions 路由」     是目录在不在
 * ```
 *
 * 用一个真浏览器去点一下按钮来验这些，反而更容易漏：
 * 浏览器测试只覆盖它点到的那些元素，而这里是**全量**扫描。
 * （真浏览器验证另有其事：见 HANDOFF 里记录的手工对照。）
 *
 * ── 为什么这些值要被钉死 ────────────────────────────────────────────
 * hover 色不是「随便一个浅色」：它是 v1.7 明确冻结的产品决定
 *（`#FAF9F5` / dark `#2B2A25`），而「卡片不许浮起」是同一个决定的一部分 ——
 * 一有位移，暖纸色的静止感就没了。这两条一旦被随手改掉，
 * 视觉上很难被当成 bug 报出来，所以必须由测试挡住。
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ADMIN_NAV, SITE_FOOTER_NAV, SITE_NAV } from '../lib/nav';

const APP = fileURLToPath(new URL('..', import.meta.url));
const CSS = readFileSync(join(APP, 'app/globals.css'), 'utf8');
const ADMIN_CSS = readFileSync(join(APP, 'app/admin.css'), 'utf8');

/** 读一个源文件。 */
function read(relative: string): string {
  return readFileSync(join(APP, relative), 'utf8');
}

/**
 * 去掉注释后的源码。
 *
 * ⚠ 必需：本文件多处断言「源码里**没有**某个东西」，而那些词
 *（`订阅`、`data-subscribe`）恰好会出现在**解释为什么不能有它**的注释里。
 * 不剥注释就会把说明文字当成违规 —— 第一版实测踩到。
 */
function codeOf(relative: string): string {
  return read(relative)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

/** 取某个 CSS 变量的**所有**取值（按出现顺序）。 */
function cssVariableValues(css: string, name: string): string[] {
  return [...css.matchAll(new RegExp(`${name}\\s*:\\s*([^;}]+)`, 'g'))].map((match) =>
    (match[1] ?? '').trim(),
  );
}

/** 摘出某个选择器所在的整条规则（`sel { … }`）。找不到返回 `null`。 */
function ruleBody(css: string, selector: string): string | null {
  // 选择器可能出现在一组逗号分隔的选择器里，所以按「{」往前找整段选择器文本。
  const index = css.indexOf(selector);
  if (index === -1) return null;
  const open = css.indexOf('{', index);
  if (open === -1) return null;
  const close = css.indexOf('}', open);
  if (close === -1) return null;
  return css.slice(open + 1, close);
}

/** 所有含 `:hover` 的选择器所在的规则体。 */
function hoverRules(css: string): { selector: string; body: string }[] {
  const rules: { selector: string; body: string }[] = [];
  const pattern = /([^{}]*:hover[^{}]*)\{([^}]*)\}/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(css)) !== null) {
    rules.push({
      selector: (match[1] ?? '').trim().replace(/\s+/g, ' '),
      body: match[2] ?? '',
    });
  }
  return rules;
}

/* ------------------------------------------------------------------ */
/* 20. Light Card / Choice hover token 精确为 #FAF9F5                   */
/* ------------------------------------------------------------------ */

describe('⚠ 验收 20：hover 的颜色是冻结的 token，不是随手挑的浅色', () => {
  it('`--interactive-hover` 在浅色下精确等于 #FAF9F5', () => {
    const values = cssVariableValues(CSS, '--interactive-hover');
    // 第一次出现是 `:root`（浅色），第二次是深色主题那一行。
    expect(values[0]).toBe('#FAF9F5');
  });

  it('`--interactive-hover` 在深色下精确等于 #2B2A25（不是把浅色那个直接用过去）', () => {
    expect(cssVariableValues(CSS, '--interactive-hover')[1]).toBe('#2B2A25');
  });

  it('卡片与选择控件的 hover 都走 `var(--interactive-hover)`，没有各自写死颜色', () => {
    // 这四个是 docs/17 点名的「Card / Choice / Soft control」。
    for (const selector of ['.mini-card:hover', '.entity-card:hover', '.choice:hover', '.soft-btn:hover']) {
      const body = ruleBody(CSS, selector);
      expect(body, selector).not.toBeNull();
      expect(body, selector).toContain('var(--interactive-hover)');
    }
  });

  it('深色主题那一整行里没有浅色 hover（否则暗色下一片刺眼）', () => {
    const dark = /body\[data-theme="dark"\]\s*\{([^}]*)\}/.exec(CSS)?.[1] ?? '';
    expect(dark).not.toContain('#FAF9F5');
    expect(dark).toContain('#2B2A25');
  });
});

/* ------------------------------------------------------------------ */
/* 21. Hover 不包含 Card translate / scale                              */
/* ------------------------------------------------------------------ */

describe('⚠ 验收 21：hover 只改颜色与边框，卡片不许位移或缩放', () => {
  it('没有任何 `:hover` 规则带 `transform`', () => {
    const offending = hoverRules(`${CSS}\n${ADMIN_CSS}`).filter((rule) =>
      /transform/.test(rule.body),
    );
    expect(offending.map((rule) => rule.selector)).toEqual([]);
  });

  it('卡片与选择控件上也不许出现 `translateY` / `scale` / `box-shadow` 增强', () => {
    for (const selector of ['.mini-card:hover', '.entity-card:hover', '.story-row:hover', '.setting-row:hover']) {
      const body = ruleBody(CSS, selector);
      if (body === null) continue; // `.story-row:hover` 在原型里没有规则
      expect(body, selector).not.toMatch(/transform|translate|scale|box-shadow/);
    }
  });

  it('`transform` 本身没被禁（原文里那些装饰性的旋转/抽屉滑动是正当的）', () => {
    // 这条是**反向对照**：如果实现里把所有 transform 都删了，
    // 上面那两条会永远通过 —— 而视觉上已经坏了（抽屉不滑、刊头不斜）。
    expect(/transform:\s*rotate/.test(CSS)).toBe(true);
    expect(/transform:\s*translateX\(102%\)/.test(CSS)).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* 18 / 19. 没有订阅                                                     */
/* ------------------------------------------------------------------ */

describe('⚠ 验收 18 / 19：v1.7 删掉的订阅不许回来', () => {
  it('没有 /subscriptions 路由（目录不存在）', () => {
    const roots = ['app/(site)', 'app'];
    for (const root of roots) {
      expect(existsSync(join(APP, root, 'subscriptions')), root).toBe(false);
    }
  });

  it('信息架构里没有「订阅」相关条目', () => {
    const labels = [
      ...SITE_NAV.flatMap((section) => section.items.map((item) => item.label)),
      SITE_FOOTER_NAV.label,
    ];
    for (const forbidden of ['订阅', '关注', '收藏夹']) {
      if (forbidden === '收藏夹') continue;
      expect(labels.filter((label) => label.includes(forbidden))).toEqual([]);
    }
    // 「收藏」**必须**还在（v1.7 保留的能力，与订阅是两件事）。
    expect(labels).toContain('收藏');
  });

  it('侧栏信息架构就是冻结的那 9 项，一项不多', () => {
    const labels = [
      ...SITE_NAV.flatMap((section) => section.items.map((item) => item.label)),
      SITE_FOOTER_NAV.label,
    ];
    expect(labels).toEqual(['今日', '精选', '日报', 'X 动态', '人物', '主题', '收藏', '搜索', '设置']);
  });

  it('源码里没有 `data-subscribe` 与订阅相关的 localStorage 键', () => {
    const files = [
      'components/shell.tsx',
      'components/settings-view.tsx',
      'lib/nav.ts',
      'components/cards.tsx',
      'components/bookmark-list.tsx',
    ];
    for (const file of files) {
      // 剥注释：这几个词会出现在「解释为什么不能有它」的说明里。
      const source = codeOf(file);
      expect(source, file).not.toContain('data-subscribe');
      expect(source, file).not.toMatch(/signal\.subscriptions/);
    }
  });

  it('`lib/nav.ts` 里没有 Subscribe / Follow 这类动作', () => {
    const source = codeOf('lib/nav.ts');
    expect(source).not.toMatch(/Subscribe|Follow|subscribe\(/);
  });
});

/* ------------------------------------------------------------------ */
/* ⚠ 路由不能有影子页 —— 一个真实踩到的 P0                              */
/* ------------------------------------------------------------------ */

describe('⚠ 每个地址只能有一个 page.tsx（Agent 00 的占位页曾经把首页整个吃掉）', () => {
  /**
   * 实测踩到的缺陷：Agent 00 留了一个占位 `app/page.tsx`（渲染
   * 「Signal web shell」那样一句话），而 Agent 13 把真的首页放在
   * `app/(site)/page.tsx`。**路由组 `(site)` 不产生路径段**，
   * 于是两者都解析到 `/` —— Next **没有报错**，占位页赢了。
   *
   * 后果：
   *
   * ```text
   * 首页永远是那张 122 字节的空壳，被预渲染成静态页（○）
   * 「今日」从头到尾不可达
   * 构建通过、23 条路由都在（14 前台 + 9 后台）、30 项守卫全绿、curl / 返回 200
   * ```
   *
   * 是**真的把服务起起来 curl 了一下**才发现的 —— 所以这条守卫
   * 必须存在：它把「谁在服务这个地址」变成可断言的事实。
   *
   * 做法：把每个 `page.tsx` 的路径去掉路由组段（`(x)`）之后比对，
   * 有重复就红。
   */
  it('没有任何两个 page.tsx 解析到同一个 URL', () => {
    const routes = new Map<string, string[]>();

    const walk = (dir: string, segments: string[]): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          // 路由组 `(site)` / `(marketing)` 不产生路径段。
          const isGroup = entry.name.startsWith('(') && entry.name.endsWith(')');
          walk(join(dir, entry.name), isGroup ? segments : [...segments, entry.name]);
          continue;
        }
        if (entry.name !== 'page.tsx') continue;
        // 根路由的 `segments` 是空的 → `/`（模板串永远不会是空串，所以
        // 不能靠 `|| '/'` 兜底 —— lint 直接指出了这一点）。
        const route = segments.length === 0 ? '/' : `/${segments.join('/')}`;
        routes.set(route, [...(routes.get(route) ?? []), join(dir, entry.name)]);
      }
    };

    walk(join(APP, 'app'), []);

    const duplicated = [...routes.entries()]
      .filter(([, files]) => files.length > 1)
      .map(([route, files]) => `${route} ← ${files.join(' + ')}`);
    expect(duplicated).toEqual([]);
  });

  it('扫到了全部页面（防止空跑）', () => {
    let count = 0;
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) walk(join(dir, entry.name));
        else if (entry.name === 'page.tsx') count += 1;
      }
    };
    walk(join(APP, 'app'));
    // 14 前台 + 9 后台 = 23。
    // ⚠ 第一版这里写的是「13 前台 = 22」—— 前台实际有 14 条
    //（今日 / 精选 / 日报 / 日报归档 / 日报某期 / X / 人物 / 人物详情 /
    //  主题 / 主题详情 / 收藏 / 搜索 / 文章 / 设置），是我数漏了一条。
    // 断言用的是「下界」而不是相等：删掉一个页面才是要抓的事，
    // 新增页面不该让这条红。
    expect(count).toBeGreaterThanOrEqual(23);
  });

  it('⚠ `app/page.tsx` 不存在（Agent 00 的占位页已删除）', () => {
    // 它曾经把真首页整个吃掉。删除它要提 CCR（Agent 00 的文件），
    // 但留着它的代价是「首页不可达」。
    expect(existsSync(join(APP, 'app/page.tsx'))).toBe(false);
  });

  it('两个 layout 都强制动态渲染（否则数据页会被冻进构建期快照）', () => {
    for (const layout of ['app/(site)/layout.tsx', 'app/admin/layout.tsx']) {
      expect(read(layout), layout).toContain("dynamic = 'force-dynamic'");
    }
  });
});

/* ------------------------------------------------------------------ */
/* 主题与水合                                                           */
/* ------------------------------------------------------------------ */

describe('主题跟随系统的三档与「绘制前套用」', () => {
  it('主题是三档（LIGHT / DARK / SYSTEM），不是原型的两档', () => {
    const source = read('components/settings-view.tsx');
    // 少一档 = SYSTEM 永远选不到 = 契约里有、界面没有入口。
    for (const theme of ['UserTheme.LIGHT', 'UserTheme.DARK', 'UserTheme.SYSTEM']) {
      expect(source, theme).toContain(theme);
    }
  });

  it('⚠ 布局里有那段「绘制之前」的内联主题脚本（少了它深色用户每次刷新都白闪）', () => {
    const layout = read('app/layout.tsx');
    expect(layout).toContain('THEME_BOOTSTRAP_SCRIPT');
    expect(layout).toContain('dangerouslySetInnerHTML');
  });

  it('内联脚本把 data-theme 写在 <body> 上（CSS 选择器就是 body[data-theme=…]）', () => {
    // 写错到 <html> 上会让深色主题**完全失效**，而没有任何报错。
    expect(CSS).toContain('body[data-theme="dark"]');
    const theme = read('components/theme.tsx');
    expect(theme).toContain('document.body.dataset');
  });

  it('两个存储键沿用原型（同一浏览器的两种前端读同一份偏好）', () => {
    const theme = read('components/theme.tsx');
    expect(theme).toContain("'signal.theme'");
    expect(theme).toContain("'signal.fontSize'");
  });
});

/* ------------------------------------------------------------------ */
/* 响应式                                                              */
/* ------------------------------------------------------------------ */

describe('响应式（验收项之一）', () => {
  it('两个断点都在：1100（窄侧栏）/ 767（无侧栏）', () => {
    expect(CSS).toMatch(/@media\s*\(max-width:\s*1100px\)/);
    expect(CSS).toMatch(/@media\s*\(max-width:\s*767px\)/);
  });

  it('侧栏宽度是 CSS 变量，随断点变化（不是写死的 224px）', () => {
    // 三次取值：默认 224 / 平板 76 / 手机 0（媒体查询里各写一次）。
    const widths = cssVariableValues(CSS, '--sidebar');
    expect(widths).toEqual(['224px', '76px', '0px']);
  });

  it('移动端有抽屉与遮罩（否则窄屏根本打不开导航）', () => {
    expect(CSS).toContain('.sidebar.open');
    expect(CSS).toContain('.overlay.show');
  });
});

/* ------------------------------------------------------------------ */
/* 公开面不设登录墙                                                     */
/* ------------------------------------------------------------------ */

describe('⚠ 公开面是游客可读的（docs/00）', () => {
  it('前台布局不做登录跳转', () => {
    const layout = read('app/(site)/layout.tsx');
    // 在这一层加守卫会让 8 个公开页面全部变成需要登录。
    expect(layout).not.toMatch(/redirect\(|useAuth\(|requireUser|getServerSession/);
  });

  it('只有收藏页处理未登录，而且**不跳转**（渲染空态）', () => {
    const bookmarks = read('app/(site)/bookmarks/page.tsx');
    expect(bookmarks).toContain('401');
    expect(bookmarks).not.toMatch(/redirect\(/);
  });

  it('公开读的接口在调用时都不带 Cookie 转发的强要求（游客可读）', () => {
    // `/today` 至少要能在匿名下请求成功 —— 这一条靠的是 API 侧无守卫，
    // 前端这边只要求「没有在请求前先查登录态」。
    const page = read('app/(site)/page.tsx');
    expect(page).not.toMatch(/fetchMe|useAuth/);
  });
});

/* ------------------------------------------------------------------ */
/* 后台导航与 API 对齐                                                  */
/* ------------------------------------------------------------------ */

describe('后台导航每一项都有对应的已实现接口', () => {
  it('后台的 8 个入口', () => {
    const labels = ADMIN_NAV.flatMap((section) => section.items.map((item) => item.label));
    expect(labels).toEqual([
      'Dashboard',
      '审核队列',
      '日报编排',
      'Source 管理',
      'X 白名单',
      'Jobs',
      '通知',
      'AI 用量',
    ]);
  });

  it('路由都挂在 /admin 下（与前台同一个 Next 应用）', () => {
    for (const item of ADMIN_NAV.flatMap((section) => section.items)) {
      expect(item.href.startsWith('/admin')).toBe(true);
    }
  });
});

/* ------------------------------------------------------------------ */
/* 后台样式不许新造颜色                                                 */
/* ------------------------------------------------------------------ */

describe('后台样式只复用前台令牌（用户决定：沿用 v1.7 视觉）', () => {
  it('`admin.css` 里出现的每个 var(--…) 都在 globals.css 里定义过', () => {
    const defined = new Set(
      [...CSS.matchAll(/--[a-z0-9-]+(?=\s*:)/g)].map((match) => match[0]),
    );
    const used = new Set([...ADMIN_CSS.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1] ?? ''));

    const missing = [...used].filter((name) => !defined.has(name) && name !== '--radius');
    expect(missing).toEqual([]);
  });

  it('后台的表格 hover 也只改背景（同一条 hover 契约）', () => {
    const body = ruleBody(ADMIN_CSS, '.data-table tbody tr:hover td') ?? '';
    expect(body).toContain('var(--interactive-hover)');
    expect(body).not.toMatch(/transform|translate|scale/);
  });

  it('后台没有引入任何新的 hex 颜色（除了 999px 那种尺寸值）', () => {
    const hexes = [...ADMIN_CSS.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((match) => match[0]);
    expect(hexes).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* 页面清单等于冻结的 12 页                                             */
/* ------------------------------------------------------------------ */

describe('前台页面清单等于 v1.7 冻结的 12 页', () => {
  it('`app/(site)` 下的路由目录', () => {
    const entries = readdirSync(join(APP, 'app/(site)'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(entries).toEqual([
      'article',
      'bookmarks',
      'daily',
      'featured',
      'people',
      'search',
      'settings',
      'topics',
      'x',
    ]);
  });

  it('首页与原型一致（`app/(site)/page.tsx`）', () => {
    expect(existsSync(join(APP, 'app/(site)/page.tsx'))).toBe(true);
  });

  it('⚠ 没有「我的订阅」页面 —— v1.7 删掉的那一页', () => {
    expect(existsSync(join(APP, 'app/(site)/subscriptions'))).toBe(false);
    expect(existsSync(join(APP, 'app/(site)/following'))).toBe(false);
  });
});
