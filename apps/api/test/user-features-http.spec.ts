/**
 * 三组用户能力的**真 HTTP** 端到端测试。
 *
 * ── 为什么需要这个文件（§23 审查的 F3）──────────────────────────────
 * 第一版里，6 条路由的**控制器方法从未被任何测试调用过** ——
 * 只有「读控制器元数据」的路由表断言。那能证明路由**声明**对了，
 * 但证明不了：
 *
 * - 响应**封套形状**（`{data}` / `{data, meta}`）对不对；
 * - 路径参数有没有接到服务层（`:contentId` 打错一个字母，元数据测试照样绿）；
 * - 状态码（200 / 400 / 401 / 404）；
 * - 校验错误在**真实异常过滤器**下长什么样。
 *
 * 本项目的历史反复证明这类「只读元数据」的覆盖是空跑：
 * Agent 06 的 P0（集成测试自己拼字面量、从没调用过 builder）
 * 与 Agent 08 的 P1（worker 持久化层零执行）都是同一个形状。
 *
 * ── 怎么做到「真 HTTP 但不重复 Agent 02 的工作」──────────────────────
 * `AuthGuard` **本身**的行为（401 语义、撤权即时生效、token 提取顺序）
 * 由 Agent 02 的 `auth-guards.spec.ts` 覆盖 —— 这里不重复。
 * 所以本文件只把守卫依赖的**两个端口**换成桩：任何 token 都解析成
 * 同一个固定用户。于是：
 *
 * - 走的是**真的** `AuthGuard`、真的控制器、真的服务、真的 dto、
 *   真的异常过滤器、真的 HTTP 栈；
 * - 换掉的只有「这个 token 属于谁」这一个外部事实。
 */

import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { API_PREFIX, UserRole, UserStatus } from '@signal/contracts';
import { TEST_ENV } from '@signal/test-utils';
import {
  ACCESS_TOKEN_VERIFIER,
  AUTH_SESSION_LOOKUP,
  type AccessTokenClaims,
  type AuthenticatedSession,
} from '../src/common/guards';
import { PrismaService } from '../src/common/prisma/prisma.service';

import { BookmarksModule } from '../src/modules/bookmarks/module';
import { BOOKMARK_REPOSITORY } from '../src/modules/bookmarks/repository';
import { ReadingProgressModule } from '../src/modules/reading-progress/module';
import { READING_PROGRESS_REPOSITORY } from '../src/modules/reading-progress/repository';
import { UserPreferencesModule } from '../src/modules/user-preferences/module';
import { USER_PREFERENCE_REPOSITORY } from '../src/modules/user-preferences/repository';

import {
  InMemoryBookmarkRepository,
  InMemoryReadingProgressRepository,
  InMemoryUserPreferenceRepository,
} from './support/user-features-fakes';

/**
 * ⚠ 先把 env 补齐：构建模块时 `AuthModule` 的若干工厂会调 `parseEnv()`
 *（Agent 02 的实现）。这条在 Agent 08 的同款测试上真实踩过 ——
 * 开发 worktree 里绿、合并到 `main` 后红。
 */
beforeAll(() => {
  for (const [key, value] of Object.entries(TEST_ENV)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
});

/** 固定用户：所有 token 都解析成它。 */
const USER_ID = '42';
const TOKEN = 'test-access-token';

let app: INestApplication;
let baseUrl: string;
let bookmarks: InMemoryBookmarkRepository;
let progressRepo: InMemoryReadingProgressRepository;
let preferences: InMemoryUserPreferenceRepository;

/** 发一个请求；默认带上认证头。 */
async function request(
  path: string,
  init: RequestInit & { anonymous?: boolean } = {},
): Promise<Response> {
  const { anonymous, ...rest } = init;
  return fetch(`${baseUrl}${API_PREFIX}${path}`, {
    ...rest,
    headers: {
      'content-type': 'application/json',
      ...(anonymous === true ? {} : { authorization: `Bearer ${TOKEN}` }),
      ...(rest.headers ?? {}),
    },
  });
}

beforeAll(async () => {
  bookmarks = new InMemoryBookmarkRepository();
  bookmarks.seedVisible('100', '101');
  progressRepo = new InMemoryReadingProgressRepository();
  progressRepo.seedVisible('100', '101');
  preferences = new InMemoryUserPreferenceRepository();

  const moduleRef = await Test.createTestingModule({
    imports: [BookmarksModule, ReadingProgressModule, UserPreferencesModule],
  })
    // —— 外部世界：认证端口 + Prisma + 三个仓储 ——
    .overrideProvider(ACCESS_TOKEN_VERIFIER)
    .useValue({
      verifyAccessToken: (): AccessTokenClaims => ({
        userId: USER_ID,
        sessionId: 'session-1',
        role: UserRole.USER,
      }),
    })
    .overrideProvider(AUTH_SESSION_LOOKUP)
    .useValue({
      findAuthenticatedSession: async (): Promise<AuthenticatedSession> => ({
        sessionId: 'session-1',
        userId: USER_ID,
        role: UserRole.USER,
        status: UserStatus.ACTIVE,
      }),
    })
    .overrideProvider(PrismaService)
    .useValue({})
    .overrideProvider(BOOKMARK_REPOSITORY)
    .useValue(bookmarks)
    .overrideProvider(READING_PROGRESS_REPOSITORY)
    .useValue(progressRepo)
    .overrideProvider(USER_PREFERENCE_REPOSITORY)
    .useValue(preferences)
    .compile();

  app = moduleRef.createNestApplication({ logger: false });
  // 与 bootstrap.ts 一致：前缀来自契约常量，不写字面量
  app.setGlobalPrefix(API_PREFIX.slice(1));
  await app.listen(0);

  const address = app.getHttpServer().address() as { port: number };
  baseUrl = `http://127.0.0.1:${String(address.port)}`;
});

afterAll(async () => {
  await app.close();
});

/* ------------------------------------------------------------------ */
/* 匿名拒绝 —— 真 HTTP 上的 401                                          */
/* ------------------------------------------------------------------ */

describe('⚠ 匿名访问六条路由全部 401（任务书的必测项）', () => {
  const ROUTES: { method: string; path: string; body?: string }[] = [
    { method: 'POST', path: '/bookmarks/100' },
    { method: 'DELETE', path: '/bookmarks/100' },
    { method: 'GET', path: '/bookmarks' },
    { method: 'PUT', path: '/reading-progress', body: JSON.stringify({}) },
    { method: 'GET', path: '/me/preferences' },
    { method: 'PUT', path: '/me/preferences', body: JSON.stringify({ theme: 'DARK' }) },
  ];

  for (const route of ROUTES) {
    it(`${route.method} ${route.path} → 401`, async () => {
      const response = await request(route.path, {
        method: route.method,
        anonymous: true,
        ...(route.body === undefined ? {} : { body: route.body }),
      });

      expect(response.status).toBe(401);
      const body = (await response.json()) as { error?: { code?: string } };
      // 统一错误封套（`docs/02`）
      expect(body.error?.code).toBe('UNAUTHORIZED');
    });
  }

  it('带 token 的同一批路由不再是 401（证明 401 来自守卫而不是路由不存在）', async () => {
    const response = await request('/bookmarks', { method: 'GET' });
    expect(response.status).not.toBe(401);
    expect(response.status).not.toBe(404);
  });
});

/* ------------------------------------------------------------------ */
/* 收藏                                                                */
/* ------------------------------------------------------------------ */

describe('收藏 —— 真 HTTP 上的幂等与封套', () => {
  it('POST 加收藏 → 200 + `{data:{contentId,bookmarked,createdAt}}` 封套', async () => {
    const response = await request('/bookmarks/100', { method: 'POST' });
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      data?: { contentId?: string; bookmarked?: boolean; createdAt?: string };
    };
    expect(body.data).toMatchObject({ contentId: '100', bookmarked: true });
    expect(typeof body.data?.createdAt).toBe('string');
  });

  it('⚠ 重复 POST **仍是同一份响应**（幂等，且 200 不是 409）', async () => {
    const first = (await (await request('/bookmarks/100', { method: 'POST' })).json()) as {
      data: { createdAt: string; bookmarked: boolean };
    };
    const second = await request('/bookmarks/100', { method: 'POST' });

    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as {
      data: { createdAt: string; bookmarked: boolean };
    };
    expect(secondBody.data.createdAt).toBe(first.data.createdAt);
  });

  it('POST 不存在的 contentId → 404 + 统一错误封套', async () => {
    const response = await request('/bookmarks/999', { method: 'POST' });
    expect(response.status).toBe(404);

    const body = (await response.json()) as {
      error?: { code?: string; message?: string; requestId?: string };
    };
    expect(body.error?.code).toBe('CONTENT_NOT_VISIBLE');
    // `docs/15`：错误体必须带 requestId（这是封套契约的一部分）
    expect(typeof body.error?.requestId).toBe('string');
  });

  it('⚠ 超界 BIGINT 的 contentId → 404（不是 500）', async () => {
    const response = await request('/bookmarks/18446744073709551615', { method: 'POST' });
    expect(response.status).toBe(404);
  });

  it('GET 列表 → 200 + `{data, meta:{nextCursor}}`（cursor 封套）', async () => {
    const response = await request('/bookmarks', { method: 'GET' });
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      data?: unknown[];
      meta?: { nextCursor?: string | null };
    };
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.meta).toHaveProperty('nextCursor');
  });

  it('非法 cursor → 400（不是 500）', async () => {
    const response = await request('/bookmarks?cursor=99999999999999999999-1', { method: 'GET' });
    expect(response.status).toBe(400);
  });

  it('DELETE 取消收藏 → 200 + `{data:{bookmarked:false}}`；再删一次仍 200（幂等）', async () => {
    await request('/bookmarks/100', { method: 'POST' });

    const first = await request('/bookmarks/100', { method: 'DELETE' });
    expect(first.status).toBe(200);
    expect(((await first.json()) as { data: { bookmarked: boolean } }).data.bookmarked).toBe(false);

    const second = await request('/bookmarks/100', { method: 'DELETE' });
    expect(second.status).toBe(200);
  });
});

/* ------------------------------------------------------------------ */
/* 阅读进度                                                            */
/* ------------------------------------------------------------------ */

describe('阅读进度 —— 真 HTTP', () => {
  it('PUT 合法进度 → 200 + 整行封套', async () => {
    const response = await request('/reading-progress', {
      method: 'PUT',
      body: JSON.stringify({ resourceType: 'CONTENT', resourceId: '100', progress: 0.42 }),
    });
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      data?: { resourceType?: string; progress?: number; completedAt?: string | null };
    };
    expect(body.data).toMatchObject({ resourceType: 'CONTENT', progress: 0.42 });
    expect(body.data?.completedAt).toBeNull();
  });

  it('PUT 进度 1.5 → 400（越界必须在这一层被拒）', async () => {
    const response = await request('/reading-progress', {
      method: 'PUT',
      body: JSON.stringify({ resourceType: 'CONTENT', resourceId: '100', progress: 1.5 }),
    });
    expect(response.status).toBe(400);
  });

  it('⚠ PUT 不支持的 resourceType → 400 且是**专门的码**（F1 的 HTTP 级守卫）', async () => {
    const response = await request('/reading-progress', {
      method: 'PUT',
      body: JSON.stringify({ resourceType: 'EPISODE', resourceId: '100', progress: 0.5 }),
    });
    expect(response.status).toBe(400);

    const body = (await response.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('READING_RESOURCE_TYPE_UNSUPPORTED');
  });

  it('PUT 不可见的内容 → 404', async () => {
    const response = await request('/reading-progress', {
      method: 'PUT',
      body: JSON.stringify({ resourceType: 'CONTENT', resourceId: '999', progress: 0.5 }),
    });
    expect(response.status).toBe(404);
  });
});

/* ------------------------------------------------------------------ */
/* 阅读偏好                                                            */
/* ------------------------------------------------------------------ */

describe('阅读偏好 —— 真 HTTP', () => {
  it('GET → 200，且**行不存在时返回默认值**（不是 404）', async () => {
    const response = await request('/me/preferences', { method: 'GET' });
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      data?: { theme?: string; articleFontSize?: string; defaultTranslation?: boolean };
    };
    expect(body.data).toMatchObject({
      theme: 'SYSTEM',
      articleFontSize: 'DEFAULT',
      defaultTranslation: false,
    });
  });

  it('PUT 部分更新 → 200，未提供的字段不动', async () => {
    await request('/me/preferences', {
      method: 'PUT',
      body: JSON.stringify({ articleFontSize: 'LARGE' }),
    });

    const response = await request('/me/preferences', {
      method: 'PUT',
      body: JSON.stringify({ theme: 'DARK' }),
    });
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      data?: { theme?: string; articleFontSize?: string };
    };
    expect(body.data).toMatchObject({ theme: 'DARK', articleFontSize: 'LARGE' });
  });

  it('PUT 未知字段 → 400（不是静默忽略）', async () => {
    const response = await request('/me/preferences', {
      method: 'PUT',
      body: JSON.stringify({ articleFontsize: 'LARGE' }),
    });
    expect(response.status).toBe(400);
  });

  it('PUT 空体 → 400', async () => {
    const response = await request('/me/preferences', { method: 'PUT', body: '{}' });
    expect(response.status).toBe(400);
  });

  it('PUT `defaultTranslation: false` → 真的写进去（不被当成「没给」）', async () => {
    await request('/me/preferences', {
      method: 'PUT',
      body: JSON.stringify({ defaultTranslation: true }),
    });
    const response = await request('/me/preferences', {
      method: 'PUT',
      body: JSON.stringify({ defaultTranslation: false }),
    });

    expect(
      ((await response.json()) as { data: { defaultTranslation: boolean } }).data,
    ).toMatchObject({ defaultTranslation: false });
  });
});
