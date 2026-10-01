/**
 * 文章正文渲染的**浏览器级回归** —— 清单 P1-02 的验收要求
 *（「增加浏览器级回归测试，而不仅是字符串单测」）。
 *
 * ── 这条用例在守什么 ────────────────────────────────────────────────
 * 后端两条正文列的生产契约不同：
 *
 * ```text
 * bodyOriginal   清洗过的**安全 HTML**（worker normalize.ts → sanitizeArticleHtml）
 * bodyTranslated AI 生成的**纯文本**
 * ```
 *
 * 修复前两条都被当纯文本渲染，带 HTML 的正文会把 `<p>` 显示成可见文字。
 * 修复后原文走 `dangerouslySetInnerHTML`、译文走 React 文本。字符串层守卫
 *（`apps/web/test/article-body-contract.spec.ts`）只能证明「源码写对了」，
 * 这里要证明的是**浏览器里的实际行为**：富文本变成元素、攻击载荷不执行。
 *
 * ── 造的数据必须是「真实形状」的，不能手搓 ──────────────────────────
 * 这条用例把一段**未清洗**的富文本 + 攻击载荷交给 **worker 真实的
 * `sanitizeArticleHtml`**（就是 `normalize.ts:136` 调用的那个函数），把它的
 * 输出写进 `body_original`。于是库里的数据与线上真实入库的一模一样。
 *
 * 为什么不手写一份「看起来干净」的 HTML：那等于在测试里复制一份清洗策略，
 * 策略一改（比如有人把 `onclick` 加进白名单）用例照样绿 —— 它测的是我们
 * 想象出来的契约。这里用真策略，所以「策略被改松」会当场让本用例变红。
 *
 * ⚠ 直接导入 worker 的 **ts 源码**而不是 dist：源码永远是最新的，
 *   不会因为「改了 policy 忘了 rebuild」而测到旧策略。
 *
 * ── 为什么能证明「没执行」而不是「字符串里没有」────────────────────
 * - `<script>`：断言 DOM 里**没有 script 元素**，且在载荷里埋的
 *   `window.__e2eScript` 哨兵**读回来是 null**（真的没跑）。
 * - `onclick`：先断言属性被剥掉，再**真的 `click()` 一下**该元素，
 *   然后读哨兵 —— 这是「点了也没反应」，不是「源码里没写」。
 * - `javascript:`：断言 `href` 属性被剥掉，再点一下，断言哨兵为 null
 *   且 URL 没有变化（没有导航、没有执行）。
 */

import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { REPO_ROOT, parseDotEnv } from './helpers';
import { sanitizeArticleHtml } from '../apps/worker/src/jobs/content/html/sanitize';

/* ------------------------------------------------------------------ */
/* 造数据                                                              */
/* ------------------------------------------------------------------ */

/** 造数据用的来源 slug —— 固定值，配合「先删后插」保证可重复运行。 */
const SOURCE_SLUG = 'e2e-article-html-guard';

/** 我们从 `apps/api` 的解析上下文取 Prisma（pnpm 严格模式下根目录拿不到）。 */
const requireFromApi = createRequire(path.join(REPO_ROOT, 'apps', 'api', 'package.json'));

/** 只声明本用例真正用到的 Prisma 表面，避免把 `@prisma/client` 的类型拖进 e2e。 */
type PrismaLike = {
  source: {
    upsert(args: unknown): Promise<{ id: bigint }>;
    delete(args: unknown): Promise<unknown>;
  };
  content: {
    deleteMany(args: unknown): Promise<{ count: number }>;
    create(args: unknown): Promise<{ id: bigint }>;
  };
  $disconnect(): Promise<void>;
};

/**
 * 原始（**未清洗**）的富文本 + 攻击载荷。
 *
 * 里面刻意混了「应当保留的结构」与「必须被剥掉的东西」两类，
 * 这样一条用例能同时证明 sanitizer 的两侧都在工作。
 */
const RAW_BODY_ORIGINAL = [
  '<p>第一段正文。</p>',
  '<blockquote>这是一段引用。</blockquote>',
  '<p onclick="window.__e2eOnclick = true">点击这个段落不应触发 onclick。</p>',
  '<a href="https://example.com/allowed">白名单内链接</a>',
  '<a href="javascript:window.__e2eJs = true">危险链接</a>',
  '<script>window.__e2eScript = true</script>',
  '<img src="/e2e-missing-image.png" onerror="window.__e2eOnerror = true">',
].join('');

/**
 * 译文的形状 —— **纯文本**，故意让它包含看起来像标签的字符。
 * React 文本渲染应当把它们原样显示出来（转义），而不是解析成元素。
 */
const RAW_BODY_TRANSLATED = '<b>译文</b><script>window.__e2eTranslatedScript = true</script>';

/**
 * 确保 `process.env.DATABASE_URL` 有值。
 *
 * ⚠ 必须显式做：`global-setup.ts` 把 `.env` 喂给的是 **api/web 子进程**，
 * 并不改 Playwright 主进程的环境。仓库里没有 dotenv，所以这里得自己读
 *（同 `prisma/__tests__/database.integration.spec.ts` 的做法）。
 */
function ensureDatabaseUrl(): void {
  if ((process.env['DATABASE_URL'] ?? '') !== '') return;
  const envPath = path.join(REPO_ROOT, '.env');
  if (!existsSync(envPath)) {
    throw new Error('[e2e] 缺少 .env，无法拿到 DATABASE_URL 来造数据。');
  }
  const parsed = parseDotEnv(readFileSync(envPath, 'utf8'));
  const url = parsed['DATABASE_URL'];
  if (url === undefined || url === '') {
    throw new Error('[e2e] .env 里没有 DATABASE_URL，无法造数据。');
  }
  process.env['DATABASE_URL'] = url;
}

/** 造一条公开可见（`pipeline_status = APPROVED`）的内容，返回它的 id。 */
async function seedContent(prisma: PrismaLike): Promise<string> {
  const source = await prisma.source.upsert({
    where: { slug: SOURCE_SLUG },
    update: { enabled: true },
    create: {
      name: 'E2E Article HTML Guard',
      slug: SOURCE_SLUG,
      type: 'RSS',
      kind: 'OFFICIAL',
      tier: 'B',
      official: false,
      enabled: true,
    },
    select: { id: true },
  });

  // 先删后插：重复运行不累积数据，也不会因为唯一约束撞车。
  await prisma.content.deleteMany({ where: { sourceId: source.id } });

  // 走**真实**的清洗器（与 normalize.ts:136 是同一个函数、同一份策略）。
  const bodyOriginal = sanitizeArticleHtml(RAW_BODY_ORIGINAL);
  if (bodyOriginal === null) {
    throw new Error('[e2e] 清洗结果为空 —— 载荷或清洗策略变了，用例需要更新。');
  }

  const created = await prisma.content.create({
    data: {
      sourceId: source.id,
      type: 'ARTICLE',
      title: 'E2E 正文 HTML 渲染守卫',
      bodyOriginal,
      bodyTranslated: RAW_BODY_TRANSLATED,
      language: 'zh',
      originalUrl: 'https://example.com/e2e/article-html-guard',
      pipelineStatus: 'APPROVED',
      publishedAt: new Date('2026-01-01T00:00:00.000Z'),
    },
    select: { id: true },
  });

  return String(created.id);
}

/** 清掉本用例造的数据（内容 + 来源）。 */
async function cleanupContent(prisma: PrismaLike): Promise<void> {
  const source = await prisma.source.upsert({
    where: { slug: SOURCE_SLUG },
    update: {},
    create: {
      name: 'E2E Article HTML Guard',
      slug: SOURCE_SLUG,
      type: 'RSS',
      kind: 'OFFICIAL',
      tier: 'B',
      official: false,
      enabled: true,
    },
    select: { id: true },
  });
  await prisma.content.deleteMany({ where: { sourceId: source.id } });
  await prisma.source.delete({ where: { id: source.id } });
}

/* ------------------------------------------------------------------ */
/* 用例                                                                */
/* ------------------------------------------------------------------ */

let contentId = '';
let prisma: PrismaLike | null = null;

test.beforeAll(async () => {
  ensureDatabaseUrl();
  const { PrismaClient } = requireFromApi('@prisma/client') as {
    PrismaClient: new () => PrismaLike;
  };
  prisma = new PrismaClient();
  contentId = await seedContent(prisma);
});

test.afterAll(async () => {
  const client = prisma;
  if (client === null) return;
  try {
    await cleanupContent(client);
  } finally {
    await client.$disconnect();
  }
});

/** 读一个埋进载荷的哨兵 —— 非 null 表示那段代码**真的执行了**。 */
async function sentinel(page: Page, name: string): Promise<unknown> {
  return page.evaluate((key) => (window as unknown as Record<string, unknown>)[key] ?? null, name);
}

test('文章页：body_original 渲染为安全 HTML，body_translated 仍走 React 文本转义', async ({
  page,
}) => {
  await page.goto(`/article/${contentId}`);

  const originalBox = page.locator('.article-body .article-text').first();
  await expect(originalBox).toBeVisible();

  /* ---------------------------------------------------------------- */
  /* 1. 富文本变成真正的元素（不是可见的标签文字）                       */
  /* ---------------------------------------------------------------- */
  await expect(originalBox.locator('p').first()).toHaveText('第一段正文。');
  await expect(originalBox.locator('blockquote')).toHaveText('这是一段引用。');
  // 反向对照：如果还在按纯文本渲染，下面两条会命中字面量标签。
  await expect(originalBox).not.toContainText('<p>');
  await expect(originalBox).not.toContainText('blockquote>');

  /* ---------------------------------------------------------------- */
  /* 2. 白名单内的 <a>：可点击，且被外链加固                            */
  /* ---------------------------------------------------------------- */
  const safeLink = originalBox.locator('a', { hasText: '白名单内链接' });
  await expect(safeLink).toBeVisible();
  await expect(safeLink).toHaveAttribute('href', 'https://example.com/allowed');
  await expect(safeLink).toHaveAttribute('target', '_blank');
  await expect(safeLink).toHaveAttribute('rel', /noopener/);
  await expect(safeLink).toHaveAttribute('rel', /noreferrer/);

  /* ---------------------------------------------------------------- */
  /* 3. 结构性总览：渲染后的正文里没有任何事件属性                      */
  /* ---------------------------------------------------------------- */
  // 这条是安全断言里的**主力证据之一**：它断言的是 DOM 的最终事实，
  // 而不是「源码里没有某个字符串」。只要渲染层放行了未清洗内容，这里就会命中。
  const inlineHandlers = await originalBox.evaluate((el) =>
    [...el.querySelectorAll('*')]
      .flatMap((node) => [...node.attributes].map((attr) => attr.name.toLowerCase()))
      .filter((name) => name.startsWith('on')),
  );
  expect(inlineHandlers, '正文里不该出现任何 on* 事件属性').toEqual([]);

  /* ---------------------------------------------------------------- */
  /* 4. <script> 不执行                                                */
  /* ---------------------------------------------------------------- */
  // 主力证据是「DOM 里没有 script 元素」—— 元素不存在，就无从执行。
  // ⚠ 哨兵只是**旁证**：按 HTML 规范，用 innerHTML 插入的 <script> 本来
  //   就永远不会执行。所以这条比下面那条 onclick 弱。
  await expect(originalBox.locator('script')).toHaveCount(0);
  expect(await sentinel(page, '__e2eScript'), '<script> 被执行了').toBeNull();

  /* ---------------------------------------------------------------- */
  /* 5. onclick 不执行（属性被剥掉 + 真的点一下）                       */
  /* ---------------------------------------------------------------- */
  // 这条是**可信的执行探测**：单独验证过 —— 若页面上真有一个
  // `onclick="window.__x = true"`，Playwright 点下去哨兵会变成 true。
  // 所以「点了之后哨兵仍是 null」确实证明 onclick 没有被执行，
  // 而不只是「源码里没写」。
  const onclickParagraph = originalBox.locator('p', { hasText: '点击这个段落' });
  expect(
    await onclickParagraph.evaluate((el) => el.getAttribute('onclick')),
    'onclick 属性应当被清洗剥掉',
  ).toBeNull();
  await onclickParagraph.click();
  expect(await sentinel(page, '__e2eOnclick'), 'onclick 被触发了').toBeNull();

  /* ---------------------------------------------------------------- */
  /* 6. 危险 scheme 的链接不可用                                       */
  /* ---------------------------------------------------------------- */
  // 主力证据是「href 属性被剥掉」⇒ 危险 URL 根本不在 DOM 里。
  // 下面再点一下、并断言没有跳转作为补充；⚠ 但**不**把它当作「没有执行」的
  // 证明：实测 Playwright 对这类链接的 click 行为不可靠（有时执行有时不执行）。
  const evilLink = originalBox.locator('a', { hasText: '危险链接' });
  expect(
    await evilLink.evaluate((el) => el.getAttribute('href')),
    'javascript: 的 href 应当被清洗剥掉',
  ).toBeNull();
  await evilLink.click();
  expect(await sentinel(page, '__e2eJs'), 'javascript: URL 被执行了').toBeNull();
  await expect(page, '点击危险链接不应发生导航').toHaveURL(new RegExp(`/article/${contentId}$`));

  /* ---------------------------------------------------------------- */
  /* 6b. DOM 全域扫描：正文里不存在任何危险 scheme                      */
  /* ---------------------------------------------------------------- */
  // ⚠ 上面第 6 条只覆盖了**那一个**「危险链接」锚点。这一条是**全域**的：
  // 遍历正文里所有元素的 href / src / xlink:href，断言没有一个用了
  // javascript: / data: / vbscript:。
  //
  // 为什么要多这一条：清洗策略是**白名单**（`ALLOWED_SCHEMES = ['http','https','mailto']`），
  // 而白名单一旦被放松（有人往里加了 `javascript` 或 `data`），第 6 条只会红在
  // 它自己那个样本上；这一条覆盖的是**渲染结果的全部元素**，是「策略本身」的检验。
  const dangerousUrls = await originalBox.evaluate((el) =>
    [...el.querySelectorAll('*')].flatMap((node) =>
      ['href', 'src', 'xlink:href'].flatMap((attr) => {
        const value = node.getAttribute(attr);
        return value !== null && /^\s*(javascript|data|vbscript):/i.test(value)
          ? [`${node.tagName.toLowerCase()}[${attr}]=${value.slice(0, 40)}`]
          : [];
      }),
    ),
  );
  expect(dangerousUrls, '正文 DOM 里不应出现任何危险 scheme 的 href/src').toEqual([]);

  // ⚠ **反空跑**：上面那条如果恒真就毫无价值。这里临时往 DOM 里插一个危险链接，
  // 确认扫描**真的能发现它**，再移除。没有这一步，「什么都没找到」既可能是
  // 「干净」也可能是「扫描写错了」——两者必须能区分。
  const scanCanDetect = await originalBox.evaluate((el) => {
    const probe = el.ownerDocument.createElement('a');
    probe.setAttribute('href', 'javascript:void 0');
    el.appendChild(probe);
    const found = [...el.querySelectorAll('*')].some((node) =>
      /^\s*javascript:/i.test(node.getAttribute('href') ?? ''),
    );
    probe.remove();
    return found;
  });
  expect(scanCanDetect, '扫描本身必须能发现危险 URL（防止这条断言恒真）').toBe(true);

  /* ---------------------------------------------------------------- */
  /* 7. onerror 不执行                                                 */
  /* ---------------------------------------------------------------- */
  expect(await sentinel(page, '__e2eOnerror'), 'onerror 被触发了').toBeNull();

  /* ---------------------------------------------------------------- */
  /* 8. 译文仍是 React 文本：标签被转义显示，脚本不执行                  */
  /* ---------------------------------------------------------------- */
  await page.getByRole('button', { name: '看中文翻译' }).click();
  const translatedBox = page.locator('.article-body .article-text').nth(1);
  await expect(translatedBox).toBeVisible();
  // 译文的 `<b>` 不该变成元素，而应当作为**文字**出现。
  await expect(translatedBox.locator('b')).toHaveCount(0);
  await expect(translatedBox).toContainText('<b>译文</b>');
  await expect(translatedBox).toContainText('<script>');
  expect(await sentinel(page, '__e2eTranslatedScript'), '译文的 script 被执行了').toBeNull();
});
