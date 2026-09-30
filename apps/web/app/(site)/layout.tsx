/**
 * 前台布局 —— 12 个页面共用的外壳。
 *
 * ⚠ 这里**不做鉴权跳转**。`docs/00` 的公开面是**游客可读**的：
 * 今日 / 精选 / 日报 / X 动态 / 人物 / 主题 / 搜索 / 文章全部不需要登录。
 * 只有收藏页、以及「收藏」这个动作需要 —— 那一页自己处理
 *（未登录显示一个引导登录的空态，而不是把整站变成登录墙）。
 *
 * 把守卫加在这一层是最常见的错误做法：它会让上面那 8 个页面全部
 * 变成需要登录，而 `docs/17` 的公开面验收项会因此失败。
 */

import type { ReactElement, ReactNode } from 'react';
import { AppShell } from '../../components/shell';
import { SITE_FOOTER_NAV, SITE_NAV } from '../../lib/nav';

export default function SiteLayout({ children }: { children: ReactNode }): ReactElement {
  return (
    <AppShell nav={SITE_NAV} footerItem={SITE_FOOTER_NAV} crumbRoot="信号">
      {children}
    </AppShell>
  );
}
