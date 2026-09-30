/**
 * 全局 CSS 的类型声明。
 *
 * ── 为什么需要这一行 ────────────────────────────────────────────────
 * TypeScript 5.6 起，**副作用式 import**（`import './globals.css'`）
 * 也要求模块有声明，否则报 TS2882「Cannot find module or type declarations
 * for side-effect import」。
 *
 * 而 Next 自带的 `next/types/global.d.ts` **只声明了 `*.module.css`**
 *（CSS Modules，返回一个 class 名映射对象），没有声明纯 `.css` ——
 * 因为纯 `.css` 由打包器处理、没有可导入的值。所以这里补一条。
 *
 * ⚠ 只声明 `.css`，**不要**顺手把 `*.module.css` 也写进来：
 * 那会与 Next 自带的那条冲突（两条声明同名模块时 TS 取第一条，行为不可预期），
 * 而 CSS Modules 在本项目里一个都没用。
 */

declare module '*.css';
