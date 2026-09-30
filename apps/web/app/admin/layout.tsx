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

export default function AdminLayout({ children }: { children: ReactNode }): ReactElement {
  return (
    <AppShell nav={ADMIN_NAV} crumbRoot="信号后台" showSearch={false}>
      {children}
    </AppShell>
  );
}
