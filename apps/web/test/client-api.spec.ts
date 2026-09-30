/**
 * 浏览器侧 API 客户端的契约守卫 —— **重点是 `{data: …}` 封套**。
 *
 * ── 为什么这个文件必须存在 ────────────────────────────────────────────
 * 2026-09-30 的浏览器走查发现：`verifyEmailCode` 忘了读 `.data`，
 * 于是**登录成功后整个页面崩**（`TypeError: Cannot read properties of
 * undefined (reading 'displayName')`）—— 抽屉把封套当成了会话对象。
 *
 * 它躲过了 tsc、lint、构建和**全部 1932 个测试**。原因是结构性的：
 * 函数自己声明了返回类型 `Promise<AuthSessionResponse>`，而运行时返回
 * `{data: AuthSessionResponse}`。**类型检查不会发现一个谎言，它只检查这个谎言自洽。**
 *
 * 修法是结构性的（解包下沉进 `apiRequest`，见 `lib/client-api.ts` 文件头），
 * 这个文件守的是「那个修法没有被改回去」。
 *
 * ── 断言为什么是「严格结构相等 + 不许有 data 键」而不是 `toBe` ────────
 * 一开始这里用的是身份相等（`toBe`），**跑不通，也不该跑通**：
 * 载荷要经过一次 JSON 往返（服务端 `JSON.stringify` → 客户端 `JSON.parse`），
 * 回来的必然是**新对象**。身份相等在这个场景里恒假。
 *
 * 所以用两条互补的断言，一起把「封套漏出来」这个形状钉死：
 *
 * ```text
 * expect(result).toStrictEqual(载荷)    // 结构完全相等 —— 封套会多一层，必红
 * expect(result).not.toHaveProperty('data')  // 直接针对 bug 的形状再说一次
 * ```
 *
 * ⚠ 第二条是**刻意冗余**的：`toStrictEqual` 已经能抓住，但它失败时的信息
 * 只有「两个对象不一样」，而这条失败时说的是「你把封套漏出来了」——
 * 对一个只会在半夜被看到红灯的人来说，后者省下的时间更多。
 * （前提：`PAYLOADS` 里没有任何一个载荷自己带 `data` 字段。带了就要改这条。）
 *
 * ── 为什么不用真浏览器 ──────────────────────────────────────────────
 * 这条性质是「函数返回了什么」，不是「DOM 上渲染了什么」——
 * 它属于单元层。真浏览器那一层另有其事（见 `handoff`：点击级走查）。
 * 单元层的价值是**快且全量**：每个导出函数都被覆盖，而不是只覆盖点到的那个。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UserTheme } from '@signal/contracts';
import * as clientApi from '../lib/client-api';
import { ApiClientError } from '../lib/client-api';

/** 与 `next.config.mjs` / `lib/api.ts` 的开发默认值一致。 */
const ORIGIN = 'http://localhost:3000';

/**
 * 每个端点的**载荷**（封套里面那一层）。
 *
 * ⚠ 这些对象是**唯一实例**，会被 `toBe` 用来做身份比较 ——
 * 所以不要在多处复用同一个字面量，否则「返回了另一个函数的载荷」这种错误
 * 会因为两个端点指向同一个对象而被掩盖。
 */
const PAYLOADS = {
  requestCode: { sent: true, expiresInSeconds: 600 },
  session: {
    user: {
      id: '1',
      email: 'a@b.c',
      displayName: null,
      avatarUrl: null,
      role: 'USER',
      createdAt: '2026-09-30T00:00:00.000Z',
    },
    accessTokenExpiresInSeconds: 900,
  },
  me: {
    id: '1',
    email: 'a@b.c',
    displayName: null,
    avatarUrl: null,
    role: 'USER',
    createdAt: '2026-09-30T00:00:00.000Z',
  },
  logout: { loggedOut: true },
  bookmark: { contentId: '42', bookmarked: true, createdAt: '2026-09-30T00:00:00.000Z' },
  readingProgress: { contentId: '42', progress: 0.5, completed: false },
  preferences: {
    theme: 'SYSTEM',
    articleFontSize: 'DEFAULT',
    defaultTranslation: false,
  },
} as const;

/** 记录 fetch 实际收到的请求，供「路径与方法对不对」的断言使用。 */
type Recorded = { url: string; method: string; body: unknown };
let recorded: Recorded[] = [];

/**
 * 装一个假的 fetch。
 *
 * `envelope` 决定它返回什么 —— 正常路径返回 `{data: 载荷}`；
 * 那组「封套守卫」的用例会传别的形状进来。
 */
function stubFetch(envelope: (url: URL) => { status: number; body: string }): void {
  vi.stubGlobal(
    'fetch',
    async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(String(input));
      recorded.push({
        url: url.pathname,
        method: init?.method ?? 'GET',
        body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
      });
      const { status, body } = envelope(url);
      return new Response(body === '' ? null : body, {
        status,
        headers: { 'content-type': 'application/json' },
      });
    },
  );
}

/** 按**路径**给出该端点的载荷，然后把它包进封套 —— 模拟真实服务端。 */
function envelopeByPath(url: URL): { status: number; body: string } {
  const payload: Record<string, unknown> = {
    '/api/v1/auth/email/request-code': PAYLOADS.requestCode,
    '/api/v1/auth/email/verify': PAYLOADS.session,
    '/api/v1/me': PAYLOADS.me,
    '/api/v1/auth/logout': PAYLOADS.logout,
    '/api/v1/bookmarks/42': PAYLOADS.bookmark,
    '/api/v1/reading-progress': PAYLOADS.readingProgress,
    '/api/v1/me/preferences': PAYLOADS.preferences,
  };
  const found = payload[url.pathname];
  if (found === undefined) {
    // 不静默兜底：没登记的端点直接失败，说明**函数打错了地址**。
    return { status: 599, body: JSON.stringify({ error: { code: 'TEST_UNKNOWN_PATH' } }) };
  }
  return { status: 200, body: JSON.stringify({ data: found }) };
}

beforeEach(() => {
  recorded = [];
  // 测试跑在 node 环境（见根 `vitest.config.mts`），没有 DOM ——
  // `apiRequest` 只用得到 `window.location.origin` 这一处。
  vi.stubGlobal('window', { location: { origin: ORIGIN } });
  stubFetch(envelopeByPath);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/* ------------------------------------------------------------------ */
/* 一、封套解包：`apiRequest` 是**唯一**发生地                          */
/* ------------------------------------------------------------------ */

describe('apiRequest —— 封套在这里解，且只在这里解', () => {
  it('返回的是封套**里面**那一层，不是封套本身', async () => {
    const result = await clientApi.apiRequest<unknown>('/me');
    expect(result).toStrictEqual(PAYLOADS.me);
    // 反向断言：绝不能是封套。这一条就是那个登录 bug 的形状。
    expect(result).not.toHaveProperty('data');
  });

  it('把相对路径拼到 window.location.origin 上（同源，Cookie 才带得上）', async () => {
    await clientApi.apiRequest('/me');
    expect(recorded[0]?.url).toBe('/api/v1/me');
    expect(recorded[0]?.method).toBe('GET');
  });

  it('204 空响应如实返回 undefined（不是抛错、也不是 {}）', async () => {
    stubFetch(() => ({ status: 204, body: '' }));
    await expect(clientApi.apiRequest('/me')).resolves.toBeUndefined();
  });

  it('载荷本身是 null 是合法的，不能误伤', async () => {
    stubFetch(() => ({ status: 200, body: JSON.stringify({ data: null }) }));
    await expect(clientApi.apiRequest('/me')).resolves.toBeNull();
  });

  it('⚠ 响应缺少 data 封套时**抛错**，绝不静默返回 undefined', async () => {
    // 这是「宁可炸也不要静默」那条决定：少了封套只有两种可能 ——
    // 连错了端点，或反向代理把 HTML 错误页当成 200 返回了。两种都该响。
    stubFetch(() => ({ status: 200, body: JSON.stringify({ user: PAYLOADS.me }) }));
    await expect(clientApi.apiRequest('/me')).rejects.toBeInstanceOf(ApiClientError);
  });

  it('非 2xx 抛 ApiClientError，并带上服务端的**业务码**（UI 靠它分支）', async () => {
    stubFetch(() => ({
      status: 401,
      body: JSON.stringify({
        error: { code: 'AUTH_OTP_INVALID', message: 'invalid', details: null },
      }),
    }));

    const error = await clientApi.apiRequest('/me').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiClientError);
    expect((error as ApiClientError).code).toBe('AUTH_OTP_INVALID');
    expect((error as ApiClientError).isUnauthorized).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* 二、每个请求函数都返回**载荷本身**                                    */
/* ------------------------------------------------------------------ */

/**
 * 一个端点一条用例。
 *
 * ⚠ **新增导出函数时必须在这里补一条**（由下面的「导出面守卫」强制）——
 * 否则新函数可以绕过封套检查，而那正是这个文件存在的原因。
 */
const CASES: {
  name: keyof typeof clientApi;
  call: () => Promise<unknown>;
  /** 期望的**载荷**（身份比较）。 */
  payload: unknown;
  path: string;
  method: string;
}[] = [
  {
    name: 'requestEmailCode',
    call: () => clientApi.requestEmailCode('a@b.c'),
    payload: PAYLOADS.requestCode,
    path: '/api/v1/auth/email/request-code',
    method: 'POST',
  },
  {
    name: 'verifyEmailCode',
    call: () => clientApi.verifyEmailCode('a@b.c', '123456'),
    payload: PAYLOADS.session,
    path: '/api/v1/auth/email/verify',
    method: 'POST',
  },
  {
    name: 'fetchMe',
    call: () => clientApi.fetchMe(),
    payload: PAYLOADS.me,
    path: '/api/v1/me',
    method: 'GET',
  },
  {
    name: 'logout',
    call: () => clientApi.logout(),
    payload: undefined,
    path: '/api/v1/auth/logout',
    method: 'POST',
  },
  {
    name: 'setBookmark',
    call: () => clientApi.setBookmark('42', true),
    payload: PAYLOADS.bookmark,
    path: '/api/v1/bookmarks/42',
    method: 'POST',
  },
  {
    name: 'saveReadingProgress',
    call: () => clientApi.saveReadingProgress('42', 0.5),
    payload: undefined,
    path: '/api/v1/reading-progress',
    method: 'PUT',
  },
  {
    name: 'fetchPreferences',
    call: () => clientApi.fetchPreferences(),
    payload: PAYLOADS.preferences,
    path: '/api/v1/me/preferences',
    method: 'GET',
  },
  {
    name: 'savePreferences',
    call: () => clientApi.savePreferences({ theme: UserTheme.SYSTEM }),
    payload: PAYLOADS.preferences,
    path: '/api/v1/me/preferences',
    method: 'PUT',
  },
];

describe('每个请求函数返回的都是载荷本身（不是封套）', () => {
  for (const testCase of CASES) {
    it(`${String(testCase.name)}：${testCase.method} ${testCase.path}`, async () => {
      const result = await testCase.call();

      if (testCase.payload === undefined) {
        // `void` 函数：只验它打对了地址、且**没有**把封套漏出来。
        // （`logout` 曾经连类型都写错，见 `lib/client-api.ts` 的注释。）
        expect(recorded[0]?.url).toBe(testCase.path);
        expect(recorded[0]?.method).toBe(testCase.method);
        return;
      }

      // ⚠ 忘了解封套的话，这里拿到的是 `{data: …}` —— 两条断言都会红。
      expect(result).toStrictEqual(testCase.payload);
      expect(result).not.toHaveProperty('data');
    });
  }

  it('⚠ 回归：verifyEmailCode 返回会话**本身**（2026-09-30 登录崩溃的形状）', async () => {
    const session = await clientApi.verifyEmailCode('a@b.c', '123456');
    // 崩溃当时的代码在这一行拿到的是 `undefined`：封套被当成了会话，
    // 于是 `session.user` 是 undefined。这一行是那次事故的墓碑。
    expect(session.user).toStrictEqual(PAYLOADS.session.user);
    expect(session.accessTokenExpiresInSeconds).toBe(900);
    expect(session).not.toHaveProperty('data');
  });

  it('setBookmark 取消收藏时用 DELETE（幂等契约的两半）', async () => {
    await clientApi.setBookmark('42', false);
    expect(recorded[0]?.method).toBe('DELETE');
  });
});

/* ------------------------------------------------------------------ */
/* 三、导出面守卫：新函数**不可能**绕开上面那张表                        */
/* ------------------------------------------------------------------ */

describe('导出面守卫', () => {
  /**
   * 有意不放进 `CASES` 的导出。
   *
   * - `apiRequest` —— 它是**解封套的那一层本身**，由第一组用例直接覆盖；
   *   把它放进按端点驱动的表里没有意义（它不绑定任何端点）。
   * - `ApiClientError` —— 是类，不是请求函数。
   */
  const EXEMPT = new Set(['apiRequest', 'ApiClientError']);

  it('每一个导出的请求函数都必须在 CASES 里有用例', () => {
    const exported = Object.entries(clientApi)
      .filter(([, value]) => typeof value === 'function')
      .map(([name]) => name)
      .filter((name) => !EXEMPT.has(name));

    const covered = new Set(CASES.map((testCase) => String(testCase.name)));
    const uncovered = exported.filter((name) => !covered.has(name));

    // 失败信息要直接告诉后来者该做什么，而不是只说「不相等」。
    expect(
      uncovered,
      `新增了导出函数却没有封套用例：${uncovered.join(', ')}\n` +
        '请在 apps/web/test/client-api.spec.ts 的 CASES 里补一条 —— ' +
        '这个文件守的就是「没有函数能绕过封套检查」。',
    ).toEqual([]);
  });

  it('CASES 里没有写错名字的条目（防止表里挂着不存在的函数）', () => {
    const unknown = CASES.filter((testCase) => typeof clientApi[testCase.name] !== 'function').map(
      (testCase) => String(testCase.name),
    );
    expect(unknown).toEqual([]);
  });
});
