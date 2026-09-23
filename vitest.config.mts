import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const fromRoot = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

/**
 * Signal 单一测试入口。
 *
 * 运行 `pnpm test` 即可跑全部包的测试，无需先 build：
 * workspace 包在测试中被 alias 到源码，避免 dist 依赖。
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
    include: ['packages/*/src/**/*.spec.ts', 'apps/*/test/**/*.spec.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/.next/**'],
    reporters: ['default'],
  },
});
