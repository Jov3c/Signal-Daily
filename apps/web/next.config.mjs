/**
 * Next.js 配置。
 *
 * ⚠ `rewrites` 那一条是**开发期的必需品**，理由是一个真被踩到的缺陷
 * （2026-09-30 浏览器走查发现）：
 *
 * ```text
 * 服务端渲染的取数走 API_BASE_URL（能到 api）—— 页面渲染正常
 * 浏览器侧的取数走相对路径 /api/v1/*（见 lib/client-api.ts）
 *   → 开发时没有 nginx，这些请求打到 Next 自己 → 404
 *   → 表现是「登录点了没反应」「收藏点了没反应」，而页面看起来一切正常
 * ```
 *
 * 首轮走查实测：点「发送验证码」得到一句通用的「没能完成登录，请稍后再试。」——
 * **看不出是接口不可达**。而 `pnpm dev`（3000）+ api（3001）的开发形态下，
 * 每一个交互功能都会这样静默失效。
 *
 * ── 为什么加在生产里也无害 ──────────────────────────────────────────
 * `docs/16` 的部署形态是 nginx 同域：`/api/` 由 nginx 直接转给 api 容器，
 * **请求根本到不了 Next**，这条 rewrite 不会被用到。它只在
 * 「Next 直接对外」的形态下生效 —— 也就是本地开发，以及任何忘了配 nginx 的部署。
 *
 * ⚠ 它**不能**替代 nginx：CSP、限流、X-Request-Id、TLS 都在那一层。
 * 这条 rewrite 只是让「没有 nginx 时也能开发」。
 *
 * @type {import('next').NextConfig}
 */

/** 与 `lib/api.ts` 的 `apiBaseUrl()` 保持同一个默认值。 */
const apiBaseUrl = (process.env.API_BASE_URL ?? 'http://127.0.0.1:3001/api').replace(/\/+$/, '');

const nextConfig = {
  reactStrictMode: true,
  // workspace 内的公共包发布的是 CJS dist，交给 Next 一起转译。
  transpilePackages: ['@signal/contracts', '@signal/config', '@signal/logger'],

  /**
   * ⚠ 在 `next build` 时求值一次并写进路由清单 —— 改 `API_BASE_URL` 需要重新构建。
   * 这是可接受的：生产走 nginx（用不到这条），而开发用的就是那个默认值。
   */
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${apiBaseUrl}/:path*` }];
  },
};

export default nextConfig;
