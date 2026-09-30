'use client';

/**
 * 登录状态与**登录抽屉**。
 *
 * ── 为什么是抽屉而不是一个 `/login` 页面（用户 2026-09-30 的决定）────
 * v1.7 原型里**没有任何登录界面**（它是静态 mock），而 `docs/11` 明说
 * V1 的登录用户能力就是收藏 / 阅读进度 / 阅读偏好同步 —— 三条 API 都要登录，
 * 后台更是整个都要。所以必须有一个入口，但原型里没有它的位置。
 *
 * 选择抽屉（而不是新开一页）有两个具体好处：
 * 1. **不打断阅读**。收藏是阅读中途的动作，跳到登录页再跳回来会丢掉滚动位置
 *    与「刚才想收藏哪一篇」的上下文。
 * 2. **视觉上已经有这个模式**：原型的日历面板就是一个 `.drawer`
 *    （见 `globals.css`），复用它不需要新造视觉语言。
 *
 * ── 只做邮箱验证码，**不接 GitHub**（用户 2026-09-30 的决定）─────────
 * 后端的 `GET /auth/github` 与回调**已经存在且照常工作**，只是界面不提供入口。
 * 所以这里一句 GitHub 的代码都没有；将来要加，只需在这个抽屉里补一个按钮 ——
 * 后端不用动。
 *
 * ── ⚠ 文案不能透露邮箱是否注册过 ────────────────────────────────────
 * 服务端 `POST /auth/email/request-code` 的响应恒为 `{sent:true}`
 *（防账号枚举）。界面**必须**跟着这条语义走：只能写
 * 「如果这个邮箱可用，验证码已经发出」。改成「已发送，请查收」就等于
 * 把「这个邮箱没注册」变成一个可观测的差异，把服务端刻意堵住的洞重新打开。
 */

import { useRouter } from 'next/navigation';
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
import {
  ApiClientError,
  fetchMe,
  fetchPreferences,
  logout as logoutRequest,
  requestEmailCode,
  verifyEmailCode,
} from '../lib/client-api';
import type { MeDto } from '../lib/types';
import { useTheme } from './theme';
import { useToast } from './toast';

type LoginStep = 'email' | 'code';

type AuthContextValue = {
  /** `null` = 未登录（或还在加载）。 */
  user: MeDto | null;
  /** 首次探测是否还在进行（用于避免「闪一下未登录」）。 */
  loading: boolean;
  /** 打开登录抽屉。 */
  openLogin: () => void;
  /** 登出。 */
  logout: () => Promise<void>;
  /** 重新拉一次 `/me`（登录后或改了资料后）。 */
  refresh: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }): ReactElement {
  const [user, setUser] = useState<MeDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const { hydrateFromPreferences } = useTheme();
  /**
   * ⚠ **登录/登出之后必须让当前路由重新取数。**
   *
   * 服务端组件是**带着当时的 Cookie** 渲染的（`lib/api.ts` 会转发它）。
   * 登录发生在客户端，服务端那份渲染结果不会自己变 —— 于是出现
   * 「点了登录、会话也真的建了，页面却还说『需要登录』」。
   *
   * 浏览器走查实测：`/admin/sources` 上登录成功后，h1 仍是「需要登录」，
   * 表格 0 行，直到手动刷新。`/bookmarks` 同理（会一直显示「登录后才能使用收藏」）。
   *
   * `router.refresh()` 让服务端以**新 Cookie** 重渲染当前路由。
   * 这正是「只有真的点一次才会发现」的那类缺陷 —— 会话确实建了（DB 里有行），
   * 接口确实通了，只是页面没跟着变。
   */
  const router = useRouter();

  const loadPreferences = useCallback(async () => {
    // 登录用户的服务端偏好覆盖本地值（`docs/11` 的「阅读偏好同步」）。
    // 失败不该阻断登录 —— 偏好是锦上添花。
    try {
      hydrateFromPreferences(await fetchPreferences());
    } catch {
      /* 忽略：未登录或偏好接口异常都不影响会话本身 */
    }
  }, [hydrateFromPreferences]);

  const refresh = useCallback(async () => {
    try {
      const me = await fetchMe();
      setUser(me);
      await loadPreferences();
    } catch (error) {
      // 401 是**正常路径**（游客），不是错误。
      if (error instanceof ApiClientError && error.isUnauthorized) {
        setUser(null);
      } else {
        setUser(null);
      }
    } finally {
      setLoading(false);
    }
  }, [loadPreferences]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const logout = useCallback(async () => {
    await logoutRequest().catch(() => undefined);
    setUser(null);
    // 同上：登出也要重渲染，否则当前页还留着「已登录」时的服务端结果。
    router.refresh();
  }, [router]);

  const openLogin = useCallback(() => setDrawerOpen(true), []);

  const value = useMemo(
    () => ({ user, loading, openLogin, logout, refresh }),
    [user, loading, openLogin, logout, refresh],
  );

  return (
    <AuthContext.Provider value={value}>
      {children}
      <LoginDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        onLoggedIn={async (me) => {
          setUser(me);
          setDrawerOpen(false);
          await loadPreferences();
          // ⚠ 顺序：先落状态再刷新路由（刷新会重渲染服务端组件）。
          router.refresh();
        }}
      />
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (value === null) throw new Error('useAuth() 必须在 <AuthProvider> 内使用');
  return value;
}

/* ------------------------------------------------------------------ */
/* 登录抽屉                                                            */
/* ------------------------------------------------------------------ */

const OTP_LENGTH = 6;

function LoginDrawer({
  open,
  onClose,
  onLoggedIn,
}: {
  open: boolean;
  onClose: () => void;
  onLoggedIn: (me: MeDto) => Promise<void>;
}): ReactElement {
  const toast = useToast();
  const [step, setStep] = useState<LoginStep>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 关掉时把状态清干净：下次打开不该看到上一次的验证码输入框。
  useEffect(() => {
    if (open) return;
    setStep('email');
    setCode('');
    setError(null);
    setBusy(false);
  }, [open]);

  async function sendCode(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await requestEmailCode(email.trim());
      setStep('code');
      // ⚠ 文案见文件头：不能透露邮箱是否注册过。
      toast.show('如果这个邮箱可用，验证码已经发出');
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(false);
    }
  }

  async function submitCode(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const session = await verifyEmailCode(email.trim(), code.trim());
      await onLoggedIn(session.user);
      toast.show('已登录');
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div
        className={open ? 'overlay show' : 'overlay'}
        onClick={onClose}
        role="presentation"
      />
      <aside
        className={open ? 'drawer open' : 'drawer'}
        aria-hidden={!open}
        aria-label="登录"
      >
        <div className="drawer-head">
          <h2 style={{ fontSize: '15px', margin: 0 }}>登录</h2>
          <button className="icon-btn" onClick={onClose} aria-label="关闭">
            ✕
          </button>
        </div>

        <div className="drawer-preview">
          <p>
            登录后可以收藏文章、同步阅读进度与阅读偏好。
            <br />
            没有订阅、没有关注 —— 登录只为了这三件事。
          </p>
        </div>

        <form
          onSubmit={(event) => {
            event.preventDefault();
            void (step === 'email' ? sendCode() : submitCode());
          }}
        >
          <label className="setting-row" style={{ display: 'block' }}>
            <h3>邮箱</h3>
            <input
              className="search-box"
              style={{ width: '100%' }}
              type="email"
              name="email"
              autoComplete="email"
              required
              value={email}
              disabled={step === 'code'}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="you@example.com"
            />
          </label>

          {step === 'code' ? (
            <label className="setting-row" style={{ display: 'block' }}>
              <h3>验证码</h3>
              <input
                className="search-box"
                style={{ width: '100%' }}
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern={`\\d{${String(OTP_LENGTH)}}`}
                maxLength={OTP_LENGTH}
                required
                value={code}
                onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))}
                placeholder="6 位数字"
              />
            </label>
          ) : null}

          {error === null ? null : (
            <p className="subtle" style={{ color: 'var(--text-2)' }} role="alert">
              {error}
            </p>
          )}

          <div className="end-actions" style={{ gap: '8px' }}>
            {step === 'code' ? (
              <button
                type="button"
                className="soft-btn"
                onClick={() => setStep('email')}
                disabled={busy}
              >
                换邮箱
              </button>
            ) : null}
            <button type="submit" className="primary-btn" disabled={busy}>
              {step === 'email' ? '发送验证码' : '登录'}
            </button>
          </div>
        </form>

        <p className="subtle" style={{ marginTop: '14px' }}>
          验证码 10 分钟内有效。我们不会保存你的密码 —— 这里没有密码。
        </p>
      </aside>
    </>
  );
}

/** 把异常翻译成给用户看的一句话。 */
function messageOf(error: unknown): string {
  if (error instanceof ApiClientError) {
    // 只把**业务码**翻成中文；服务端的 message 是英文的通用文案。
    switch (error.code) {
      case 'AUTH_OTP_INVALID':
        return '验证码不对，再试一次。';
      case 'AUTH_OTP_EXPIRED':
        return '验证码过期了，重新获取一个。';
      case 'AUTH_OTP_ALREADY_USED':
        return '这个验证码已经用过了，重新获取一个。';
      case 'RATE_LIMITED':
        return '请求太频繁了，稍等一下再试。';
      case 'VALIDATION_FAILED':
        return '邮箱格式看起来不对。';
      default:
        return '没能完成登录，请稍后再试。';
    }
  }
  return '没能完成登录，请稍后再试。';
}
