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

/**
 * ⚠ **强制动态渲染** —— 这一行是修一个真实缺陷加上去的。
 *
 * 实测：`/`（今日）在没有这一行时会被 Next **在构建期预渲染成静态页**。
 * 构建那一刻 API 不可达 → 页面渲染失败 → Next 却把一张**空壳 HTML**
 * （7KB、只有 `<title>`、一个 `nav-item` 都没有）写进 `.next/server/app/index.html`
 * 并标记为 `○ (Static)`。运行时它**永远返回 200 与那张空壳** ——
 * 首页从此不会更新，而所有测试都是绿的（构建也「成功」）。
 *
 * `docs/12` 的缓存策略已经落在 **API 侧**（Redis，内容 60 秒）。
 * 前端再叠一层「构建期快照」等于把「内容多久更新一次」变成
 * **「上次部署是什么时候」** —— 那是完全不同的语义，而且是错的。
 *
 * 放在 layout 上：`dynamic` 会应用到该 layout 下的**所有**子路由，
 * 所以这里一处就够，不必在 22 个页面里各写一遍（写漏一个就回到
 * 「某几页冻结在构建期」那种极难发现的状态）。
 */
export const dynamic = 'force-dynamic';

export default function SiteLayout({ children }: { children: ReactNode }): ReactElement {
  return (
    <AppShell nav={SITE_NAV} footerItem={SITE_FOOTER_NAV} crumbRoot="信号">
      {children}
    </AppShell>
  );
}
