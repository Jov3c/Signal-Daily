/**
 * 登录链路的 E2E —— 一条用例守住三类**真实发生过**的缺陷。
 *
 * 背景（2026-09-30 浏览器走查发现，修复见 ed0b1a1 / 0e01050）：
 *
 * ```text
 * A 类  /api/v1/* 相对路径打到 Next 自己 → 404 →「点了没反应」
 *       修：apps/web/next.config.mjs 的 rewrites()
 * B 类  verifyEmailCode 漏读 {data:…} 封套 → session.user 是 undefined
 *       → 顶栏读 user.displayName → TypeError → 整页崩
 *       修：0e01050 把解包下沉进 apiRequest（结构性根治）
 * C 类  登录成功后服务端组件不重渲染 → 页面仍显示「未登录」
 *       修：components/auth.tsx 里的 router.refresh()
 * ```
 *
 * ── 为什么**一条**用例就够 ────────────────────────────────────────
 * 三类缺陷都落在同一条时间线上，而且互相是「上游不通、下游根本走不到」的关系：
 *
 * ```text
 * 点「发送验证码」
 *   └─ A 类：代理不通 → 请求 404 → 停在第一步（「验证码」输入框永远不出现）
 *      └─ 填验证码、点「登录」
 *         └─ B 类：封套没解 → session.user 是 undefined → 登录动作整个炸掉
 *            → 抽屉不关、页面不变 → 后面「还没有收藏」的断言失败
 *            └─ C 类：页面确实登录了，但服务端组件没重渲染
 *               → 页面还挂着「登录后才能使用收藏」→ 断言失败
 * ```
 *
 * 所以每一个下游断言都同时是上游的探针。反过来，如果拆成三条用例，
 * 上游一坏就要收到三条红 —— 而其中两条的红描述的是同一个原因，
 * 排查时反而更慢。
 *
 * ⚠ **C 类只能用 `/bookmarks` 测，而且绝不能 `page.reload()`。**
 *   - 「绝不能 reload」是因为 `reload()` **正是 C 类要守的东西**：
 *     手动刷新会让服务端带着新 Cookie 重新渲染，页面当然就对了。
 *     一条会自己刷新页面的用例，对 C 类是恒绿的 —— 它测的是它自己那个 refresh。
 *   - 「只能 /bookmarks」是因为 `/settings` 的账户区是**客户端组件**（读 `useAuth()`），
 *     登录后本来就会重渲染，测不出 C 类。`/bookmarks` 是唯一一个依赖 Cookie 的
 *     **服务端**前台页面。
 */

import { expect, test } from '@playwright/test';
import { WEB_BASE_URL, readOtpCode, uniqueEmail } from './helpers';

/**
 * A 类缺陷的**显式守卫**。
 *
 * 主用例里其实也覆盖了 A（代理不通就永远停在第一步），但它给出的失败信息
 * 是「等不到『验证码』输入框」—— 指向的是登录抽屉，而不是「代理断了」。
 * 这种错位会让人先去翻 `auth.tsx`，而真正的问题在 `next.config.mjs`。
 *
 * 所以单独留一条：失败时状态码会直接印在报错里。
 * 断言 200 而不是「不是 404」：`/api/v1/today` 是公开读接口，
 * 只有 200 才说明「Next 把请求转发给了 api，并且 api 正常应答」。
 * 502 / 500 同样意味着链路是断的，不该被「不是 404」放过。
 */
test('A 类守卫：浏览器侧的 /api/v1/* 经 Next rewrite 打到了 API（200，不是 404）', async ({
  request,
}) => {
  const response = await request.get(`${WEB_BASE_URL}/api/v1/today`);

  expect(
    response.status(),
    'Next 的 rewrites() 应当把 /api/:path* 转发到 127.0.0.1:3001。' +
      '若这里是 404，说明 rewrite 没生效（dev/build 的构建产物对不上），' +
      '浏览器侧所有相对路径请求都会静默打到 Next 自己 —— 也就是 A 类缺陷。',
  ).toBe(200);
});

/**
 * 主用例。
 *
 * 用**每次运行唯一**的邮箱：登录会 `findOrCreateByEmail` 自动建号，
 * 所以不需要任何前置数据，也顺带绕开 `otpRequestPerEmail`（3 次 / 600 秒）
 * 的跨运行累积。（per-IP 那层由 globalSetup 清 Redis 键解决。）
 */
test('登录链路：在 /bookmarks 上完成邮箱验证码登录，服务端组件随之重渲染（全程不 reload）', async ({
  page,
}) => {
  const email = uniqueEmail();

  // ── 起点：未登录的收藏页 ────────────────────────────────────────
  await page.goto('/bookmarks');
  await expect(page.getByText('登录后才能使用收藏')).toBeVisible();

  /**
   * ⚠ 「不许 reload」的**可执行**守卫。
   *
   * 光靠「我们没写 page.reload()」是守不住的：将来有人为了让用例稳定，
   * 顺手在断言前加一句 `await page.reload()`，这条用例就悄悄失去了意义
   * （它会变成在测自己那一次刷新），而且**永远是绿的** —— 没人会发现。
   *
   * 所以在登录**之前**往 window 上放一个哨兵。`router.refresh()` 是软刷新，
   * 保留客户端上下文，哨兵还在；而 `page.reload()` 会换掉整个 JS 环境，
   * 哨兵消失。最后一步把它读回来比对 —— 用例从此**自己**拒绝 reload。
   */
  const sentinel = `sentinel-${Date.now().toString(36)}`;
  await page.evaluate((value) => {
    (window as unknown as Record<string, unknown>)['__e2eSentinel'] = value;
  }, sentinel);

  // ── 打开登录抽屉 ────────────────────────────────────────────────
  // 未登录时顶栏（<header class="topbar">）里只有这一个「登录」按钮。
  await page.getByRole('button', { name: '登录' }).click();

  const drawer = page.getByRole('complementary', { name: '登录' });
  await expect(drawer).toBeVisible();

  // ── 第一步：邮箱 → 发送验证码 ───────────────────────────────────
  await drawer.getByLabel('邮箱').fill(email);
  await drawer.getByRole('button', { name: '发送验证码' }).click();

  /**
   * ⚠ A 类在这里暴露。
   * 代理不通 → POST /api/v1/auth/email/request-code 得到 404 →
   * `sendCode()` 走 catch、`setStep('code')` 不执行 → 这个断言超时。
   */
  await expect(drawer.getByLabel('验证码')).toBeVisible({ timeout: 20_000 });

  // ── 第二步：验证码 → 登录 ───────────────────────────────────────
  const code = await readOtpCode(email);
  await drawer.getByLabel('验证码').fill(code);
  await drawer.getByRole('button', { name: '登录' }).click();

  /**
   * ⚠ B 类与 C 类在这里暴露。
   *
   * B 类（封套没解）：`verifyEmailCode` 拿到的是封套而不是载荷，
   *   `session.user` 是 undefined → `onLoggedIn(session.user)` 先读到 undefined，
   *   紧接着顶栏读 `user.displayName` 抛 TypeError → 会话根本没建成、
   *   抽屉不关、页面不动 → 下面两行都会失败。
   * 注意 B 类在 `0e01050` 之后已经是**编译期**防住的（`apiRequest` 的
   *   `PayloadOnly<T>` 类型守卫），这条用例守的是「退化形态」——
   *   比如有人绕过 `apiRequest` 直接 fetch。
   *
   * C 类（服务端组件不重渲染）：会话建了、顶栏也变了，但 `/bookmarks`
   *   这份服务端渲染结果还是登录前那一份 → 页面仍显示「登录后才能使用收藏」。
   *   **这里没有、也绝不能有 `page.reload()`。**
   */
  await expect(page.getByText('还没有收藏')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('登录后才能使用收藏')).toHaveCount(0);

  // ── 「没有 reload」的最终证明 ───────────────────────────────────
  const survived = await page.evaluate(() => {
    return (window as unknown as Record<string, unknown>)['__e2eSentinel'] ?? null;
  });
  expect(
    survived,
    '页面在登录过程中被整体刷新过（哨兵丢了）。' +
      'C 类断言的前提是「不 reload」—— 一旦 reload，这条用例就测不到 C 类了。',
  ).toBe(sentinel);
});
