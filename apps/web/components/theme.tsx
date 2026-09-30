'use client';

/**
 * 主题与正文字号。
 *
 * ── 三处必须一致，否则会闪 ──────────────────────────────────────────
 * 主题是**用户偏好**，不能在服务端知道（`SYSTEM` 还要看设备的
 * `prefers-color-scheme`）。所以：
 *
 * ```text
 * 1. layout.tsx 服务端渲染 <body>                    默认 light（不写 data-theme）
 * 2. layout.tsx 里那段内联脚本，在**绘制之前**        localStorage 有值就立刻套上
 * 3. 本组件（水合之后）                                接管后续切换，并在登录时同步到服务端
 * ```
 *
 * 少了第 2 步就会出现「深色用户每次刷新都先白闪一下」——
 * 而那是纯体验问题，**任何测试都不会红**。所以那两步在
 * `layout.tsx` 里挨着写、并且 `visual-contract.spec.ts` 有一条守卫
 * 确认那段内联脚本还在。
 *
 * ── ⚠ 主题有三档，不是原型里的两档 ──────────────────────────────────
 * 原型的设置页只有「浅色 / 深色」两个按钮，但 `docs/11` 定义的是
 * `LIGHT / DARK / **SYSTEM**`。若只做两档，`SYSTEM` 这个取值在界面上
 * **永远无法被选中** —— 那和「契约里有、但没有入口」是同一类缺陷。
 * 所以这里给三档，默认 `LIGHT`（原型：浅色是产品默认视觉）。
 * 已记入 `CONTRACT_CHANGE_REQUEST-agent-13.md`。
 *
 * 存储键沿用原型的 `signal.theme` / `signal.fontSize`：
 * 同一个浏览器的两种前端（v1.7 静态原型与本应用）因此读同一份偏好，
 * 对照检查时不会互相覆盖。
 */

import { ArticleFontSize, UserTheme } from '@signal/contracts';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import type { UserPreferences } from '../lib/types';

export const THEME_STORAGE_KEY = 'signal.theme';
export const FONT_SIZE_STORAGE_KEY = 'signal.fontSize';

/** 字号 → CSS 变量的取值。与原型的 `applyFontSize` 逐字一致。 */
export const FONT_SIZE_PX: Record<ArticleFontSize, string> = {
  [ArticleFontSize.SMALL]: '16px',
  [ArticleFontSize.DEFAULT]: '17px',
  [ArticleFontSize.LARGE]: '19px',
};

/** 实际渲染出来的两档（`SYSTEM` 会被解析成其中之一）。 */
export type ResolvedTheme = 'light' | 'dark';

type ThemeContextValue = {
  /** 用户选的那一档（可能是 `SYSTEM`）。 */
  theme: UserTheme;
  /** 实际生效的那一档。 */
  resolved: ResolvedTheme;
  fontSize: ArticleFontSize;
  setTheme: (theme: UserTheme) => void;
  setFontSize: (size: ArticleFontSize) => void;
  /** 登录后把服务端偏好灌进来（不写 localStorage 之外的东西）。 */
  hydrateFromPreferences: (preferences: UserPreferences) => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

/** 把 `SYSTEM` 解析成当前设备的实际主题。 */
export function resolveTheme(theme: UserTheme, prefersDark: boolean): ResolvedTheme {
  if (theme === UserTheme.DARK) return 'dark';
  if (theme === UserTheme.LIGHT) return 'light';
  return prefersDark ? 'dark' : 'light';
}

function readStoredTheme(): UserTheme {
  if (typeof window === 'undefined') return UserTheme.LIGHT;
  const raw = window.localStorage.getItem(THEME_STORAGE_KEY);
  return raw === UserTheme.DARK || raw === UserTheme.SYSTEM ? raw : UserTheme.LIGHT;
}

function readStoredFontSize(): ArticleFontSize {
  if (typeof window === 'undefined') return ArticleFontSize.DEFAULT;
  const raw = window.localStorage.getItem(FONT_SIZE_STORAGE_KEY);
  return raw === ArticleFontSize.SMALL || raw === ArticleFontSize.LARGE
    ? raw
    : ArticleFontSize.DEFAULT;
}

export function ThemeProvider({ children }: { children: ReactNode }): ReactElement {
  // ⚠ 初值**必须**与服务端渲染的一致（都是 LIGHT / DEFAULT），否则水合不匹配。
  // 真实值在下面的 useEffect 里读 —— 但那段内联脚本已经先把视觉套好了，
  // 所以这一帧不会闪。
  const [theme, setThemeState] = useState<UserTheme>(UserTheme.LIGHT);
  const [fontSize, setFontSizeState] = useState<ArticleFontSize>(ArticleFontSize.DEFAULT);
  const [prefersDark, setPrefersDark] = useState(false);

  useEffect(() => {
    setThemeState(readStoredTheme());
    setFontSizeState(readStoredFontSize());

    const query = window.matchMedia('(prefers-color-scheme: dark)');
    setPrefersDark(query.matches);
    const onChange = (event: MediaQueryListEvent): void => setPrefersDark(event.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  const resolved = resolveTheme(theme, prefersDark);

  // 属性挂在 <body> 上 —— 移植过来的 CSS 选择器就是 `body[data-theme="dark"]`
  //（见 globals.css 的设计令牌段）。挂在 <html> 上会让深色主题**完全失效**。
  useEffect(() => {
    document.body.dataset['theme'] = resolved;
  }, [resolved]);

  useEffect(() => {
    document.documentElement.style.setProperty('--article-size', FONT_SIZE_PX[fontSize]);
  }, [fontSize]);

  const setTheme = useCallback((next: UserTheme) => {
    setThemeState(next);
    window.localStorage.setItem(THEME_STORAGE_KEY, next);
  }, []);

  const setFontSize = useCallback((next: ArticleFontSize) => {
    setFontSizeState(next);
    window.localStorage.setItem(FONT_SIZE_STORAGE_KEY, next);
  }, []);

  const hydrateFromPreferences = useCallback((preferences: UserPreferences) => {
    setThemeState(preferences.theme);
    setFontSizeState(preferences.articleFontSize);
    window.localStorage.setItem(THEME_STORAGE_KEY, preferences.theme);
    window.localStorage.setItem(FONT_SIZE_STORAGE_KEY, preferences.articleFontSize);
  }, []);

  const value = useMemo(
    () => ({ theme, resolved, fontSize, setTheme, setFontSize, hydrateFromPreferences }),
    [theme, resolved, fontSize, setTheme, setFontSize, hydrateFromPreferences],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (value === null) throw new Error('useTheme() 必须在 <ThemeProvider> 内使用');
  return value;
}

/**
 * 在**绘制之前**把偏好套上去的那段脚本。
 *
 * 必须是内联同步脚本：任何异步加载（包括 `next/script` 的
 * `afterInteractive`）都要等水合，那时页面已经用默认主题画过一帧了。
 *
 * 不读服务端偏好：匿名用户本来就没有；登录用户的服务端值由
 * `hydrateFromPreferences()` 在拿到 `/me/preferences` 之后覆盖 ——
 * 那会带来一次「本地 → 服务端」的可见跳变，属于已知取舍（见 HANDOFF）。
 */
export const THEME_BOOTSTRAP_SCRIPT = `(function(){try{
var t=localStorage.getItem('${THEME_STORAGE_KEY}');
var d=t==='DARK'||(t!=='LIGHT'&&window.matchMedia('(prefers-color-scheme: dark)').matches);
document.body.dataset.theme=d?'dark':'light';
var f=localStorage.getItem('${FONT_SIZE_STORAGE_KEY}');
var px={'SMALL':'16px','DEFAULT':'17px','LARGE':'19px'}[f]||'17px';
document.documentElement.style.setProperty('--article-size',px);
}catch(e){}})();`;
