'use client';

/**
 * 应用外壳 —— 侧栏 + 顶栏 + 遮罩。**结构逐字对应 v1.7 原型**。
 *
 * ```text
 * <div class="app">
 *   <aside class="sidebar">  品牌 / 导航分组 / spacer / 设置 / 页脚
 *   <main class="main">
 *     <header class="topbar">  面包屑 + 搜索 + 账户 + 主题
 *     <div class="container">  页面内容
 *   <div class="overlay">
 * ```
 *
 * 两个与原型**有意不同**的地方（都是为了让同一份皮能同时服务前台与后台）：
 *
 * 1. **导航来自 `lib/nav.ts`**，不是写死在 12 个页面里。原型每个页面都复制
 *    一份侧栏，改一处要改 12 处 —— 那是「12 份可能漂移的副本」。
 * 2. **多了一个账户入口**。原型没有登录界面（它是静态 mock），而收藏 /
 *    阅读进度 / 偏好同步都要登录，所以顶栏必须有入口（见 `auth.tsx` 的说明）。
 *    已登录时它指向 `/settings`（账户区在那里），未登录时打开登录抽屉。
 *
 * 移动端抽屉（`.sidebar.open`）沿用原型的 `data-mobile-menu` +
 * `.overlay` 那套，没有新造交互。
 */

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState, type ReactElement, type ReactNode } from 'react';
import { isActive, type NavItem, type NavSection } from '../lib/nav';
import { useAuth } from './auth';
import { ICONS, IconArrowRight, IconMenu, IconMoon, IconSearch, IconSettings } from './icons';
import { useTheme } from './theme';
import { UserTheme } from '@signal/contracts';

/** 侧栏底部那句标语（原型的 `sidebar-footer`，逐字保留）。 */
const SIDEBAR_FOOTER = ['Less noise.', 'More worth reading.'];

type ShellProps = {
  nav: NavSection[];
  /** 沉在底部的单项（前台是「设置」；后台没有）。 */
  footerItem?: NavItem;
  /** 面包屑的前缀，前台是「信号」，后台是「信号后台」。 */
  crumbRoot: string;
  /** 顶部右侧是否有「搜索」按钮（后台不需要）。 */
  showSearch?: boolean;
  children: ReactNode;
};

export function AppShell({
  nav,
  footerItem,
  crumbRoot,
  showSearch = true,
  children,
}: ShellProps): ReactElement {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);

  // 路由一变就收起移动端抽屉 —— 否则点完导航它还挡着内容。
  useEffect(() => setMobileOpen(false), [pathname]);

  return (
    <div className="app">
      <div
        className={mobileOpen ? 'overlay show' : 'overlay'}
        onClick={() => setMobileOpen(false)}
        role="presentation"
      />
      <aside className={mobileOpen ? 'sidebar open' : 'sidebar'}>
        <Link className="brand" href={crumbRoot === '信号' ? '/' : '/admin'}>
          <span className="brand-mark">S</span>
          <span className="brand-copy">
            {crumbRoot === '信号' ? '信号 Signal' : '信号后台'}
            <small>{crumbRoot === '信号' ? 'AI / TECHNOLOGY' : 'EDITORIAL DESK'}</small>
          </span>
        </Link>

        {nav.map((section) => (
          <div className="nav-section" key={section.label ?? 'primary'}>
            {section.label === null ? null : <div className="section-label">{section.label}</div>}
            {section.items.map((item) => (
              <Link
                key={item.href}
                className={isActive(pathname, item.href) ? 'nav-item active' : 'nav-item'}
                href={item.href}
              >
                <span className="nav-icon">
                  <IconFor name={item.icon} />
                </span>
                <span>{item.label}</span>
              </Link>
            ))}
          </div>
        ))}

        <div className="sidebar-spacer" />

        {footerItem === undefined ? null : (
          <Link
            className={isActive(pathname, footerItem.href) ? 'nav-item active' : 'nav-item'}
            href={footerItem.href}
          >
            <span className="nav-icon">
              <IconFor name={footerItem.icon} />
            </span>
            <span>{footerItem.label}</span>
          </Link>
        )}

        <div className="sidebar-footer">
          {SIDEBAR_FOOTER[0]}
          <br />
          {SIDEBAR_FOOTER[1]}
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div>
            <button
              className="icon-btn mobile-menu-btn"
              aria-label="打开导航"
              onClick={() => setMobileOpen(true)}
            >
              <IconMenu />
            </button>
            <span className="crumb">{crumbLabel(crumbRoot, pathname, nav, footerItem)}</span>
          </div>
          <div className="top-actions">
            {showSearch ? (
              <Link className="soft-btn" href="/search">
                <IconSearch /> 搜索
              </Link>
            ) : null}
            <AccountButton />
            <ThemeToggle />
          </div>
        </header>
        {children}
      </main>
    </div>
  );
}

/**
 * 面包屑：`信号 / 今日`。
 *
 * 从导航表里按当前路径反查标签，而不是让每个页面自己传 ——
 * 传参数的话 13 个页面就有 13 个可能与侧栏不一致的面包屑。
 */
/**
 * 按名字取图标。
 *
 * ⚠ 导航表里存的是**名字**而不是元件 —— 因为导航表要穿过
 * Server → Client 边界（服务端布局 → 本文件），而函数不能跨那条边界。
 * 详见 `lib/nav.ts` 的说明。
 */
function IconFor({ name }: { name: NavItem['icon'] }): ReactElement {
  const Component = ICONS[name];
  return <Component />;
}

function crumbLabel(
  root: string,
  pathname: string,
  nav: NavSection[],
  footerItem?: NavItem,
): string {
  const all = [...nav.flatMap((section) => section.items)];
  if (footerItem !== undefined) all.push(footerItem);
  const hit = all.find((item) => isActive(pathname, item.href));
  return hit === undefined ? root : `${root} / ${hit.label}`;
}

/** 登录入口 / 账户入口。 */
function AccountButton(): ReactElement {
  const { user, loading, openLogin } = useAuth();

  if (loading) {
    // 探测期间留一个同尺寸的占位，避免顶栏在拿到 `/me` 时抖一下。
    return <span className="soft-btn" aria-hidden="true" style={{ opacity: 0.5 }}>…</span>;
  }

  if (user === null) {
    return (
      <button className="soft-btn" onClick={openLogin} type="button">
        登录
      </button>
    );
  }

  // ⚠ 已登录时不做下拉菜单：那会新造一个原型里没有的交互模式。
  // 直接去 `/settings`，账户区（邮箱 + 登出）在那里。
  const label = user.displayName ?? user.email ?? '账户';
  return (
    <Link className="soft-btn" href="/settings" title={label}>
      <IconSettings />
      <span className="account-label">{label}</span>
    </Link>
  );
}

/** 主题切换（原型的 `data-theme-toggle`：浅 ↔ 深）。 */
function ThemeToggle(): ReactElement {
  const { resolved, setTheme } = useTheme();
  return (
    <button
      className="icon-btn"
      type="button"
      aria-label={resolved === 'dark' ? '切换到浅色' : '切换到深色'}
      onClick={() => setTheme(resolved === 'dark' ? UserTheme.LIGHT : UserTheme.DARK)}
    >
      <IconMoon />
    </button>
  );
}

/** 页面主标题区（原型的 `.page-head`）。 */
export function PageHead({
  eyebrow,
  title,
  subtle,
  action,
}: {
  eyebrow: string;
  title: string;
  subtle?: string;
  action?: { href: string; label: string };
}): ReactElement {
  return (
    <section className="page-head">
      <div>
        <div className="eyebrow">{eyebrow}</div>
        <h1>{title}</h1>
        {subtle === undefined ? null : <div className="subtle">{subtle}</div>}
      </div>
      {action === undefined ? null : (
        <Link className="soft-btn" href={action.href}>
          {action.label} <IconArrowRight />
        </Link>
      )}
    </section>
  );
}

/** 区块标题（原型的 `.section-title`）。 */
export function SectionTitle({
  title,
  link,
}: {
  title: string;
  link?: { href: string; label: string };
}): ReactElement {
  return (
    <div className="section-title">
      <h2>{title}</h2>
      {link === undefined ? null : (
        <Link className="text-link" href={link.href}>
          {link.label}
        </Link>
      )}
    </div>
  );
}

/** 空态（原型的 `.empty-state` / `.search-empty`）。 */
export function EmptyState({ title, hint }: { title: string; hint?: string }): ReactElement {
  return (
    <div className="empty-state">
      <strong>{title}</strong>
      {hint === undefined ? null : (
        <>
          <br />
          {hint}
        </>
      )}
    </div>
  );
}
