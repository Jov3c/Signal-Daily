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
      // 信源采集内核（SSRF / 调度规则 / config 契约），api 与 worker 共用。
      // 由 Agent 04 按 CCR-agent-03 第 1 项从 apps/api 提取；见该包的文件头。
      '@signal/source-core': fromRoot('./packages/source-core/src/index.ts'),
      '@signal/config': fromRoot('./packages/config/src/index.ts'),
      '@signal/logger': fromRoot('./packages/logger/src/index.ts'),
      '@signal/test-utils': fromRoot('./packages/test-utils/src/index.ts'),
    },
  },
  test: {
    environment: 'node',
    include: [
      'packages/*/src/**/*.spec.ts',
      'apps/*/test/**/*.spec.ts',
      'prisma/__tests__/*.spec.ts',
    ],
    // *.integration.spec.ts 需要真实 MySQL，单独用 pnpm test:db 跑。
    exclude: ['**/node_modules/**', '**/dist/**', '**/.next/**', '**/*.integration.spec.ts'],
    reporters: ['default'],
  },
});
