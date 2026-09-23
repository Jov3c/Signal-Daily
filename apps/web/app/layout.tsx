import type { ReactNode } from 'react';
import { BUSINESS_TIMEZONE } from '@signal/contracts';

/**
 * 根 layout — Agent 00 空壳。
 *
 * 说明：这是占位，不是设计。
 * 真实版式、字体、颜色 token 由 Agent 13 按前端 v1.7 冻结设计实现，
 * 不得以本文件为视觉依据（品牌主背景 `#F0EEE6`、Card `#F7F5EF` 等见规则 §2）。
 */

export const metadata = {
  title: 'Signal',
  description: '信号 Signal — 编辑型科技阅读平台',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN" data-timezone={BUSINESS_TIMEZONE}>
      <body>{children}</body>
    </html>
  );
}
