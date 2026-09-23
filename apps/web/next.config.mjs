/**
 * Next.js 配置 — Agent 00 只建立最小可用配置。
 * 路由、图片域、缓存策略等由 Agent 13 按前端 v1.7 需求补充。
 *
 * @type {import('next').NextConfig}
 */
const nextConfig = {
  reactStrictMode: true,
  // workspace 内的公共包发布的是 CJS dist，交给 Next 一起转译。
  transpilePackages: ['@signal/contracts', '@signal/config', '@signal/logger'],
};

export default nextConfig;
