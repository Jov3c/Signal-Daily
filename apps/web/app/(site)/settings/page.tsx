/**
 * 设置（`/settings`）—— 原型的 `settings.html`，外加一个**账户区**。
 *
 * ```text
 * 阅读   正文大小（小/默认/大）· 记录阅读位置
 * 翻译   英文内容自动显示中文翻译
 * 外观   主题（浅色 / 深色 / **跟随系统**）
 * X 动态 显示 Quote Post · 显示普通转发
 * 账户   登录状态 / 邮箱 / 登出        ← 原型里没有，见下
 * ```
 *
 * ── 两处与原型**有意不同**（都已在 CCR-agent-13 里写明）──────────────
 *
 * 1. **主题是三档不是两档**。原型的设置页只有浅色/深色，而 `docs/11`
 *    定义的是 `LIGHT / DARK / SYSTEM` —— 只做两档会让 `SYSTEM`
 *    在界面上**永远选不到**（契约里有、没有入口，与刚才那个「收藏
 *    没有登录入口」是同一类缺陷）。
 * 2. **多了账户区**。原型是静态 mock，没有登录概念；而收藏、阅读进度、
 *    偏好同步都要登录，所以必须有一个地方能看到「我现在是登录的」并登出。
 *    顶栏的账户按钮就指向这里 —— 这样不必新造一个下拉菜单交互。
 *
 * ── ⚠ 偏好存哪里 ────────────────────────────────────────────────────
 * 原型说「设置会保存在当前浏览器」（localStorage），而 `docs/11` 说的是
 * **「阅读偏好同步」**（登录用户的服务端能力）。两者不冲突，取交集：
 *
 * ```text
 * 匿名访客   只写 localStorage（立刻生效，刷新保留）
 * 登录用户   写 localStorage **并且** PUT /me/preferences（换设备也在）
 * ```
 *
 * 这一段是客户端元件（`components/settings-view.tsx`）——
 * 它要读写 localStorage 与调用 API。
 */

import type { ReactElement } from 'react';
import { PageHead } from '../../../components/shell';
import { SettingsView } from '../../../components/settings-view';

export default function SettingsPage(): ReactElement {
  return (
    <div className="container">
      <PageHead
        eyebrow="Preferences"
        title="设置"
        subtle="调整阅读、翻译和外观。登录后这些设置会在设备之间同步。"
      />
      <SettingsView />
    </div>
  );
}
