/**
 * 导航结构 —— **v1.7 冻结的信息架构**（`docs/23` / `UI-DESIGN-v1.7`）。
 *
 * ```text
 * 今日
 * 精选
 * 日报
 * X 动态
 *
 * 发现
 *   人物
 *   主题
 *
 * 资料
 *   收藏
 *   搜索
 *
 * 设置          ← 沉在侧栏底部，不属于任何分组
 * ```
 *
 * ── ⚠ 「订阅」没有了，而且不许回来 ──────────────────────────────────
 * v1.7 删掉了「我的订阅」：没有订阅页、没有人物/主题/来源订阅、
 * 没有 Subscribe 按钮、没有 localStorage 里的订阅状态（`docs/23` 的「删除」段）。
 * `docs/17` 的第 18 / 19 条验收项直接断言 `/subscriptions/*` 不存在、
 * 前端没有「我的订阅」与 `data-subscribe`。
 *
 * 所以这个文件里**只有**上面那 9 项。`apps/web/test/visual-contract.spec.ts`
 * 会拿它去比对，加一个「订阅」入口会让那条守卫变红 —— 那是刻意的，
 * 因为这是一次**产品决定**，不该悄悄回退。
 */

/**
 * 图标用**名字**（字符串）而不是元件本身。
 *
 * ⚠ 这不是风格问题，是 Next.js 的**硬限制**：导航表由**服务端**布局
 * （`app/(site)/layout.tsx`）传给**客户端**外壳（`components/shell.tsx`），
 * 而函数（包括元件）不能穿过 Server → Client 边界 ——
 * 直接传 `icon: IconHome` 会让构建失败：
 *
 * ```text
 * Error: Functions cannot be passed directly to Client Components
 *   {href: "/", label: "今日", icon: function f}
 * ```
 *
 * 名字 → 元件的映射留在 `components/icons.tsx` 的 `ICONS` 里（客户端侧）。
 * 顺带的好处：这个文件变成**纯数据**，测试可以在没有 React 的环境里
 * 直接 import 它来断言信息架构。
 */
export type IconName =
  | 'home'
  | 'star'
  | 'newspaper'
  | 'x'
  | 'people'
  | 'topic'
  | 'bookmark'
  | 'search'
  | 'settings'
  | 'calendar';

export type NavItem = {
  href: string;
  label: string;
  icon: IconName;
};

export type NavSection = {
  /** 分组标题。第一组**没有**标题（原型里前三项直接跟在品牌下面）。 */
  label: string | null;
  items: NavItem[];
};

export const SITE_NAV: NavSection[] = [
  {
    label: null,
    items: [
      { href: '/', label: '今日', icon: 'home' },
      { href: '/featured', label: '精选', icon: 'star' },
      { href: '/daily', label: '日报', icon: 'newspaper' },
      { href: '/x', label: 'X 动态', icon: 'x' },
    ],
  },
  {
    label: '发现',
    items: [
      { href: '/people', label: '人物', icon: 'people' },
      { href: '/topics', label: '主题', icon: 'topic' },
    ],
  },
  {
    label: '资料',
    items: [
      { href: '/bookmarks', label: '收藏', icon: 'bookmark' },
      { href: '/search', label: '搜索', icon: 'search' },
    ],
  },
];

/** 沉在侧栏底部的单项（原型里与分组之间隔一个 `sidebar-spacer`）。 */
export const SITE_FOOTER_NAV: { href: string; label: string; icon: IconName } = {
  href: '/settings',
  label: '设置',
  icon: 'settings',
};

/**
 * 后台导航 —— **这是 `docs/09` 的模块清单，不是后台原型**
 *（后台没有任何设计稿；用户于 2026-09-30 决定「沿用前台 v1.7 的视觉」，
 * 所以信息架构按 `docs/09` 与 `tasks/agent-12-admin-ui.md` 的页面清单来）。
 *
 * ⚠ 每一项都必须有对应的**已实现** API。Jobs / Notifications / AI Usage
 * 三页原本没有接口，用户授权补了（见 `CONTRACT_CHANGE_REQUEST-agent-12.md` 第 1 项）。
 */
export const ADMIN_NAV: NavSection[] = [
  {
    label: null,
    items: [
      { href: '/admin', label: 'Dashboard', icon: 'home' },
      { href: '/admin/review', label: '审核队列', icon: 'star' },
      { href: '/admin/daily', label: '日报编排', icon: 'newspaper' },
    ],
  },
  {
    label: '来源',
    items: [
      { href: '/admin/sources', label: 'Source 管理', icon: 'topic' },
      { href: '/admin/sources/x', label: 'X 白名单', icon: 'x' },
    ],
  },
  {
    label: '运维',
    items: [
      { href: '/admin/jobs', label: 'Jobs', icon: 'calendar' },
      { href: '/admin/notifications', label: '通知', icon: 'bookmark' },
      { href: '/admin/ai-usage', label: 'AI 用量', icon: 'star' },
    ],
  },
];

/** 该路径是否命中这一项（`/admin` 只在精确相等时命中，否则它会吃掉所有子页）。 */
export function isActive(pathname: string, href: string): boolean {
  if (href === '/' || href === '/admin') return pathname === href;
  return pathname === href || pathname.startsWith(`${href}/`);
}
