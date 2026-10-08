// Signal — flat ESLint config (ESLint 9+).
// Owned by Agent 00. Do not fork per-app configs; extend here instead.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/.next/**',
      '**/coverage/**',
      '**/*.tsbuildinfo',
      '**/next-env.d.ts',
      // ⚠ `work/` 是项目约定的**临时目录**（`.gitignore` 与 `.dockerignore` 里都有它，
      // README 也写着「临时文件放 work/」）。它此前**没被 lint 忽略** —— 于是
      // 任何一个临时脚本都会把 `pnpm lint` 弄红，而那是与仓库无关的代码。
      // 2026-10-08 补：演示脚本放进去之后 `pnpm lint` 当场就红了。
      'work/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      'no-console': 'off',
      eqeqeq: ['error', 'smart'],
    },
  },
  {
    // Spec files may use loose typing on purpose.
    files: ['**/*.spec.ts', '**/*.test.ts', '**/test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
);
