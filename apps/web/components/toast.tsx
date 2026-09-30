'use client';

/**
 * Toast —— 原型的 `.toast` 元件（右下角一条短提示）。
 *
 * ⚠ 原型把 `#toast` 写死在**每一个页面**里，用 `window.__toast` 存定时器。
 * 那种写法在 Next 里会出两个问题：
 *
 * 1. 每个页面都要记得放一个 `<div id="toast">`，漏一个页面的提示就静默消失；
 * 2. 切换路由时组件重建，**上一次的定时器没人清** —— 1.1 秒后它会把
 *    新页面的提示提前清掉（「点了收藏，提示一闪而过」）。
 *
 * 所以这里做成 Provider + context：整个应用只有一个 toast，
 * 定时器挂在 provider 上并在卸载时清掉。
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';

/** 提示的停留时间。与原型一致（2200ms）。 */
export const TOAST_DURATION_MS = 2200;

type ToastContextValue = {
  show: (message: string) => void;
};

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: ReactNode }): ReactElement {
  const [message, setMessage] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const show = useCallback((next: string) => {
    setMessage(next);
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      setMessage(null);
      timer.current = null;
    }, TOAST_DURATION_MS);
  }, []);

  // 卸载时清掉 —— 否则路由切换后旧定时器会把新提示提前抹掉。
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );

  const value = useMemo(() => ({ show }), [show]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className={message === null ? 'toast' : 'toast show'} role="status" aria-live="polite">
        {message ?? ''}
      </div>
    </ToastContext.Provider>
  );
}

/** 取 toast。必须在 `ToastProvider` 里用。 */
export function useToast(): ToastContextValue {
  const value = useContext(ToastContext);
  if (value === null) throw new Error('useToast() 必须在 <ToastProvider> 内使用');
  return value;
}
