import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const fromRoot = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

/**
 * Auth 集成测试专用配置 —— 需要**真实 MySQL + 真实 Redis**。
 *
 * 运行：
 *   pnpm --filter @signal/api test:integration
 *
 * 与默认 `pnpm test` 分开的原因（与 Agent 01 的 `pnpm test:db` 同一个理由）：
 *   默认测试必须能在没有数据库 / 没有 Redis 的机器上通过。
 *   而这些用例**不静默跳过** —— 连不上就直接失败，避免「看着是绿的其实没验」。
 *
 * 连接串来自仓库根 `.env`；可用环境变量覆盖（例如
 * `REDIS_URL=redis://127.0.0.1:6390` 指向一个临时实例）。
 */
export default defineConfig({
  resolve: {
    alias: {
      '@signal/contracts': fromRoot('../../packages/contracts/src/index.ts'),
      '@signal/source-core': fromRoot('../../packages/source-core/src/index.ts'),
      '@signal/config': fromRoot('../../packages/config/src/index.ts'),
      '@signal/logger': fromRoot('../../packages/logger/src/index.ts'),
      '@signal/test-utils': fromRoot('../../packages/test-utils/src/index.ts'),
    },
  },
  test: {
    environment: 'node',
    include: ['test/**/*.integration.spec.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/.next/**'],
    reporters: ['default'],
    // 会真的写库、真的占 Redis key，串行执行避免互相干扰
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
