/**
 * 后台布局。
 *
 * 与原型的**用户前台**共用同一套外壳与设计令牌（用户 2026-09-30 的决定：
 * 「沿用前台 v1.7 视觉」）—— 后台没有设计稿，新造一套视觉只会让两个
 * 界面看起来像两个产品。差别只有两处：
 *
 * ```text
 * 导航换成 docs/09 的后台模块
 * 多一张表格样式（app/admin.css —— 前台是阅读产品，没有表格）
 * ```
 *
 * ── ⚠ 这一层**不做**登录跳转 ────────────────────────────────────────
 * 后台的每一页都需要 ADMIN，而「谁能进」的判定在**服务端 API**
 *（`AdminGuard` 按库里的角色判，撤权立刻生效）。前端在这一层做跳转
 * 只会多做一次 `GET /me`，而且那个判断是**可被绕过的**（直接请求数据接口
 * 一样会被 401/403 挡住）—— 所以它不构成一层安全，只构成一次闪烁。
 *
 * 每一页自己处理「401 / 403 就把人送到登录抽屉或说明页」——
 * 那样错误来自**真正做判断的那一层**，而不是前端猜的。
 */

import type { ReactElement, ReactNode } from 'react';
import { AppShell } from '../../components/shell';
import { ADMIN_NAV } from '../../lib/nav';
import '../admin.css';

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

export default function AdminLayout({ children }: { children: ReactNode }): ReactElement {
  return (
    <AppShell nav={ADMIN_NAV} crumbRoot="信号后台" showSearch={false}>
      {children}
    </AppShell>
  );
}
