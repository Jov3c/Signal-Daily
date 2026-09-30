/**
 * 根布局。
 *
 * 三件事，顺序都不能换：
 *
 * ```text
 * 1. globals.css          —— 移植自冻结原型的设计令牌与全部元件样式
 * 2. 内联主题脚本          —— 必须在**第一次绘制之前**跑，否则深色用户会白闪
 * 3. 三个 Provider         —— Toast 在外，其次 Theme，最后 Auth
 *                             （Auth 要用 useToast 与 useTheme，所以它在最里）
 * ```
 *
 * ── Agent 12 与 13 共用一个根 ────────────────────────────────────────
 * 后台在 `/admin/*`，前台在 `/`，两者**同一个 Next 应用、同一个根布局**。
 * 这不是偷懒：`docs/16` 的部署形态是 nginx 把 `/` 全部转给 web，
 * 单独再起一个后台应用要多一个容器、多一条 nginx location、多一份构建，
 * 而收益是零（它们共用全部设计令牌与元件）。
 * 后台的差异只在**侧栏导航**与几个表格样式（见 `app/admin.css`）。
 */

import type { Metadata } from 'next';
import type { ReactElement, ReactNode } from 'react';
import { AuthProvider } from '../components/auth';
import { ThemeProvider, THEME_BOOTSTRAP_SCRIPT } from '../components/theme';
import { ToastProvider } from '../components/toast';
import './globals.css';

export const metadata: Metadata = {
  title: '信号 Signal',
  description: '编辑型科技阅读 —— Less noise. More worth reading.',
};

export default function RootLayout({ children }: { children: ReactNode }): ReactElement {
  return (
    <html lang="zh-CN">
      <body>
        {/*
         * ⚠ 这段脚本必须是 `<body>` 的**第一个**子节点，并且是同步内联的。
         *
         * 它把 localStorage 里的主题/字号在**绘制之前**写到 <body> 上，
         * 否则深色用户每次刷新都会先看到一帧暖纸色。
         * 属性挂在 <body> 而不是 <html>：移植过来的 CSS 选择器是
         * `body[data-theme="dark"]`（见 globals.css）。
         *
         * `dangerouslySetInnerHTML` 在这里是必要的 —— 任何异步加载
         *（含 next/script 的 afterInteractive）都要等水合，那时已经画过了。
         * 内容是本仓库内的常量，不含任何用户输入。
         */}
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP_SCRIPT }} />

        <ToastProvider>
          <ThemeProvider>
            <AuthProvider>{children}</AuthProvider>
          </ThemeProvider>
        </ToastProvider>
      </body>
    </html>
  );
}
