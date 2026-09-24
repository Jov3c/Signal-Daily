/**
 * Admin Source Registry 的 HTTP 契约测试。
 *
 * 走的是**真实链路**：真实 HTTP → 真实 `AdminGuard` → 真实 JWT 校验
 * → 真实会话查询 → 控制器 → 真实错误过滤器。只有 MySQL / Redis / 网络是替身。
 *
 * 这么做是为了避免「假绿」：如果守卫被替换掉，401/403 的用例就变成了
 * 在测一个自己写的假对象；而 Agent 02 的审查已经证明，那种用例改坏实现
 * 也不会变红。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { UserRole } from '@signal/contracts';
import {
  TEST_ADMIN_EMAIL,
  TEST_USER_EMAIL,
  createSourcesTestApp,
  type SourcesTestApp,
} from './support/sources-test-app';
import { registeredRoutes } from './support/test-app';
import { InMemorySourceRepository } from './support/source-fakes';

/** 契约里的 8 条路由。多一条、少一条都必须让测试变红。 */
const CONTRACT_ROUTES = [
  'GET /api/v1/admin/sources',
  'GET /api/v1/admin/sources/:id',
  'PATCH /api/v1/admin/sources/:id',
  'POST /api/v1/admin/sources',
  'POST /api/v1/admin/sources/:id/disable',
  'POST /api/v1/admin/sources/:id/enable',
  'POST /api/v1/admin/sources/:id/fetch-now',
  'POST /api/v1/admin/sources/:id/test',
].sort();

/**
 * 唯一 slug 生成器。
 *
 * ⚠ 必须用计数器而不是 `Math.random()`：随机值里的小数点会落进 slug，
 * 被 slug 格式校验先拦下 —— 于是「断言 URL 被拒」的用例会因为**另一个原因**
 * 变绿，看起来通过、实际什么都没验证到。第一次跑就踩到了这个坑。
 */
let slugCounter = 0;
function nextSlug(prefix: string): string {
  slugCounter += 1;
  return `${prefix}-${slugCounter}`;
}

const RSS_BODY = {
  name: 'Anthropic News',
  slug: 'anthropic-news',
  type: 'RSS',
  kind: 'OFFICIAL',
  tier: 'S',
  official: true,
  baseUrl: 'https://www.anthropic.com/news',
  feedUrl: 'https://www.anthropic.com/news/rss.xml',
  language: 'en',
  priority: 95,
  trustScore: 9.5,
  fetchIntervalSeconds: 1800,
};

/** `docs/04-api-contract.md` 里给出的 X 白名单示例，逐字照抄。 */
const X_BODY = {
  name: 'Andrej Karpathy',
  slug: 'x-karpathy',
  type: 'X_USER',
  kind: 'PERSON',
  tier: 'A',
  official: false,
  externalId: 'karpathy',
  priority: 90,
  trustScore: 9.0,
  fetchIntervalSeconds: 900,
  config: { handle: 'karpathy', includeQuotes: true, includeReplies: false },
};

describe('Admin Source Registry —— 路由面与鉴权', () => {
  let app: SourcesTestApp;
  let cookie: string;

  beforeEach(async () => {
    app = await createSourcesTestApp();
    cookie = await app.login(TEST_ADMIN_EMAIL, UserRole.ADMIN);
  });

  it('挂载的路由精确等于契约的 8 条（多一条即红）', () => {
    const mounted = registeredRoutes(app.app).filter((route) =>
      route.includes('/api/v1/admin/sources'),
    );
    expect(mounted).toEqual(CONTRACT_ROUTES);
  });

  it('不存在任何订阅类端点（规则 §13）', () => {
    const routes = registeredRoutes(app.app);
    expect(routes.filter((route) => /subscri/i.test(route))).toEqual([]);
  });

  it('未认证 → 401 UNAUTHORIZED', async () => {
    const response = await app.request('/api/v1/admin/sources');
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('UNAUTHORIZED');
  });

  it('已认证但非 ADMIN → 403 FORBIDDEN（不是 401）', async () => {
    const userCookie = await app.login(TEST_USER_EMAIL, UserRole.USER);
    const response = await app.request('/api/v1/admin/sources', { cookie: userCookie });
    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('FORBIDDEN');
  });

  it('授权按**库里的当前角色**判：同一 token 升权后立即可用，撤权后立即失效', async () => {
    const userCookie = await app.login(TEST_USER_EMAIL, UserRole.USER);
    const before = await app.request('/api/v1/admin/sources', { cookie: userCookie });
    expect(before.status).toBe(403);

    // 只改库里的行，不动 token —— 这正是「撤权立刻生效」要验证的语义。
    const user = await app.userRepository.findByEmail(TEST_USER_EMAIL);
    expect(user).not.toBeNull();
    app.setRole(user?.id ?? '', UserRole.ADMIN);

    const promoted = await app.request('/api/v1/admin/sources', { cookie: userCookie });
    expect(promoted.status).toBe(200);

    app.setRole(user?.id ?? '', UserRole.USER);
    const demoted = await app.request('/api/v1/admin/sources', { cookie: userCookie });
    expect(demoted.status).toBe(403);
  });

  it('错误响应是统一封套，且带 requestId', async () => {
    const response = await app.request('/api/v1/admin/sources/999999', { cookie });
    expect(response.status).toBe(404);
    const body = (await response.json()) as {
      error: { code: string; message: string; requestId: string; details: unknown };
    };
    expect(body.error.code).toBe('SOURCE_NOT_FOUND');
    expect(typeof body.error.requestId).toBe('string');
    expect(response.headers.get('x-request-id')).toBe(body.error.requestId);
  });
});

describe('Admin Source Registry —— CRUD', () => {
  let app: SourcesTestApp;
  let cookie: string;

  beforeEach(async () => {
    app = await createSourcesTestApp();
    cookie = await app.login(TEST_ADMIN_EMAIL, UserRole.ADMIN);
  });

  async function create(body: unknown): Promise<Response> {
    return app.request('/api/v1/admin/sources', {
      method: 'POST',
      cookie,
      body: JSON.stringify(body),
    });
  }

  it('新建 RSS → 201 + {data}，id 是 string（BIGINT 序列化）', async () => {
    const response = await create(RSS_BODY);
    expect(response.status).toBe(201);
    const body = (await response.json()) as { data: Record<string, unknown> };
    expect(typeof body.data.id).toBe('string');
    expect(body.data.slug).toBe('anthropic-news');
    expect(body.data.type).toBe('RSS');
    expect(body.data.tier).toBe('S');
    expect(body.data.official).toBe(true);
    expect(body.data.feedUrl).toBe('https://www.anthropic.com/news/rss.xml');
    // 新建即到期：docs/06「新增账号后自动进入下一调度周期」。
    expect(body.data.nextFetchAt).toBe(app.clock.now().toISOString());
  });

  it('新建 X 白名单 → externalId 归一化成 handle，config 保留类型专属键', async () => {
    const response = await create(X_BODY);
    expect(response.status).toBe(201);
    const body = (await response.json()) as { data: Record<string, unknown> };
    expect(body.data.externalId).toBe('karpathy');
    expect(body.data.config).toMatchObject({
      handle: 'karpathy',
      includeQuotes: true,
      includeReplies: false,
      // 未显式给出的键按 docs/06 的默认值落库（默认排除纯 Repost）。
      includeReposts: false,
    });
  });

  it('重复 slug → 409 SOURCE_DUPLICATE_SLUG', async () => {
    await create(RSS_BODY);
    const again = await create({ ...RSS_BODY, name: '另一个名字' });
    expect(again.status).toBe(409);
    const body = (await again.json()) as { error: { code: string } };
    expect(body.error.code).toBe('SOURCE_DUPLICATE_SLUG');
  });

  it.each([
    ['非法的 tier', { ...RSS_BODY, tier: 'Z' }],
    ['非法的 kind', { ...RSS_BODY, kind: 'BLOG' }],
    ['非法的 type', { ...RSS_BODY, type: 'TWITTER' }],
    ['缺 name', { ...RSS_BODY, name: undefined }],
    ['缺 slug', { ...RSS_BODY, slug: undefined }],
    ['slug 形状非法', { ...RSS_BODY, slug: 'Not A Slug' }],
    ['priority 超范围', { ...RSS_BODY, priority: 500 }],
    ['trustScore 两位小数（列是 DECIMAL(4,1)）', { ...RSS_BODY, trustScore: 9.55 }],
    ['fetchIntervalSeconds 过短', { ...RSS_BODY, fetchIntervalSeconds: 5 }],
  ])('%s → 400 VALIDATION_FAILED', async (_label, body) => {
    const response = await create(body);
    expect(response.status).toBe(400);
    const parsed = (await response.json()) as { error: { code: string; details: unknown } };
    expect(parsed.error.code).toBe('VALIDATION_FAILED');
  });

  it('详情：畸形 id 是 404 而不是 500（BIGINT 转换不抛异常）', async () => {
    const response = await app.request('/api/v1/admin/sources/not-a-number', { cookie });
    expect(response.status).toBe(404);
  });

  it('列表：分页元数据与过滤参数', async () => {
    await create(RSS_BODY);
    await create(X_BODY);
    await create({
      ...X_BODY,
      slug: 'x-simonw',
      name: 'Simon Willison',
      externalId: 'simonw',
      config: { handle: 'simonw' },
    });

    const all = await app.request('/api/v1/admin/sources?page=1&pageSize=2', { cookie });
    expect(all.status).toBe(200);
    const allBody = (await all.json()) as {
      data: unknown[];
      meta: { page: number; pageSize: number; total: number; totalPages: number };
    };
    expect(allBody.data).toHaveLength(2);
    expect(allBody.meta).toMatchObject({ page: 1, pageSize: 2, total: 3, totalPages: 2 });

    // docs/09 要求的「X 账号 Tab」就是这一个过滤参数。
    const xOnly = await app.request('/api/v1/admin/sources?type=X_USER', { cookie });
    const xBody = (await xOnly.json()) as { data: { type: string }[]; meta: { total: number } };
    expect(xBody.meta.total).toBe(2);
    expect(xBody.data.every((row) => row.type === 'X_USER')).toBe(true);

    const badPageSize = await app.request('/api/v1/admin/sources?pageSize=500', { cookie });
    expect(badPageSize.status).toBe(400);
  });

  it('PATCH 局部更新：只改给的字段', async () => {
    const created = (await (await create(X_BODY)).json()) as { data: { id: string } };
    const response = await app.request(`/api/v1/admin/sources/${created.data.id}`, {
      method: 'PATCH',
      cookie,
      body: JSON.stringify({ name: 'Andrej Karpathy (updated)', tier: 'S' }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: Record<string, unknown> };
    expect(body.data.name).toBe('Andrej Karpathy (updated)');
    expect(body.data.tier).toBe('S');
    // 没给 config，就不该被重写。
    expect(body.data.config).toMatchObject({ handle: 'karpathy' });
    expect(body.data.externalId).toBe('karpathy');
  });

  it('PATCH 不存在的来源 → 404', async () => {
    const response = await app.request('/api/v1/admin/sources/999999', {
      method: 'PATCH',
      cookie,
      body: JSON.stringify({ name: 'x' }),
    });
    expect(response.status).toBe(404);
  });

  it('PATCH 改 slug 撞车 → 409', async () => {
    await create(RSS_BODY);
    const second = (await (await create({ ...X_BODY })).json()) as { data: { id: string } };
    const response = await app.request(`/api/v1/admin/sources/${second.data.id}`, {
      method: 'PATCH',
      cookie,
      body: JSON.stringify({ slug: 'anthropic-news' }),
    });
    expect(response.status).toBe(409);
  });
});

describe('Admin Source Registry —— SSRF：私网 URL 必须被拒（docs/06 / docs/14）', () => {
  let app: SourcesTestApp;
  let cookie: string;

  beforeEach(async () => {
    app = await createSourcesTestApp();
    cookie = await app.login(TEST_ADMIN_EMAIL, UserRole.ADMIN);
  });

  async function create(body: unknown): Promise<Response> {
    return app.request('/api/v1/admin/sources', {
      method: 'POST',
      cookie,
      body: JSON.stringify(body),
    });
  }

  it.each([
    ['云 metadata', 'http://169.254.169.254/latest/meta-data/'],
    ['loopback', 'http://127.0.0.1:8080/feed'],
    ['十进制伪装', 'http://2130706433/feed'],
    ['私网', 'http://10.1.2.3/feed'],
    ['localhost 域名', 'http://localhost/feed'],
    ['IPv6 mapped loopback', 'http://[::ffff:127.0.0.1]/feed'],
  ])('feedUrl 指向 %s → 400 SOURCE_URL_NOT_ALLOWED', async (_label, url) => {
    const response = await create({ ...RSS_BODY, slug: nextSlug('blocked'), feedUrl: url });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string; details: unknown } };
    expect(body.error.code).toBe('SOURCE_URL_NOT_ALLOWED');
  });

  it('baseUrl 同样受限（纵深防御，不只是 feedUrl）', async () => {
    const response = await create({
      ...RSS_BODY,
      slug: 'blocked-base',
      baseUrl: 'http://192.168.1.1/',
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('SOURCE_URL_NOT_ALLOWED');
  });

  it('MANUAL_URL 的 config.url 同样受限', async () => {
    const response = await create({
      name: 'Internal wiki',
      slug: 'internal-wiki',
      type: 'MANUAL_URL',
      kind: 'COMMUNITY',
      config: { url: 'http://10.0.0.1/page' },
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('SOURCE_URL_NOT_ALLOWED');
  });

  it('对照组：同样的请求换成公网地址必须 201（证明上面不是「因为字段缺失」而失败）', async () => {
    const response = await create({ ...RSS_BODY, slug: 'public-feed' });
    expect(response.status).toBe(201);
  });
});

describe('Admin Source Registry —— 类型化 config 校验', () => {
  let app: SourcesTestApp;
  let cookie: string;

  beforeEach(async () => {
    app = await createSourcesTestApp();
    cookie = await app.login(TEST_ADMIN_EMAIL, UserRole.ADMIN);
  });

  async function create(body: unknown): Promise<Response> {
    return app.request('/api/v1/admin/sources', {
      method: 'POST',
      cookie,
      body: JSON.stringify(body),
    });
  }

  it('X_USER 缺 handle → 400 SOURCE_CONFIG_INVALID', async () => {
    const response = await create({ ...X_BODY, config: { includeQuotes: true } });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('SOURCE_CONFIG_INVALID');
  });

  it.each([
    ['handle 含非法字符', { handle: 'kar pathy' }],
    ['handle 过长', { handle: 'a'.repeat(16) }],
    ['includeQuotes 不是布尔', { handle: 'karpathy', includeQuotes: 'yes' }],
    ['未知键（拼错的 includeQuotes）', { handle: 'karpathy', includQuotes: true }],
  ])('X_USER config %s → 400 SOURCE_CONFIG_INVALID', async (_label, config) => {
    const response = await create({ ...X_BODY, slug: nextSlug('x'), config });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('SOURCE_CONFIG_INVALID');
  });

  it('externalId 与 handle 不一致 → 400（不悄悄挑一个用）', async () => {
    const response = await create({ ...X_BODY, slug: 'x-mismatch', externalId: 'someoneelse' });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('SOURCE_CONFIG_INVALID');
  });

  it('RSS 既没有 feedUrl 也没有 baseUrl → 400 SOURCE_CONFIG_INVALID', async () => {
    const response = await create({
      name: 'No url',
      slug: 'no-url',
      type: 'RSS',
      kind: 'MEDIA',
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('SOURCE_CONFIG_INVALID');
  });

  it('MANUAL_URL 缺 config.url → 400', async () => {
    const response = await create({
      name: 'Manual',
      slug: 'manual-1',
      type: 'MANUAL_URL',
      kind: 'COMMUNITY',
      config: { note: 'hi' },
    });
    expect(response.status).toBe(400);
  });

  it('GITHUB_REPO 接受 config.repo 并提升到 externalId', async () => {
    const response = await create({
      name: 'vLLM',
      slug: 'github-vllm',
      type: 'GITHUB_REPO',
      kind: 'DEVELOPER',
      config: { repo: 'vllm-project/vllm' },
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as { data: Record<string, unknown> };
    expect(body.data.externalId).toBe('vllm-project/vllm');
    // repo 被提升到列上，不应在 config 里再留一份。
    expect(body.data.config).not.toHaveProperty('repo');
  });

  it('HACKER_NEWS 的 feed 只接受内置榜单', async () => {
    const ok = await create({
      name: 'HN top',
      slug: 'hn-top',
      type: 'HACKER_NEWS',
      kind: 'COMMUNITY',
      config: { feed: 'top', minScore: 100 },
    });
    expect(ok.status).toBe(201);

    const bad = await create({
      name: 'HN nope',
      slug: 'hn-nope',
      type: 'HACKER_NEWS',
      kind: 'COMMUNITY',
      config: { feed: 'trending' },
    });
    expect(bad.status).toBe(400);
  });

  it('seed 写入的 seed / seedNote 标记必须被接受（否则 Admin UI 回传完整 config 会被拒）', async () => {
    const response = await create({
      ...X_BODY,
      slug: 'x-seeded-shape',
      config: {
        handle: 'karpathy',
        includeQuotes: true,
        includeReplies: false,
        seed: true,
        seedNote: '来自 seed',
      },
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as { data: { config: Record<string, unknown> } };
    expect(body.data.config.seed).toBe(true);
  });
});

describe('Admin Source Registry —— enable / disable', () => {
  let app: SourcesTestApp;
  let cookie: string;

  beforeEach(async () => {
    app = await createSourcesTestApp();
    cookie = await app.login(TEST_ADMIN_EMAIL, UserRole.ADMIN);
  });

  async function create(body: unknown): Promise<{ id: string }> {
    const response = await app.request('/api/v1/admin/sources', {
      method: 'POST',
      cookie,
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(201);
    return ((await response.json()) as { data: { id: string } }).data;
  }

  function act(id: string, action: 'enable' | 'disable'): Promise<Response> {
    return app.request(`/api/v1/admin/sources/${id}/${action}`, { method: 'POST', cookie });
  }

  it('停用之后**不再是 due source**（任务书明确要求的那条）', async () => {
    const created = await create({ ...RSS_BODY, slug: 'due-check' });

    const dueBefore = await app.sources.findDueSources(app.clock.now(), 100);
    expect(dueBefore.map((row) => row.id)).toContain(created.id);

    const disabled = await act(created.id, 'disable');
    expect(disabled.status).toBe(200);
    expect(((await disabled.json()) as { data: { enabled: boolean } }).data.enabled).toBe(false);

    const dueAfter = await app.sources.findDueSources(app.clock.now(), 100);
    expect(dueAfter.map((row) => row.id)).not.toContain(created.id);
  });

  it('重新启用 → 立刻回到 due 列表，并推进 nextFetchAt 到当下', async () => {
    const created = await create({ ...RSS_BODY, slug: 'reenable' });
    await act(created.id, 'disable');

    app.clock.advanceSeconds(3_600);
    const enabled = await act(created.id, 'enable');
    expect(enabled.status).toBe(200);
    const body = (await enabled.json()) as { data: { nextFetchAt: string; enabled: boolean } };
    expect(body.data.enabled).toBe(true);
    expect(body.data.nextFetchAt).toBe(app.clock.now().toISOString());

    const due = await app.sources.findDueSources(app.clock.now(), 100);
    expect(due.map((row) => row.id)).toContain(created.id);
  });

  it('重复 enable / disable 幂等，且**不重置** nextFetchAt', async () => {
    const created = await create({ ...RSS_BODY, slug: 'idempotent' });
    await act(created.id, 'disable');
    await act(created.id, 'enable');

    const first = app.sources.rows.get(created.id)?.nextFetchAt?.toISOString();
    app.clock.advanceSeconds(600);

    const again = await act(created.id, 'enable');
    expect(again.status).toBe(200);
    const body = (await again.json()) as { data: { nextFetchAt: string } };
    // 反复点「启用」不该反复插队 —— 否则正常来源会被饿死。
    expect(body.data.nextFetchAt).toBe(first);

    await act(created.id, 'disable');
    const twice = await act(created.id, 'disable');
    expect(twice.status).toBe(200);
  });

  it('对不存在的来源启停 → 404', async () => {
    expect((await act('424242', 'enable')).status).toBe(404);
    expect((await act('424242', 'disable')).status).toBe(404);
  });
});

describe('Admin Source Registry —— test / fetch-now', () => {
  let app: SourcesTestApp;
  let cookie: string;
  let sourceId: string;

  beforeEach(async () => {
    app = await createSourcesTestApp();
    cookie = await app.login(TEST_ADMIN_EMAIL, UserRole.ADMIN);
    const created = await app.request('/api/v1/admin/sources', {
      method: 'POST',
      cookie,
      body: JSON.stringify({ ...RSS_BODY, slug: 'probe' }),
    });
    sourceId = ((await created.json()) as { data: { id: string } }).data.id;
  });

  it('test → 200 + {ok,...}（失败是结论，不是 HTTP 错误）', async () => {
    app.tester.result = {
      ok: false,
      type: 'RSS' as never,
      target: 'https://example.com/feed',
      latencyMs: 5,
      message: 'Target responded with HTTP 503',
    };

    const response = await app.request(`/api/v1/admin/sources/${sourceId}/test`, {
      method: 'POST',
      cookie,
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: { ok: boolean; message: string } };
    expect(body.data.ok).toBe(false);
    expect(body.data.message).toContain('503');
    expect(app.tester.calls).toEqual([sourceId]);
  });

  it('fetch-now → 202，且**真的入队**了 collector.fetch-source（带幂等 JobId）', async () => {
    const response = await app.request(`/api/v1/admin/sources/${sourceId}/fetch-now`, {
      method: 'POST',
      cookie,
    });
    expect(response.status).toBe(202);
    const body = (await response.json()) as {
      data: { queue: string; jobName: string; jobId: string; window: string };
    };
    expect(body.data.queue).toBe('collector');
    expect(body.data.jobName).toBe('collector.fetch-source');
    expect(body.data.jobId).toBe(`collector:${sourceId}:${body.data.window}`);

    expect(app.enqueuer.jobs).toHaveLength(1);
    expect(app.enqueuer.jobs[0]?.payload).toEqual({
      sourceId,
      trigger: 'manual',
      requestedAt: app.clock.now().toISOString(),
    });
  });

  it('同一分钟内的重复 fetch-now 得到**同一个 JobId**（幂等，不会把队列刷满）', async () => {
    const first = await app.request(`/api/v1/admin/sources/${sourceId}/fetch-now`, {
      method: 'POST',
      cookie,
    });
    app.clock.advanceSeconds(30);
    const second = await app.request(`/api/v1/admin/sources/${sourceId}/fetch-now`, {
      method: 'POST',
      cookie,
    });

    const a = ((await first.json()) as { data: { jobId: string } }).data.jobId;
    const b = ((await second.json()) as { data: { jobId: string } }).data.jobId;
    expect(a).toBe(b);

    // 跨过分钟边界后应当是新的一次。
    app.clock.advanceSeconds(31);
    const third = await app.request(`/api/v1/admin/sources/${sourceId}/fetch-now`, {
      method: 'POST',
      cookie,
    });
    expect(((await third.json()) as { data: { jobId: string } }).data.jobId).not.toBe(a);
  });

  it('test / fetch-now 对不存在的来源 → 404（不是 500）', async () => {
    const t = await app.request('/api/v1/admin/sources/987654/test', { method: 'POST', cookie });
    expect(t.status).toBe(404);
    const f = await app.request('/api/v1/admin/sources/987654/fetch-now', {
      method: 'POST',
      cookie,
    });
    expect(f.status).toBe(404);
  });
});

/* ------------------------------------------------------------------ */
/* §23 独立审查（工程向）发现的回归守卫                                 */
/* ------------------------------------------------------------------ */

describe('独立审查回归 —— PATCH 的 enabled 必须与 /enable 同一套语义（P2-1）', () => {
  let app: SourcesTestApp;
  let cookie: string;

  beforeEach(async () => {
    app = await createSourcesTestApp();
    cookie = await app.login(TEST_ADMIN_EMAIL, UserRole.ADMIN);
  });

  async function createSource(): Promise<string> {
    const response = await app.request('/api/v1/admin/sources', {
      method: 'POST',
      cookie,
      body: JSON.stringify({
        name: 'PATCH enabled',
        slug: nextSlug('patch-enable'),
        type: 'RSS',
        kind: 'MEDIA',
        feedUrl: 'https://example.com/feed.xml',
        // 合法上限：抓一次之后 next_fetch_at 会停在 7 天后。
        fetchIntervalSeconds: 604800,
      }),
    });
    expect(response.status).toBe(201);
    return ((await response.json()) as { data: { id: string } }).data.id;
  }

  /** 模拟「抓过一次」：调度器把 next_fetch_at 推到 7 天后。 */
  function scheduleFarFuture(id: string): string {
    const far = new Date(app.clock.now().getTime() + 7 * 24 * 3_600_000);
    const row = app.sources.rows.get(id);
    if (row === undefined) throw new Error(`找不到 ${id}`);
    app.sources.rows.set(id, { ...row, nextFetchAt: far });
    return far.toISOString();
  }

  it('PATCH {enabled:true} 也推进 nextFetchAt（与 POST /:id/enable 一致）', async () => {
    const id = await createSource();
    await app.request(`/api/v1/admin/sources/${id}/disable`, { method: 'POST', cookie });

    app.clock.advanceSeconds(3_600);
    const far = scheduleFarFuture(id);

    const response = await app.request(`/api/v1/admin/sources/${id}`, {
      method: 'PATCH',
      cookie,
      body: JSON.stringify({ enabled: true }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: { enabled: boolean; nextFetchAt: string } };

    expect(body.data.enabled).toBe(true);
    expect(body.data.nextFetchAt).not.toBe(far);
    // ★ 不再停在 7 天后 —— 否则界面显示「已启用」，调度器却一周不碰它。
    expect(body.data.nextFetchAt).toBe(app.clock.now().toISOString());
  });

  it('对照组：PATCH 其他字段不会推进 nextFetchAt', async () => {
    const id = await createSource();
    const far = scheduleFarFuture(id);
    app.clock.advanceSeconds(3_600);

    const response = await app.request(`/api/v1/admin/sources/${id}`, {
      method: 'PATCH',
      cookie,
      body: JSON.stringify({ priority: 66 }),
    });
    const body = (await response.json()) as { data: { nextFetchAt: string } };
    expect(body.data.nextFetchAt).toBe(far);
  });

  it('PATCH {enabled:false} 不推进 nextFetchAt（与 disable 一致）', async () => {
    const id = await createSource();
    const before = app.sources.rows.get(id)?.nextFetchAt?.toISOString();

    const response = await app.request(`/api/v1/admin/sources/${id}`, {
      method: 'PATCH',
      cookie,
      body: JSON.stringify({ enabled: false }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: { enabled: boolean; nextFetchAt: string } };
    expect(body.data.enabled).toBe(false);
    expect(body.data.nextFetchAt).toBe(before);
  });

  it('对已启用的来源 PATCH {enabled:true} 不重置（幂等，与 /enable 一致）', async () => {
    const id = await createSource();
    const before = app.sources.rows.get(id)?.nextFetchAt?.toISOString();
    app.clock.advanceSeconds(600);

    const response = await app.request(`/api/v1/admin/sources/${id}`, {
      method: 'PATCH',
      cookie,
      body: JSON.stringify({ enabled: true }),
    });
    const body = (await response.json()) as { data: { nextFetchAt: string } };
    expect(body.data.nextFetchAt).toBe(before);
  });
});

describe('独立审查回归 —— config 与顶层字段的静默改数据（P3-1 / P3-2 / P4-1 / P4-2）', () => {
  let app: SourcesTestApp;
  let cookie: string;

  beforeEach(async () => {
    app = await createSourcesTestApp();
    cookie = await app.login(TEST_ADMIN_EMAIL, UserRole.ADMIN);
  });

  async function create(body: unknown): Promise<string> {
    const response = await app.request('/api/v1/admin/sources', {
      method: 'POST',
      cookie,
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(201);
    return ((await response.json()) as { data: { id: string } }).data.id;
  }

  function patch(id: string, body: unknown): Promise<Response> {
    return app.request(`/api/v1/admin/sources/${id}`, {
      method: 'PATCH',
      cookie,
      body: JSON.stringify(body),
    });
  }

  const RSS = { type: 'RSS', kind: 'MEDIA', feedUrl: 'https://example.com/feed.xml' };

  it('PATCH {config:null} → 400，而不是静默重置成默认值（P3-1）', async () => {
    const id = await create({
      ...RSS,
      name: 'config 清空',
      slug: nextSlug('config-null'),
      config: { maxItems: 250 },
    });

    const response = await patch(id, { config: null });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('VALIDATION_FAILED');

    // 而且原来的 250 必须**没被动过** —— 这条才是「静默改数据」的正面证明。
    const detail = await app.request(`/api/v1/admin/sources/${id}`, { cookie });
    const detailBody = (await detail.json()) as { data: { config: Record<string, unknown> } };
    expect(detailBody.data.config.maxItems).toBe(250);
  });

  it('局部 config 的 PATCH 保留 seed 标记（P3-2，HTTP 层）', async () => {
    const id = await create({
      name: 'seed 标记',
      slug: nextSlug('seedmark'),
      type: 'X_USER',
      kind: 'PERSON',
      config: { handle: 'karpathy', seed: true, seedNote: '来自 seed' },
    });

    // 管理员只改 tier，但表单把 config 一起回传了（且没带 seed 标记）。
    const response = await patch(id, {
      tier: 'S',
      config: { handle: 'karpathy', includeQuotes: true },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: { config: Record<string, unknown> } };
    expect(body.data.config.seed).toBe(true);
    expect(body.data.config.seedNote).toBe('来自 seed');
  });

  it('顶层未知字段 → 400（P4-2：`tierr` 拼错不再静默生效）', async () => {
    const id = await create({ ...RSS, name: '未知键', slug: nextSlug('unknown-key') });

    const response = await patch(id, { tierr: 'S', priority: 66 });
    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      error: { code: string; details: { fields: string[] } };
    };
    expect(body.error.code).toBe('VALIDATION_FAILED');
    expect(body.error.details.fields.join(' ')).toContain('unknown field');
    expect(body.error.details.fields.join(' ')).toContain('tierr');
  });

  it('PATCH {name:null} / {slug:null} → 400，而不是静默 no-op（P4-2）', async () => {
    const id = await create({ ...RSS, name: 'null name', slug: nextSlug('null-name') });

    expect((await patch(id, { name: null })).status).toBe(400);
    expect((await patch(id, { slug: null })).status).toBe(400);
  });

  it('emoji 名字按**码点**计长（P4-1：128 个 emoji 不该被误拒）', async () => {
    // MySQL 的 VARCHAR(255) 按字符计；JS 的 `.length` 把 emoji（代理对）算成 2。
    // 128 个 emoji 只有 128 个字符 —— 用 `.length` 会得到 256 而误判超长。
    const response = await app.request('/api/v1/admin/sources', {
      method: 'POST',
      cookie,
      body: JSON.stringify({
        ...RSS,
        name: '🚀'.repeat(128),
        slug: nextSlug('emoji'),
      }),
    });
    expect(response.status).toBe(201);

    // 对照：真的超长（256 个 emoji = 256 字符）仍必须被拒。
    const tooLong = await app.request('/api/v1/admin/sources', {
      method: 'POST',
      cookie,
      body: JSON.stringify({
        ...RSS,
        name: '🚀'.repeat(256),
        slug: nextSlug('emoji-long'),
      }),
    });
    expect(tooLong.status).toBe(400);
  });
});

describe('独立审查回归 —— P2002 兜底分支（P3-3）', () => {
  /**
   * 预检说「没有」，插入时撞唯一约束 —— 这正是「先查后写」的真实竞态。
   *
   * 顺序请求永远先命中 `assertSlugAvailable` 预检，所以 P2002 兜底分支
   * 在任何其它测试里都不会被执行到（独立审查反证：单独关掉它依然全绿）。
   */
  class RacingRepository extends InMemorySourceRepository {
    override async findBySlug(): Promise<null> {
      return null;
    }

    override async create(): Promise<never> {
      const error = new Error('Unique constraint failed on the fields: (`slug`)');
      (error as { code?: string }).code = 'P2002';
      throw error;
    }
  }

  it('预检通过但插入撞唯一约束 → 409，而不是 500', async () => {
    const app = await createSourcesTestApp({ sourceRepository: new RacingRepository() });
    try {
      const cookie = await app.login(TEST_ADMIN_EMAIL, UserRole.ADMIN);

      const response = await app.request('/api/v1/admin/sources', {
        method: 'POST',
        cookie,
        body: JSON.stringify({
          name: 'race',
          slug: 'race-slug',
          type: 'RSS',
          kind: 'MEDIA',
          feedUrl: 'https://example.com/feed.xml',
        }),
      });

      expect(response.status).toBe(409);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe('SOURCE_DUPLICATE_SLUG');
    } finally {
      await app.close();
    }
  });
});

describe('独立审查回归 —— Admin Origin 校验（docs/14 的 CSRF 部分）', () => {
  let app: SourcesTestApp;
  let cookie: string;

  beforeEach(async () => {
    app = await createSourcesTestApp();
    cookie = await app.login(TEST_ADMIN_EMAIL, UserRole.ADMIN);
  });

  const ALLOWED = 'http://localhost:3000';
  const RSS = { type: 'RSS', kind: 'MEDIA', feedUrl: 'https://example.com/feed.xml' };

  it('**不带** Origin（curl / 运维脚本）→ 放行（不能把运维通道打死）', async () => {
    const response = await app.request('/api/v1/admin/sources', { cookie });
    expect(response.status).toBe(200);
  });

  it('Origin = 站点源 → 放行', async () => {
    const response = await app.request('/api/v1/admin/sources', {
      method: 'POST',
      cookie,
      headers: { origin: ALLOWED },
      body: JSON.stringify({ ...RSS, name: 'origin ok', slug: nextSlug('origin-ok') }),
    });
    expect(response.status).toBe(201);
  });

  it('变更类请求带**不匹配**的 Origin → 403（跨站子域 CSRF）', async () => {
    const response = await app.request('/api/v1/admin/sources', {
      method: 'POST',
      cookie,
      headers: { origin: 'http://evil.signal.example.com' },
      body: JSON.stringify({ ...RSS, name: 'origin bad', slug: nextSlug('origin-bad') }),
    });
    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('FORBIDDEN');
  });

  it('`Origin: null`（沙箱 iframe / file://）→ 403', async () => {
    const created = await app.request('/api/v1/admin/sources', {
      method: 'POST',
      cookie,
      body: JSON.stringify({ ...RSS, name: 'null origin', slug: nextSlug('null-origin') }),
    });
    const id = ((await created.json()) as { data: { id: string } }).data.id;

    const response = await app.request(`/api/v1/admin/sources/${id}`, {
      method: 'PATCH',
      cookie,
      headers: { origin: 'null' },
      body: JSON.stringify({ priority: 60 }),
    });
    expect(response.status).toBe(403);
  });

  it('读方法（GET）带不匹配的 Origin → 放行（只保护变更类请求）', async () => {
    const response = await app.request('/api/v1/admin/sources', {
      cookie,
      headers: { origin: 'http://evil.example.com' },
    });
    expect(response.status).toBe(200);
  });

  it('错误响应不回显收到的 Origin（攻击者可控字符串不进日志/响应）', async () => {
    const response = await app.request('/api/v1/admin/sources', {
      method: 'POST',
      cookie,
      headers: { origin: 'http://secret-attacker-host.example.com' },
      body: JSON.stringify({ ...RSS, name: 'x', slug: nextSlug('x') }),
    });
    const raw = await response.text();
    expect(raw).not.toContain('secret-attacker-host');
    // 但要说清我们允许哪些，方便排查部署配置。
    expect(raw).toContain(ALLOWED);
  });
});
