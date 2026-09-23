import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const fromRoot = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

/**
 * 数据库集成测试专用配置 —— 需要真实 MySQL。
 *
 * 运行：pnpm test:db
 * 依赖：DATABASE_URL 指向一个可写的 MySQL 8 库，且已执行 pnpm db:migrate。
 *
 * 与默认 `pnpm test` 分开的原因：
 *   默认测试必须能在没有数据库的机器上通过（Agent 00 的验收标准之一），
 *   所以这些必须连库的用例单独成组，绝不静默跳过 —— 连不上就直接失败。
 */
export default defineConfig({
  resolve: {
    alias: {
      '@signal/contracts': fromRoot('./packages/contracts/src/index.ts'),
      '@signal/config': fromRoot('./packages/config/src/index.ts'),
      '@signal/logger': fromRoot('./packages/logger/src/index.ts'),
      '@signal/test-utils': fromRoot('./packages/test-utils/src/index.ts'),
    },
  },
  test: {
    environment: 'node',
    include: ['prisma/__tests__/*.integration.spec.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/.next/**'],
    reporters: ['default'],
    // 集成测试会建表/插数据，串行执行避免互相干扰
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
