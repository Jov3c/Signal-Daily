/**
 * Playwright 配置 —— **只覆盖登录链路**。
 *
 * ── 为什么不复用 `scripts/ops/verify-deploy.mjs` 或 compose ──────────
 * 那些是**部署形态**的验证（nginx 同域、容器健康检查）。而这里要守的
 * 三个缺陷全都只在**开发形态**（没有 nginx、Next 直接对外）下才会出现 ——
 * 用部署形态去测，它们天然不会复现。所以 harness 必须自己起
 * `api(3001) + next start(3000)` 这个组合，见 `e2e/global-setup.ts`。
 *
 * ── 几个刻意的选择 ──────────────────────────────────────────────────
 *
 * `workers: 1` + `fullyParallel: false`：
 *   整套 harness 只有一套服务、一个 Redis、一个 MySQL。并行只会让用例
 *   互相踩（尤其限流键），换来的是更短的墙钟时间和更长的排查时间。
 *   登录链路的用例本来就是秒级的，没有并行的理由。
 *
 * `retries: 0`：
 *   重试会把「偶发」洗成「通过」，而这条用例的全部价值就是它的红。
 *   宁可让它红给我们看。setup 已经清掉了会造成不稳定的大头（限流键）。
 *
 * `trace/screenshot: 只在失败时`：
 *   失败时最需要的是「点击之后页面到底长什么样」——整页 TypeError 崩掉
 *   的表现是一个空白的抽屉。保留 trace 比重新跑一遍快得多。
 *
 * `baseURL`：
 *   固定 `http://localhost:3000`，与 `global-setup.ts` 起的 web 一致。
 *   ⚠ 不要改成 api 的端口 —— 浏览器侧的请求必须走 web，才能穿过
 *   `next.config.mjs` 的 rewrites（A 类缺陷就活在那条链路上）。
 */

import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  // setup 会起服务、teardown 会收进程树；两者都不该被套件级别的超时打断。
  globalSetup: './e2e/global-setup.ts',
  globalTeardown: './e2e/global-teardown.ts',

  // 单条用例的预算。最坏路径是「起服务 + 两次往返 + 轮询验证码」，
  // 但 setup 已经把这些的等待吞掉了，这里留的是用例自身的余量。
  timeout: 60_000,
  expect: { timeout: 20_000 },

  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: process.env['CI'] !== undefined,

  reporter: [['list'], ['html', { outputFolder: 'e2e/.artifacts/html-report', open: 'never' }]],
  outputDir: 'e2e/.artifacts/test-results',

  use: {
    baseURL: 'http://localhost:3000',
    browserName: 'chromium',
    // 中文界面：固定 locale 免得日期/数字格式随宿主环境漂移。
    locale: 'zh-CN',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },

  projects: [{ name: 'chromium' }],
});
