/**
 * Sources 集成测试 —— **真实 MySQL**。
 *
 * 运行：`pnpm --filter @signal/api test:integration`（需要先 `pnpm db:migrate`）
 *
 * 与单元测试的分工：`sources-api.spec.ts` 用的是内存替身（复刻约束），
 * 这里打的是**真库**。必须验的几件事只有在真库上才成立：
 *
 *   1. 「停用后不再成为 due source」这条**真的由 SQL 保证**，
 *      而不是由我写的替身 if 保证；
 *   2. `nextFetchAt` 为 NULL 的行真的会被 `OR ... IS NULL` 取到
 *      （Agent 01 的 seed 就是这么写的 —— 少这一条，8 个预置来源永远不被采集）；
 *   3. BIGINT 主键、DECIMAL(4,1)、`Json?` 在真实驱动下的形态
 *      （`Prisma.Decimal` 不转就会变成 `{s,e,d}` 对象漏进响应）；
 *   4. `sources.slug` 的唯一索引真的会抛 P2002，且被翻译成 409。
 *
 * 连不上库就直接失败，绝不静默跳过。
 */

import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { createLogger } from '@signal/logger';
import { API_PREFIX, UserRole } from '@signal/contracts';
import { createMemoryStream } from '@signal/test-utils';
import { SourcesModule } from '../src/modules/sources/module';
import { SOURCE_CLOCK } from '../src/modules/sources/clock';
import { SOURCE_REPOSITORY } from '../src/modules/sources/repository';
import { SOURCE_FETCH_ENQUEUER } from '../src/modules/sources/source-enqueuer';
import { SOURCE_TESTER, SOURCE_TESTER_DEPS } from '../src/modules/sources/source-tester';
import { SOURCE_CONFIG } from '../src/modules/sources/source.config';
import type { SourceRepository } from '../src/modules/sources/repository';
import { AUTH_CONFIG } from '../src/modules/auth/auth.config';
import { CLOCK } from '../src/modules/auth/clock';
import { GITHUB_CLIENT } from '../src/modules/auth/github.client';
import { MAIL_SENDER } from '../src/modules/auth/mail-sender';
import { OTP_CODE_GENERATOR } from '../src/modules/auth/otp.service';
import { RATE_LIMITER } from '../src/modules/auth/rate-limiter';
import { REDIS_CLIENT } from '../src/modules/auth/redis-rate-limiter';
import { AUTH_REPOSITORY } from '../src/modules/auth/repository';
import { USER_REPOSITORY } from '../src/modules/users/user.repository';
import { APP_LOGGER } from '../src/common/logger/app-logger';
import { PrismaService } from '../src/common/prisma/prisma.service';
import {
  FakeClock,
  FakeGithubClient,
  FakeMailSender,
  FakeRateLimiter,
  InMemoryAuthRepository,
  InMemoryUserRepository,
  createTestAuthConfig,
} from './support/fakes';
import {
  FakeSourceClock,
  FakeSourceFetchEnqueuer,
  FakeSourceTester,
} from './support/source-fakes';
import { createTestSourceConfig } from './support/sources-test-app';
import { cookieHeader, setCookies } from './support/test-app';
import type { INestApplication } from '@nestjs/common';

/* ------------------------------------------------------------------ */
/* 环境                                                                */
/* ------------------------------------------------------------------ */

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

/** 载入仓库根 `.env`，但**不覆盖**已经显式设置的环境变量。 */
function loadDotEnv(): void {
  let content: string;
  try {
    content = readFileSync(`${REPO_ROOT}/.env`, 'utf8');
  } catch {
    return;
  }
  for (const line of content.split('\n')) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match === null) continue;
    const [, key, value] = match as unknown as [string, string, string];
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadDotEnv();

/** 本次运行创建的 slug 前缀：用它做清理，绝不误删别人的数据。 */
const SLUG_PREFIX = `it-agent03-${randomBytes(4).toString('hex')}`;

const ADMIN_EMAIL = `${SLUG_PREFIX}-admin@signal.test`;
const OTP_CODE = '424242';

let app: INestApplication;
let prisma: PrismaService;
let repository: SourceRepository;
let clock: FakeSourceClock;
let baseUrl: string;
let cookie: string;

const userRepository = new InMemoryUserRepository();
const authRepository = new InMemoryAuthRepository();
const mail = new FakeMailSender();
authRepository.users = userRepository;

async function request(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    redirect: 'manual',
    ...init,
    headers: {
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      cookie,
      ...(init.headers ?? {}),
    },
  });
}

beforeAll(async () => {
  clock = new FakeSourceClock();

  const moduleRef = await Test.createTestingModule({ imports: [SourcesModule] })
    .overrideProvider(SOURCE_CONFIG)
    .useValue(createTestSourceConfig())
    // 刻意**不**覆盖 SOURCE_REPOSITORY：要的就是真实的 Prisma 实现。
    .overrideProvider(SOURCE_TESTER)
    .useValue(new FakeSourceTester())
    .overrideProvider(SOURCE_TESTER_DEPS)
    .useValue({})
    .overrideProvider(SOURCE_FETCH_ENQUEUER)
    .useValue(new FakeSourceFetchEnqueuer())
    .overrideProvider(SOURCE_CLOCK)
    .useValue(clock)
    .overrideProvider(AUTH_CONFIG)
    .useValue(createTestAuthConfig())
    .overrideProvider(AUTH_REPOSITORY)
    .useValue(authRepository)
    .overrideProvider(USER_REPOSITORY)
    .useValue(userRepository)
    .overrideProvider(RATE_LIMITER)
    .useValue(new FakeRateLimiter())
    .overrideProvider(CLOCK)
    .useValue(new FakeClock())
    .overrideProvider(OTP_CODE_GENERATOR)
    .useValue(() => OTP_CODE)
    .overrideProvider(MAIL_SENDER)
    .useValue(mail)
    .overrideProvider(GITHUB_CLIENT)
    .useValue(new FakeGithubClient(true))
    .overrideProvider(APP_LOGGER)
    .useValue(createLogger({ service: 'api-it', level: 'silent', destination: createMemoryStream() }))
    .overrideProvider(REDIS_CLIENT)
    .useValue({ eval: async () => [1, 1000], quit: async () => 'OK' })
    .compile();

  app = moduleRef.createNestApplication({ logger: false });
  app.setGlobalPrefix(API_PREFIX.slice(1));
  await app.listen(0, '127.0.0.1');
  baseUrl = await app.getUrl();

  prisma = app.get(PrismaService);
  repository = app.get<SourceRepository>(SOURCE_REPOSITORY);

  // 走完整 OTP 登录拿管理员 Cookie。
  userRepository.seed({ email: ADMIN_EMAIL, role: UserRole.ADMIN });
  await request('/api/v1/auth/email/request-code', {
    method: 'POST',
    body: JSON.stringify({ email: ADMIN_EMAIL }),
  });
  const verify = await request('/api/v1/auth/email/verify', {
    method: 'POST',
    body: JSON.stringify({ email: ADMIN_EMAIL, code: mail.latestCode() }),
  });
  if (!verify.ok) throw new Error(`集成测试登录失败：${verify.status} ${await verify.text()}`);
  cookie = cookieHeader(setCookies(verify));
}, 60_000);

afterAll(async () => {
  // 只删本次运行创建的（按 slug 前缀），不动 seed 数据与其他 Agent 的数据。
  await prisma.source.deleteMany({ where: { slug: { startsWith: SLUG_PREFIX } } });
  await app?.close();
});

let counter = 0;
function nextSlug(): string {
  counter += 1;
  return `${SLUG_PREFIX}-${counter}`;
}

/** 直接从库里查一行（绕过仓储，看真实存储形态）。 */
async function rawRow(slug: string) {
  return prisma.source.findUniqueOrThrow({ where: { slug } });
}

/* ------------------------------------------------------------------ */
/* 真实存储形态                                                        */
/* ------------------------------------------------------------------ */

describe('真实 MySQL —— 存储形态', () => {
  it('BIGINT 主键经仓储变成 string，DECIMAL 变成 number', async () => {
    const slug = nextSlug();
    const response = await request('/api/v1/admin/sources', {
      method: 'POST',
      body: JSON.stringify({
        name: '形态检查',
        slug,
        type: 'RSS',
        kind: 'MEDIA',
        tier: 'B',
        feedUrl: 'https://example.com/feed.xml',
        trustScore: 8.5,
        priority: 77,
      }),
    });
    expect(response.status).toBe(201);

    const body = (await response.json()) as { data: Record<string, unknown> };
    expect(typeof body.data.id).toBe('string');
    // 不转 Number() 的话，Prisma.Decimal 会 JSON 序列化成 {s,e,d} 对象。
    expect(body.data.trustScore).toBe(8.5);
    expect(typeof body.data.trustScore).toBe('number');
    expect(body.data.priority).toBe(77);
  });

  it('config 以 JSON 存进真库，含中文也完好（utf8mb4）', async () => {
    const slug = nextSlug();
    const response = await request('/api/v1/admin/sources', {
      method: 'POST',
      body: JSON.stringify({
        name: '中文配置',
        slug,
        type: 'MANUAL_URL',
        kind: 'COMMUNITY',
        config: { url: 'https://example.com/post', note: '这是中文备注 · emoji 🚀' },
      }),
    });
    expect(response.status).toBe(201);

    const row = await rawRow(slug);
    expect(row.config).toEqual({
      url: 'https://example.com/post',
      note: '这是中文备注 · emoji 🚀',
    });
  });

  it('真实仓储把 Prisma 枚举收敛成契约枚举值', async () => {
    const slug = nextSlug();
    await request('/api/v1/admin/sources', {
      method: 'POST',
      body: JSON.stringify({
        name: 'X 白名单',
        slug,
        type: 'X_USER',
        kind: 'PERSON',
        tier: 'A',
        externalId: 'enumchk',
        config: { handle: 'enumchk' },
      }),
    });

    const record = await repository.findBySlug(slug);
    expect(record).not.toBeNull();
    expect(record?.type).toBe('X_USER');
    expect(record?.kind).toBe('PERSON');
    expect(record?.tier).toBe('A');
    expect(typeof record?.id).toBe('string');
  });

  it('slug 唯一索引真的生效，且被翻译成 409 而不是 500', async () => {
    const slug = nextSlug();
    const body = { name: 'dup', slug, type: 'RSS', kind: 'MEDIA', feedUrl: 'https://example.com/f' };

    expect((await request('/api/v1/admin/sources', { method: 'POST', body: JSON.stringify(body) })).status).toBe(201);
    const second = await request('/api/v1/admin/sources', {
      method: 'POST',
      body: JSON.stringify({ ...body, name: 'dup2' }),
    });
    expect(second.status).toBe(409);
    expect(((await second.json()) as { error: { code: string } }).error.code).toBe(
      'SOURCE_DUPLICATE_SLUG',
    );
  });
});

/* ------------------------------------------------------------------ */
/* 到期查询 —— 任务书里那条硬要求                                       */
/* ------------------------------------------------------------------ */

describe('真实 MySQL —— due source 查询', () => {
  it('**停用之后不再出现在 due 列表里**（由真 SQL 保证）', async () => {
    const slug = nextSlug();
    const created = await request('/api/v1/admin/sources', {
      method: 'POST',
      body: JSON.stringify({
        name: 'due 检查',
        slug,
        type: 'RSS',
        kind: 'MEDIA',
        feedUrl: 'https://example.com/feed.xml',
      }),
    });
    const id = ((await created.json()) as { data: { id: string } }).data.id;

    const dueBefore = await repository.findDueSources(clock.now(), 1_000);
    expect(dueBefore.map((row) => row.id)).toContain(id);

    const disabled = await request(`/api/v1/admin/sources/${id}/disable`, { method: 'POST' });
    expect(disabled.status).toBe(200);

    const dueAfter = await repository.findDueSources(clock.now(), 1_000);
    expect(dueAfter.map((row) => row.id)).not.toContain(id);

    // 库里 enabled 确实是 false（不是靠内存状态）。
    expect((await rawRow(slug)).enabled).toBe(false);
  });

  it('`next_fetch_at` 为 NULL 的行**也算到期**（Agent 01 的 seed 就是这种形态）', async () => {
    const slug = nextSlug();
    await request('/api/v1/admin/sources', {
      method: 'POST',
      body: JSON.stringify({
        name: 'NULL 到期',
        slug,
        type: 'RSS',
        kind: 'MEDIA',
        feedUrl: 'https://example.com/feed.xml',
      }),
    });

    // 直接把这一列改成 NULL，复刻 seed 数据的形态。
    const row = await rawRow(slug);
    await prisma.source.update({ where: { id: row.id }, data: { nextFetchAt: null } });

    const due = await repository.findDueSources(clock.now(), 1_000);
    expect(due.map((r) => String(r.id))).toContain(String(row.id));
  });

  it('未来的 next_fetch_at 不算到期', async () => {
    const slug = nextSlug();
    await request('/api/v1/admin/sources', {
      method: 'POST',
      body: JSON.stringify({
        name: '未来',
        slug,
        type: 'RSS',
        kind: 'MEDIA',
        feedUrl: 'https://example.com/feed.xml',
      }),
    });
    const row = await rawRow(slug);
    const future = new Date(clock.now().getTime() + 3_600_000);
    await prisma.source.update({ where: { id: row.id }, data: { nextFetchAt: future } });

    const due = await repository.findDueSources(clock.now(), 1_000);
    expect(due.map((r) => String(r.id))).not.toContain(String(row.id));
  });

  it('按 next_fetch_at 升序返回，且遵守 limit', async () => {
    const slugA = nextSlug();
    const slugB = nextSlug();
    // offset 越大 = next_fetch_at 越早 = 越该排在前面。
    // 于是 B（120s）必须排在 A（60s）之前。
    for (const [slug, offset] of [
      [slugA, 60_000],
      [slugB, 120_000],
    ] as const) {
      await request('/api/v1/admin/sources', {
        method: 'POST',
        body: JSON.stringify({
          name: `排序 ${slug}`,
          slug,
          type: 'RSS',
          kind: 'MEDIA',
          feedUrl: 'https://example.com/feed.xml',
        }),
      });
      const row = await rawRow(slug);
      await prisma.source.update({
        where: { id: row.id },
        data: { nextFetchAt: new Date(clock.now().getTime() - offset) },
      });
    }

    // ⚠ 不能断言 due[0] 就是 slugB —— 库里还有 seed 数据与本次运行先前建的记录，
    // 它们同样到期（seed 的 next_fetch_at 是 NULL，在 MySQL 的 ASC 下排最前）。
    // 断言**这两条之间的相对顺序**才是这条用例真正要验的东西。
    const due = await repository.findDueSources(clock.now(), 1_000);
    const order = due.map((row) => row.slug);
    expect(order).toContain(slugA);
    expect(order).toContain(slugB);
    expect(order.indexOf(slugB)).toBeLessThan(order.indexOf(slugA));

    // limit 单独验：只取 2 条。
    expect(await repository.findDueSources(clock.now(), 2)).toHaveLength(2);
  });

  it('重新启用后立刻回到 due 列表', async () => {
    const slug = nextSlug();
    const created = await request('/api/v1/admin/sources', {
      method: 'POST',
      body: JSON.stringify({
        name: '重新启用',
        slug,
        type: 'RSS',
        kind: 'MEDIA',
        feedUrl: 'https://example.com/feed.xml',
      }),
    });
    const id = ((await created.json()) as { data: { id: string } }).data.id;

    await request(`/api/v1/admin/sources/${id}/disable`, { method: 'POST' });
    clock.advanceSeconds(3_600);
    const enabled = await request(`/api/v1/admin/sources/${id}/enable`, { method: 'POST' });
    expect(enabled.status).toBe(200);

    const due = await repository.findDueSources(clock.now(), 1_000);
    expect(due.map((row) => row.id)).toContain(id);
  });
});

/* ------------------------------------------------------------------ */
/* 与 seed 数据的共处                                                  */
/* ------------------------------------------------------------------ */

describe('真实 MySQL —— 与 Agent 01 的 seed 数据共处', () => {
  it('seed 出来的 X 白名单能被列表按 type 过滤出来，且 config 形状可读', async () => {
    const response = await request('/api/v1/admin/sources?type=X_USER&pageSize=100');
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: { type: string; externalId: string | null; config: Record<string, unknown> | null }[];
      meta: { total: number };
    };

    // seed 预置 6 个（docs/00 的推荐人物）。
    expect(body.meta.total).toBeGreaterThanOrEqual(6);

    // ⚠ 必须按 **seed 的 slug** 定位，不能按 externalId ——
    // 本文件前面刻意建过一条 externalId 也是 karpathy 的记录，
    // 按 externalId 找会命中最新的那一条（它没有 seed 标记），
    // 于是断言失败却与 seed 无关。
    const seeded = body.data.find((row) => (row as { slug?: string }).slug === 'x-karpathy');
    expect(seeded, '未找到 seed 出来的 x-karpathy').toBeDefined();
    // seed 写的是稀疏 config（只有 handle / includeQuotes / includeReplies + seed 标记）。
    expect(seeded?.config?.handle).toBe('karpathy');
    expect(seeded?.config?.seed).toBe(true);
  });

  it('对 seed 出来的来源做一次不含 config 的 PATCH，不会破坏它', async () => {
    const list = await request('/api/v1/admin/sources?type=X_USER&pageSize=100');
    const body = (await list.json()) as {
      data: { id: string; slug: string; config: unknown }[];
    };
    const target = body.data.find((row) => row.slug === 'x-karpathy');
    expect(target, '未找到 seed 出来的 x-karpathy').toBeDefined();

    const before = await prisma.source.findUniqueOrThrow({
      where: { id: BigInt(target?.id ?? '0') },
    });
    const response = await request(`/api/v1/admin/sources/${target?.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ priority: 71 }),
    });
    expect(response.status).toBe(200);

    const after = await prisma.source.findUniqueOrThrow({ where: { id: before.id } });
    expect(after.priority).toBe(71);
    // config 原样保留 —— 没给 config 就不该被重写。
    expect(after.config).toEqual(before.config);
  });
});

/* ------------------------------------------------------------------ */
/* §23 独立审查的回归守卫（必须在真库上跑）                             */
/* ------------------------------------------------------------------ */

describe('真实 MySQL —— BIGINT 上界（独立审查 F2）', () => {
  it('超出驱动可绑定范围的 :id → 404 而不是 500', async () => {
    // ⚠ 这条**只能在真库上测**：内存替身用字符串键，任何 id 都只是「查不到」，
    // 复刻不了 Prisma 按有符号 64 位绑定失败这件事。
    //
    // 实测（work/_agent03/repro-bigint-bound.mjs）：
    //   18446744073709551615（BIGINT UNSIGNED 的合法上限）→ PrismaClientUnknownRequestError
    // 也就是说不设上界的话，连「合法」的 id 都会把 404 变成 500。
    for (const id of [
      '18446744073709551615', // 无符号上限 —— 合法但驱动绑不了
      '9223372036854775808', // 有符号上限 + 1
      '99999999999999999999', // 20 位但远超范围
    ]) {
      const response = await request(`/api/v1/admin/sources/${id}`);
      expect(response.status, `id=${id} 应当 404 而不是 500`).toBe(404);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe('SOURCE_NOT_FOUND');
    }
  });

  it('边界对照：有符号上限本身是「可绑定的」→ 404（查不到，而不是 500）', async () => {
    const response = await request('/api/v1/admin/sources/9223372036854775807');
    expect(response.status).toBe(404);
  });

  it('对照组：畸形 id 与非数字同样 404（既有行为未回归）', async () => {
    for (const id of ['not-a-number', '0', '-1', '0x1f', '1.5']) {
      expect((await request(`/api/v1/admin/sources/${id}`)).status, `id=${id}`).toBe(404);
    }
  });
});

describe('真实 MySQL —— 并发建同一 slug（独立审查 P3-3）', () => {
  it('4 个并发请求：恰好一个 201，其余 409，**没有 500**', async () => {
    // 这条是**唯一**会走到 P2002 兜底分支的测试：
    // 顺序请求永远先命中 `assertSlugAvailable` 预检，兜底分支从未被执行。
    const slug = nextSlug();
    const body = {
      name: '并发',
      slug,
      type: 'RSS',
      kind: 'MEDIA',
      feedUrl: 'https://example.com/feed.xml',
    };

    const responses = await Promise.all(
      Array.from({ length: 4 }, () =>
        request('/api/v1/admin/sources', { method: 'POST', body: JSON.stringify(body) }),
      ),
    );
    const statuses = responses.map((r) => r.status).sort();

    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(3);
    expect(statuses.filter((s) => s >= 500)).toEqual([]);

    // 库里恰好一行。
    expect(await prisma.source.count({ where: { slug } })).toBe(1);
  });
});

describe('真实 MySQL —— list() 的真 SQL（独立审查 P3-4）', () => {
  it('中文关键词能命中 name（对照：不存在的串返回 0 条）', async () => {
    // 单元测试里这几个过滤是**替身自己实现的**，真实现从未被执行。
    // 也刻意用**中文**探针 —— Agent 01 的 FULLTEXT 就是被纯 ASCII 探针骗过去的。
    const marker = `模型评测${randomBytes(3).toString('hex')}`;
    await request('/api/v1/admin/sources', {
      method: 'POST',
      body: JSON.stringify({
        name: `${marker} 甲`,
        slug: nextSlug(),
        type: 'RSS',
        kind: 'MEDIA',
        feedUrl: 'https://example.com/feed.xml',
      }),
    });
    await request('/api/v1/admin/sources', {
      method: 'POST',
      body: JSON.stringify({
        name: `${marker} 乙`,
        slug: nextSlug(),
        type: 'RSS',
        kind: 'MEDIA',
        feedUrl: 'https://example.com/feed.xml',
      }),
    });

    const hit = await request(`/api/v1/admin/sources?q=${encodeURIComponent(marker)}`);
    expect(hit.status).toBe(200);
    const hitBody = (await hit.json()) as {
      data: { name: string; slug: string }[];
      meta: { total: number };
    };
    expect(hitBody.meta.total).toBe(2);
    expect(hitBody.data.every((row) => row.name.includes(marker))).toBe(true);

    const miss = await request(`/api/v1/admin/sources?q=${marker}不存在`);
    const missBody = (await miss.json()) as { meta: { total: number } };
    expect(missBody.meta.total).toBe(0);
  });

  it('q 也能命中 slug', async () => {
    const slug = nextSlug();
    await request('/api/v1/admin/sources', {
      method: 'POST',
      body: JSON.stringify({
        name: 'slug 命中',
        slug,
        type: 'RSS',
        kind: 'MEDIA',
        feedUrl: 'https://example.com/feed.xml',
      }),
    });

    const response = await request(`/api/v1/admin/sources?q=${slug}`);
    const body = (await response.json()) as { meta: { total: number }; data: { slug: string }[] };
    expect(body.meta.total).toBe(1);
    expect(body.data[0]?.slug).toBe(slug);
  });

  it('enabled 过滤是真的下推到 SQL', async () => {
    const slug = nextSlug();
    const created = await request('/api/v1/admin/sources', {
      method: 'POST',
      body: JSON.stringify({
        name: '启停过滤',
        slug,
        type: 'RSS',
        kind: 'MEDIA',
        feedUrl: 'https://example.com/feed.xml',
      }),
    });
    const id = ((await created.json()) as { data: { id: string } }).data.id;

    const enabledBefore = await request(`/api/v1/admin/sources?q=${slug}&enabled=true`);
    expect(((await enabledBefore.json()) as { meta: { total: number } }).meta.total).toBe(1);

    await request(`/api/v1/admin/sources/${id}/disable`, { method: 'POST' });

    const enabledAfter = await request(`/api/v1/admin/sources?q=${slug}&enabled=true`);
    expect(((await enabledAfter.json()) as { meta: { total: number } }).meta.total).toBe(0);

    const disabled = await request(`/api/v1/admin/sources?q=${slug}&enabled=false`);
    expect(((await disabled.json()) as { meta: { total: number } }).meta.total).toBe(1);
  });

  it('分页的 skip/offset 真的生效（page=2 与 page=1 不重叠、不重不漏）', async () => {
    const marker = `分页${randomBytes(3).toString('hex')}`;
    for (let i = 0; i < 5; i += 1) {
      await request('/api/v1/admin/sources', {
        method: 'POST',
        body: JSON.stringify({
          name: `${marker}-${i}`,
          slug: nextSlug(),
          type: 'RSS',
          kind: 'MEDIA',
          feedUrl: 'https://example.com/feed.xml',
        }),
      });
    }

    const first = await request(`/api/v1/admin/sources?q=${marker}&page=1&pageSize=2`);
    const firstBody = (await first.json()) as {
      data: { id: string }[];
      meta: { page: number; pageSize: number; total: number; totalPages: number };
    };
    expect(firstBody.data).toHaveLength(2);
    expect(firstBody.meta).toMatchObject({ page: 1, pageSize: 2, total: 5, totalPages: 3 });

    const second = await request(`/api/v1/admin/sources?q=${marker}&page=2&pageSize=2`);
    const secondBody = (await second.json()) as { data: { id: string }[]; meta: { page: number } };
    expect(secondBody.data).toHaveLength(2);
    expect(secondBody.meta.page).toBe(2);

    const third = await request(`/api/v1/admin/sources?q=${marker}&page=3&pageSize=2`);
    const thirdBody = (await third.json()) as { data: { id: string }[] };
    expect(thirdBody.data).toHaveLength(1);

    // 三页合起来恰好 5 条、无重复（skip 恒为 0 的话这条会红）。
    const ids = [
      ...firstBody.data.map((r) => r.id),
      ...secondBody.data.map((r) => r.id),
      ...thirdBody.data.map((r) => r.id),
    ];
    expect(new Set(ids).size).toBe(5);
  });
});
