'use client';

/**
 * 设置页的三个分组 + 账户区。
 *
 * ── 偏好写到哪里（原型与 `docs/11` 的交集）──────────────────────────
 *
 * ```text
 * 匿名访客   只写 localStorage —— 立刻生效、刷新保留
 * 登录用户   写 localStorage **并且** PUT /me/preferences
 * ```
 *
 * 原型说「保存在当前浏览器」，`docs/11` 说登录用户的「阅读偏好**同步**」。
 * 两者都要满足，所以是「本地立即生效 + 登录时上报」：
 * 先在本地改（界面不会等网络），再尽力上报 —— **上报失败不回滚本地**，
 * 因为用户的意图是「我要深色」，而不是「我要把深色存进服务器」。
 *
 * ── ⚠ 「记录阅读位置」「显示普通转发」这些开关存在哪 ──────────────────
 * `docs/11` 的 `user_preferences` 只有三个字段：`theme` /
 * `articleFontSize` / `defaultTranslation`。另外两个开关
 *（`trackReadingProgress`、X 的两个显示开关）**不在契约里**，
 * 所以它们只写 localStorage，并如实标注「本机」——
 * 假装它们会同步是更糟的选择（用户换设备后会以为设置丢了）。
 */

import { useEffect, useState, type ReactElement } from 'react';
import { ArticleFontSize, UserTheme } from '@signal/contracts';
import { ApiClientError, savePreferences } from '../lib/client-api';
import { useAuth } from './auth';
import { useTheme } from './theme';
import { useToast } from './toast';

/** 只存在本机的开关（不在 `user_preferences` 里）。 */
const LOCAL_SWITCHES = [
  { key: 'signal.switch.trackReadingProgress', label: '记录阅读位置', hint: '重新打开文章时继续上次位置。' },
  { key: 'signal.switch.xQuote', label: '显示 Quote Post', hint: '保留有上下文价值的引用动态。' },
  { key: 'signal.switch.xRepost', label: '显示普通转发', hint: '默认建议关闭，减少重复内容。' },
] as const;

export function SettingsView(): ReactElement {
  const { theme, fontSize, setTheme, setFontSize } = useTheme();
  const { user, openLogin, logout } = useAuth();
  const toast = useToast();
  const [translateByDefault, setTranslateByDefault] = useState(false);
  const [switchState, setSwitchState] = useState<Record<string, boolean>>({});

  useEffect(() => {
    setSwitchState(
      Object.fromEntries(
        LOCAL_SWITCHES.map((item) => [
          item.key,
          window.localStorage.getItem(item.key) === 'true',
        ]),
      ),
    );
  }, []);

  /**
   * 本地立即生效 + 尽力上报。
   *
   * ⚠ 上报失败**不提示失败**，也不回滚。理由见文件头：
   * 用户要的是「开关现在生效」，而不是「存进服务器」。
   * 但登录用户的同步失败也不该完全无声 —— 只在控制台留一条，
   * 不打断操作（这是「锦上添花」类失败）。
   */
  async function persist(patch: {
    theme?: UserTheme;
    articleFontSize?: ArticleFontSize;
    defaultTranslation?: boolean;
  }): Promise<void> {
    if (user === null) return;
    try {
      await savePreferences(patch);
    } catch (error) {
      if (error instanceof ApiClientError && error.isUnauthorized) return; // 会话过期
      // 同步失败只做诊断，不打断用户（本地已经生效）。
      console.warn('[settings] 偏好同步失败（本地已生效）', error);
    }
  }

  function chooseTheme(next: UserTheme): void {
    setTheme(next);
    void persist({ theme: next });
  }

  function chooseFontSize(next: ArticleFontSize): void {
    setFontSize(next);
    void persist({ articleFontSize: next });
  }

  function toggleLocal(key: string): void {
    const next = !(switchState[key] ?? false);
    setSwitchState((current) => ({ ...current, [key]: next }));
    window.localStorage.setItem(key, String(next));
    toast.show('设置已保存');
  }

  return (
    <>
      <section className="settings-group">
        <h2>阅读</h2>
        <div className="setting-row">
          <div>
            <h3>正文大小</h3>
            <p>只影响长文章正文，不改变导航与信息流。</p>
          </div>
          <div className="choice-group">
            <button
              type="button"
              className={fontSize === ArticleFontSize.SMALL ? 'choice active' : 'choice'}
              onClick={() => chooseFontSize(ArticleFontSize.SMALL)}
            >
              小
            </button>
            <button
              type="button"
              className={fontSize === ArticleFontSize.DEFAULT ? 'choice active' : 'choice'}
              onClick={() => chooseFontSize(ArticleFontSize.DEFAULT)}
            >
              默认
            </button>
            <button
              type="button"
              className={fontSize === ArticleFontSize.LARGE ? 'choice active' : 'choice'}
              onClick={() => chooseFontSize(ArticleFontSize.LARGE)}
            >
              大
            </button>
          </div>
        </div>
        <LocalSwitch
          item={LOCAL_SWITCHES[0]}
          on={switchState[LOCAL_SWITCHES[0].key] ?? false}
          onToggle={() => toggleLocal(LOCAL_SWITCHES[0].key)}
        />
      </section>

      <section className="settings-group">
        <h2>翻译</h2>
        <div className="setting-row">
          <div>
            <h3>英文内容自动显示中文翻译</h3>
            <p>X 页面默认仍优先展示原文。</p>
          </div>
          <button
            type="button"
            className={translateByDefault ? 'switch on' : 'switch'}
            aria-pressed={translateByDefault}
            onClick={() => {
              const next = !translateByDefault;
              setTranslateByDefault(next);
              void persist({ defaultTranslation: next });
            }}
          />
        </div>
      </section>

      <section className="settings-group">
        <h2>外观</h2>
        <div className="setting-row">
          <div>
            <h3>主题</h3>
            <p>浅色是产品默认视觉；也可以跟随系统。</p>
          </div>
          <div className="choice-group">
            <button
              type="button"
              className={theme === UserTheme.LIGHT ? 'choice active' : 'choice'}
              onClick={() => chooseTheme(UserTheme.LIGHT)}
            >
              浅色
            </button>
            <button
              type="button"
              className={theme === UserTheme.DARK ? 'choice active' : 'choice'}
              onClick={() => chooseTheme(UserTheme.DARK)}
            >
              深色
            </button>
            <button
              type="button"
              className={theme === UserTheme.SYSTEM ? 'choice active' : 'choice'}
              onClick={() => chooseTheme(UserTheme.SYSTEM)}
            >
              跟随系统
            </button>
          </div>
        </div>
      </section>

      <section className="settings-group">
        <h2>X 动态</h2>
        <LocalSwitch
          item={LOCAL_SWITCHES[1]}
          on={switchState[LOCAL_SWITCHES[1].key] ?? false}
          onToggle={() => toggleLocal(LOCAL_SWITCHES[1].key)}
        />
        <LocalSwitch
          item={LOCAL_SWITCHES[2]}
          on={switchState[LOCAL_SWITCHES[2].key] ?? false}
          onToggle={() => toggleLocal(LOCAL_SWITCHES[2].key)}
        />
      </section>

      <section className="settings-group">
        <h2>账户</h2>
        {user === null ? (
          <div className="setting-row">
            <div>
              <h3>还没有登录</h3>
              <p>登录后可以收藏、同步阅读进度与阅读偏好。没有订阅、没有关注。</p>
            </div>
            <button type="button" className="primary-btn" onClick={openLogin}>
              登录
            </button>
          </div>
        ) : (
          <>
            <div className="setting-row">
              <div>
                <h3>已登录</h3>
                <p>{user.email ?? user.displayName ?? user.id}</p>
              </div>
              <button
                type="button"
                className="soft-btn"
                onClick={() => {
                  void logout().then(() => toast.show('已登出'));
                }}
              >
                登出
              </button>
            </div>
            <div className="setting-row">
              <div>
                <h3>偏好同步</h3>
                <p>主题、字号与翻译开关会保存到账号，换设备也在。</p>
              </div>
              <span className="badge">{user.role}</span>
            </div>
          </>
        )}
      </section>

      {/*
       * ⚠ v1.7 **删掉了「我的订阅」**（docs/23）。这一条提示是给
       * 「我以为设置里有订阅」的人看的 —— 没有这一句，用户会在设置页
       * 翻找订阅开关。它只说「没有」，不含任何可点的订阅入口，
       * 所以不构成 `docs/17` 第 19 条禁止的那种 UI。
       */}
      <p className="subtle">
        这里没有订阅与关注 —— v1.7 起 Signal 不提供人物、主题、来源订阅。
        人物与主题只用于浏览和导航。
      </p>
    </>
  );
}

function LocalSwitch({
  item,
  on,
  onToggle,
}: {
  item: { key: string; label: string; hint: string };
  on: boolean;
  onToggle: () => void;
}): ReactElement {
  return (
    <div className="setting-row">
      <div>
        <h3>{item.label}</h3>
        <p>
          {item.hint} <span className="subtle">（本机）</span>
        </p>
      </div>
      <button
        type="button"
        className={on ? 'switch on' : 'switch'}
        aria-pressed={on}
        aria-label={item.label}
        onClick={onToggle}
      />
    </div>
  );
}
