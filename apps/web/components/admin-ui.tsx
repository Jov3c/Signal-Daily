/**
 * 后台的共用小元件。
 *
 * 后台没有设计稿，所以这里的样式**全部**来自 `app/admin.css`，
 * 而 `admin.css` 里的每个 `var(--…)` 都必须是前台 `globals.css` 定义过的
 *（有一条守卫盯着这件事）。换句话说：后台只能**组合**前台已有的视觉语言。
 */

import Link from 'next/link';
import type { ReactElement, ReactNode } from 'react';

/** 一个指标数字。 */
export function StatCard({
  label,
  value,
  hint,
  href,
}: {
  label: string;
  value: string | number;
  hint?: string;
  href?: string;
}): ReactElement {
  const inner = (
    <>
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {hint === undefined ? null : <div className="hint">{hint}</div>}
    </>
  );

  if (href === undefined) return <div className="stat-card">{inner}</div>;
  return (
    <Link className="stat-card" href={href}>
      {inner}
    </Link>
  );
}

/** 状态徽标。`tone='warn'` 用于「需要人看一眼」的状态。 */
export function Badge({
  children,
  tone,
}: {
  children: ReactNode;
  tone?: 'warn';
}): ReactElement {
  return <span className={tone === 'warn' ? 'badge warn' : 'badge'}>{children}</span>;
}

/** 数据表（外层自己滚，宽表不撑破页面）。 */
export function DataTable({
  headers,
  children,
}: {
  headers: string[];
  children: ReactNode;
}): ReactElement {
  return (
    <div style={{ overflowX: 'auto' }}>
      <table className="data-table">
        <thead>
          <tr>
            {headers.map((header) => (
              <th key={header}>{header}</th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

/** 空表提示。 */
export function EmptyRow({ span, text }: { span: number; text: string }): ReactElement {
  return (
    <tr>
      <td colSpan={span} className="subtle">
        {text}
      </td>
    </tr>
  );
}

/**
 * 「你没有权限」面板。
 *
 * ⚠ 401 与 403 **分开说**：401 是「还没登录」（有解决路径：去登录），
 * 403 是「登录了但不是管理员」（没有解决路径，只能找运维）。
 * 合成一句「无权访问」会让一个普通用户去反复登录 —— 而登录一百次
 * 也不会让他变成管理员。
 */
export function AdminDenied({ status }: { status: number }): ReactElement {
  if (status === 401) {
    return (
      <div className="container">
        <h1>需要登录</h1>
        <p className="subtle">
          后台需要管理员账号。点右上角的「登录」，用邮箱验证码登录。
        </p>
        <p className="subtle">登录之后如果仍然看不到内容，说明这个账号不是管理员。</p>
      </div>
    );
  }
  return (
    <div className="container">
      <h1>没有权限</h1>
      <p className="subtle">
        当前账号不是管理员。后台按**数据库里的当前角色**判定，撤权是立刻生效的 ——
        所以这不是缓存问题。
      </p>
      <p className="subtle">
        需要管理员权限请联系运维；也可以回到 <Link className="text-link" href="/">前台</Link>。
      </p>
    </div>
  );
}

/** 时间：`2026-09-30 11:02`（上海时区）。 */
export function isoShort(iso: string | null): string {
  if (iso === null) return '—';
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso));
}

/** 毫秒 → 人话。 */
export function duration(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 1000) return `${String(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m${String(Math.round((ms % 60_000) / 1000))}s`;
}

/** 美元金额。 */
export function usd(value: number): string {
  return `$${value.toFixed(4)}`;
}
