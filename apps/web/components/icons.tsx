/**
 * 图标集 —— **逐字移植自冻结原型 v1.7 的内联 SVG**。
 *
 * 原型把同一批 SVG 内联在 12 个页面里（共 16 个不同的图形，Siderbar 里
 * 那 9 个各出现 12 次）。这里抽成组件，**几何数据一个字都没改** ——
 * 只有 `viewbox` 改成 React 要求的 `viewBox`（大小写，语义不变）。
 *
 * 规矩：
 * - 全部 `18×18` 视口、`stroke` 由 CSS 的 `.icon` 控制（`currentColor`），
 *   所以图标自动跟随文字颜色与主题，**不要在 JSX 里写颜色**。
 * - `aria-hidden` 由本文件统一加：这些图标都是**装饰性**的，
 *   它们旁边的文字才是可访问名称。漏掉会让读屏器把每个导航项念两遍。
 */

import type { ReactElement, SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement>;

function Icon({ children, ...rest }: IconProps & { children: ReactElement }): ReactElement {
  return (
    <svg aria-hidden="true" className="icon" viewBox="0 0 18 18" {...rest}>
      {children}
    </svg>
  );
}

/** 今日 —— 房子。 */
export function IconHome(props: IconProps): ReactElement {
  return (
    <Icon {...props}>
      <>
        <path d="M3 10.5 9 5l6 5.5" />
        <path d="M5 9.5V16h8V9.5" />
      </>
    </Icon>
  );
}

/** 精选 —— 星。 */
export function IconStar(props: IconProps): ReactElement {
  return (
    <Icon {...props}>
      <path d="m9 2 1.4 4.1L14.5 7.5l-4.1 1.4L9 13l-1.4-4.1L3.5 7.5l4.1-1.4L9 2Z" />
    </Icon>
  );
}

/** 日报 —— 报纸。 */
export function IconNewspaper(props: IconProps): ReactElement {
  return (
    <Icon {...props}>
      <>
        <path d="M4 3h10v12H4z" />
        <path d="M6.5 6h5M6.5 8.5h5M6.5 11h3" />
      </>
    </Icon>
  );
}

/** X 动态。 */
export function IconX(props: IconProps): ReactElement {
  return (
    <Icon {...props}>
      <path d="m4 4 10 12M14 4 4 16" />
    </Icon>
  );
}

/** 人物。 */
export function IconPeople(props: IconProps): ReactElement {
  return (
    <Icon {...props}>
      <>
        <circle cx="7" cy="7" r="2.5" />
        <path d="M2.5 15c.6-2.5 2-4 4.5-4s4 1.5 4.5 4" />
        <path d="M11 5.5c2-.1 3 1 3 2.5s-.8 2.4-2.2 2.6M12.5 11.5c1.7.5 2.6 1.7 3 3.5" />
      </>
    </Icon>
  );
}

/** 主题 —— 井号。 */
export function IconTopic(props: IconProps): ReactElement {
  return (
    <Icon {...props}>
      <path d="M6 2 4.5 16M12.5 2 11 16M2.5 7h13M2 12h13" />
    </Icon>
  );
}

/** 收藏 —— 书签。 */
export function IconBookmark(props: IconProps): ReactElement {
  return (
    <Icon {...props}>
      <path d="M5 3h8v13l-4-2.6L5 16V3Z" />
    </Icon>
  );
}

/** 搜索。 */
export function IconSearch(props: IconProps): ReactElement {
  return (
    <Icon {...props}>
      <>
        <circle cx="8" cy="8" r="5" />
        <path d="m12 12 4 4" />
      </>
    </Icon>
  );
}

/** 设置 —— 齿轮。 */
export function IconSettings(props: IconProps): ReactElement {
  return (
    <Icon {...props}>
      <>
        <circle cx="9" cy="9" r="2.4" />
        <path d="M9 2.5v1.3M9 14.2v1.3M2.5 9h1.3M14.2 9h1.3M4.4 4.4l.9.9M12.7 12.7l.9.9M13.6 4.4l-.9.9M5.3 12.7l-.9.9" />
      </>
    </Icon>
  );
}

/** 移动端菜单。 */
export function IconMenu(props: IconProps): ReactElement {
  return (
    <Icon {...props}>
      <path d="M3 5h12M3 9h12M3 13h12" />
    </Icon>
  );
}

/** 主题切换 —— 月亮。 */
export function IconMoon(props: IconProps): ReactElement {
  return (
    <Icon {...props}>
      <path d="M14.5 11.5A6 6 0 0 1 6.5 3.5 6 6 0 1 0 14.5 11.5Z" />
    </Icon>
  );
}

/** 外链 —— 「在 X 查看」「阅读原文」。 */
export function IconExternal(props: IconProps): ReactElement {
  return (
    <Icon {...props}>
      <path d="M8 4H4v10h10v-4M10 4h4v4M14 4 8 10" />
    </Icon>
  );
}

/** 向右 —— CTA 的尾巴。 */
export function IconArrowRight(props: IconProps): ReactElement {
  return (
    <Icon {...props}>
      <path d="M3 9h12M11 5l4 4-4 4" />
    </Icon>
  );
}

/** 作者/来源角标（原型里 `source-badge` 用的那个「A」）。 */
export function IconAuthorMark(props: IconProps): ReactElement {
  return (
    <Icon {...props}>
      <path d="M3 14 7.5 3h3L15 14M5 10h8" />
    </Icon>
  );
}

/** 日历抽屉的两个翻页箭头。 */
export function IconChevronLeft(props: IconProps): ReactElement {
  return (
    <Icon {...props}>
      <path d="m11 4-5 5 5 5" />
    </Icon>
  );
}

export function IconChevronRight(props: IconProps): ReactElement {
  return (
    <Icon {...props}>
      <path d="m7 4 5 5-5 5" />
    </Icon>
  );
}

/** 日历。 */
export function IconCalendar(props: IconProps): ReactElement {
  return (
    <Icon {...props}>
      <>
        <rect height="11" rx="1.5" width="12" x="3" y="4.5" />
        <path d="M6 2.5v4M12 2.5v4M3 8h12" />
      </>
    </Icon>
  );
}

/* ------------------------------------------------------------------ */
/* 名字 → 元件                                                         */
/* ------------------------------------------------------------------ */

/**
 * 导航表用**名字**引用图标（`lib/nav.ts` 的 `IconName`），映射在这里。
 *
 * ⚠ 为什么必须有这层映射：导航表要穿过 Server → Client 边界
 *（服务端布局 → 客户端外壳），而**函数不能跨这条边界**。
 * 传元件本身会让构建直接失败。详见 `lib/nav.ts` 的说明。
 *
 * 类型是 `Record<IconName, …>`：漏一个键就是编译错，
 * 而不是运行时渲染出一个空白图标。
 */
export const ICONS: Record<
  | 'home'
  | 'star'
  | 'newspaper'
  | 'x'
  | 'people'
  | 'topic'
  | 'bookmark'
  | 'search'
  | 'settings'
  | 'calendar',
  (props: IconProps) => ReactElement
> = {
  home: IconHome,
  star: IconStar,
  newspaper: IconNewspaper,
  x: IconX,
  people: IconPeople,
  topic: IconTopic,
  bookmark: IconBookmark,
  search: IconSearch,
  settings: IconSettings,
  calendar: IconCalendar,
};
