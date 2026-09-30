/**
 * `admin-ops` 三条只读视图 + 通知已读的**真 HTTP** 测试。
 *
 * ── 这里换掉了什么、留下了什么 ──────────────────────────────────────
 * 换掉的只有**外部世界**：
 *
 * ```text
 * ACCESS_TOKEN_VERIFIER / AUTH_SESSION_LOOKUP   这个 token 属于谁（Agent 02 的两个端口）
 * ADMIN_OPS_REPOSITORY                          数据库（换成内存假实现）
 * ADMIN_OPS_CLOCK                               「现在几点」（固定成 2026-09-30）
 * PrismaService                                 不连库
 * ```
 *
 * 留下的是真的：真的 `AdminGuard` / `AdminOriginGuard`、真的控制器、
 * 真的 DTO 解析、真的服务层、真的 `AppErrorFilter`、真的 HTTP 栈。
 *
 * ⚠ **`compile()` + `listen()` 会实例化全部 provider**，所以这个文件
 * 顺带覆盖了那个「模块能编译、能过全部单测，一挂进根模块就启动即崩」的
 * 缺陷类型（Agent 08 实测踩过）：`ADMIN_ORIGIN_CONFIG` 一旦漏提供，
 * 这个文件的 beforeAll 就会炸，而不是等到生产启动。
 *
 * 假仓储**记录**收到的查询，这样「筛选条件真的传下去了吗」也能验 ——
 * 只断言响应形状的话，一个把所有筛选都忽略的实现照样是绿的。
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import {
  API_PREFIX,
  AiRunStatus,
  AiTaskType,
  JobRunStatus,
  UserRole,
  UserStatus,
} from '@signal/contracts';
import { TEST_ENV } from '@signal/test-utils';
import {
  ACCESS_TOKEN_VERIFIER,
  AUTH_SESSION_LOOKUP,
  type AccessTokenClaims,
  type AuthenticatedSession,
} from '../src/common/guards';
import { PrismaService } from '../src/common/prisma/prisma.service';
import {
  ADMIN_ORIGIN_CONFIG,
  createAdminOriginConfig,
} from '../src/modules/admin-review/admin-origin.guard';
import { AdminOpsModule } from '../src/modules/admin-ops/module';
import {
  ADMIN_OPS_REPOSITORY,
  type AdminAiRun,
  type AdminJobRun,
  type AdminNotification,
  type AdminOpsRepository,
  type AiUsageGroupRow,
  type AiUsageRollup,
  type AiUsageWindow,
  type JobRunListQuery,
  type NotificationListQuery,
} from '../src/modules/admin-ops/repository';
import { ADMIN_OPS_CLOCK, type AiUsageView } from '../src/modules/admin-ops/service';

beforeAll(() => {
  for (const [key, value] of Object.entries(TEST_ENV)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
});

const ADMIN_ID = '7';
const USER_ID = '42';
const TOKEN_ADMIN = 'admin-token';
const TOKEN_USER = 'user-token';
const ALLOWED_ORIGIN = 'http://localhost:3000';

/* ------------------------------------------------------------------ */
/* 内存假仓储                                                          */
/* ------------------------------------------------------------------ */

const ROLLUP: AiUsageRollup = {
  runs: 10,
  failedRuns: 2,
  inputTokens: 1000,
  outputTokens: 500,
  estimatedCostUsd: 0.42,
};

function jobRun(id: string, status: JobRunStatus, jobType: string): AdminJobRun {
  return {
    id,
    jobType,
    jobKey: `key-${id}`,
    status,
    startedAt: '2026-09-30T01:00:00.000Z',
    finishedAt: status === JobRunStatus.RUNNING ? null : '2026-09-30T01:00:05.000Z',
    durationMs: status === JobRunStatus.RUNNING ? null : 5000,
    attempts: 1,
    errorCode: status === JobRunStatus.FAILED ? 'E_BOOM' : null,
    metadata: null,
  };
}

class FakeRepository implements AdminOpsRepository {
  readonly jobQueries: JobRunListQuery[] = [];
  readonly notificationQueries: NotificationListQuery[] = [];
  /** 总量查询收到的窗口（一次）。 */
  readonly aiWindows: AiUsageWindow[] = [];
  /** 按**业务日**逐天查询收到的窗口（`days` 个）。 */
  readonly aiDayWindows: AiUsageWindow[] = [];
  /** 通知的当前状态（用来验「已读是幂等的」）。 */
  readonly readAtById = new Map<string, string | null>();

  jobRuns: AdminJobRun[] = [
    jobRun('3', JobRunStatus.FAILED, 'ai.score'),
    jobRun('2', JobRunStatus.RUNNING, 'collector.fetch'),
    jobRun('1', JobRunStatus.SUCCEEDED, 'collector.fetch'),
  ];

  notifications: AdminNotification[] = [
    {
      id: '11',
      type: 'HIGH_SCORE_CONTENT',
      title: '高分候选',
      body: '有一条内容分数很高',
      targetUrl: '/admin/review/99',
      status: 'UNREAD',
      emailStatus: 'SENT',
      createdAt: '2026-09-30T02:00:00.000Z',
      readAt: null,
    },
  ];

  async listJobRuns(query: JobRunListQuery): Promise<{ data: AdminJobRun[]; total: number }> {
    this.jobQueries.push(query);
    let rows = this.jobRuns;
    if (query.jobType !== undefined) rows = rows.filter((row) => row.jobType === query.jobType);
    if (query.status !== undefined) rows = rows.filter((row) => row.status === query.status);
    return { data: rows, total: rows.length };
  }

  async listNotifications(
    query: NotificationListQuery,
  ): Promise<{ data: AdminNotification[]; total: number }> {
    this.notificationQueries.push(query);
    let rows = this.notifications;
    if (query.status !== undefined) rows = rows.filter((row) => row.status === query.status);
    return { data: rows, total: rows.length };
  }

  async findNotification(id: string): Promise<AdminNotification | null> {
    const row = this.notifications.find((candidate) => candidate.id === id);
    if (row === undefined) return null;
    return { ...row, readAt: this.readAtById.get(id) ?? row.readAt };
  }

  async markNotificationRead(id: string, readAt: Date): Promise<AdminNotification | null> {
    const row = await this.findNotification(id);
    if (row === null) return null;
    // 幂等：已读的不改写 readAt —— 与真实实现同一语义。
    if (row.readAt === null) this.readAtById.set(id, readAt.toISOString());
    return { ...row, status: 'READ', readAt: this.readAtById.get(id) ?? null };
  }

  async aiUsageTotals(window: AiUsageWindow): Promise<AiUsageRollup> {
    this.aiWindows.push(window);
    return ROLLUP;
  }

  async aiUsageByTaskType(): Promise<AiUsageGroupRow[]> {
    return [{ key: AiTaskType.SCORE, ...ROLLUP }];
  }

  async aiUsageByModel(): Promise<AiUsageGroupRow[]> {
    return [{ key: 'claude-sonnet-5-5', ...ROLLUP }];
  }

  async aiUsageForWindow(window: AiUsageWindow): Promise<AiUsageRollup> {
    this.aiDayWindows.push(window);
    return ROLLUP;
  }

  async aiUsageRecent(): Promise<AdminAiRun[]> {
    return [
      {
        id: '1',
        contentId: '99',
        taskType: AiTaskType.SCORE,
        provider: 'openai-compatible',
        model: 'claude-sonnet-5-5',
        promptVersion: 'v1',
        status: AiRunStatus.SUCCEEDED,
        inputTokens: 100,
        outputTokens: 50,
        estimatedCostUsd: 0.01,
        durationMs: 900,
        errorCode: null,
        createdAt: '2026-09-30T01:30:00.000Z',
      },
    ];
  }
}

/* ------------------------------------------------------------------ */

/** 固定时钟：北京时间 2026-09-30 11:00。 */
const NOW = new Date('2026-09-30T03:00:00.000Z');
const TODAY = '2026-09-30';

let app: INestApplication;
let baseUrl: string;
let repository: FakeRepository;

async function request(
  path: string,
  init: RequestInit & { token?: string | null } = {},
): Promise<Response> {
  const { token, ...rest } = init;
  const authToken = token === undefined ? TOKEN_ADMIN : token;
  return fetch(`${baseUrl}${API_PREFIX}${path}`, {
    ...rest,
    headers: {
      'content-type': 'application/json',
      ...(authToken === null ? {} : { authorization: `Bearer ${authToken}` }),
      ...(rest.headers ?? {}),
    },
  });
}

beforeAll(async () => {
  repository = new FakeRepository();

  const moduleRef = await Test.createTestingModule({ imports: [AdminOpsModule] })
    .overrideProvider(ACCESS_TOKEN_VERIFIER)
    .useValue({
      verifyAccessToken: (token: string): AccessTokenClaims => {
        if (token === TOKEN_ADMIN) {
          return { userId: ADMIN_ID, sessionId: 'session-admin', role: UserRole.ADMIN };
        }
        return { userId: USER_ID, sessionId: 'session-user', role: UserRole.USER };
      },
    })
    .overrideProvider(AUTH_SESSION_LOOKUP)
    .useValue({
      // ⚠ 参数是 **sessionId**（不是 token）—— 端口按会话查，「会话是否仍有效」
      // 与「用户当前的角色 / 状态」一次拿到，所以登出 / 撤权立刻生效。
      // 第一版按 token 比对，于是所有「管理员」请求都拿到了 USER 会话，
      // 令牌里的角色快照与库里的不一致 → 401（不是 403）。
      findAuthenticatedSession: async (sessionId: string): Promise<AuthenticatedSession> => {
        const isAdmin = sessionId === 'session-admin';
        return {
          sessionId,
          userId: isAdmin ? ADMIN_ID : USER_ID,
          role: isAdmin ? UserRole.ADMIN : UserRole.USER,
          status: UserStatus.ACTIVE,
        };
      },
    })
    .overrideProvider(PrismaService)
    .useValue({})
    .overrideProvider(ADMIN_OPS_REPOSITORY)
    .useValue(repository)
    .overrideProvider(ADMIN_OPS_CLOCK)
    .useValue({ now: () => NOW })
    .overrideProvider(ADMIN_ORIGIN_CONFIG)
    .useValue(
      createAdminOriginConfig({ APP_BASE_URL: ALLOWED_ORIGIN, API_BASE_URL: ALLOWED_ORIGIN }),
    )
    .compile();

  app = moduleRef.createNestApplication({ logger: false });
  app.setGlobalPrefix(API_PREFIX.slice(1));
  await app.listen(0);

  const address = app.getHttpServer().address() as { port: number };
  baseUrl = `http://127.0.0.1:${String(address.port)}`;
});

afterAll(async () => {
  await app.close();
});

/* ------------------------------------------------------------------ */
/* 鉴权                                                                */
/* ------------------------------------------------------------------ */

describe('⚠ 三条只读接口与一个已读动作，全部要 ADMIN', () => {
  const ROUTES: { method: string; path: string }[] = [
    { method: 'GET', path: '/admin/jobs' },
    { method: 'GET', path: '/admin/notifications' },
    { method: 'POST', path: '/admin/notifications/11/read' },
    { method: 'GET', path: '/admin/ai-usage' },
  ];

  for (const route of ROUTES) {
    it(`${route.method} ${route.path} → 匿名 401`, async () => {
      const response = await request(route.path, { method: route.method, token: null });
      expect(response.status).toBe(401);
    });

    it(`${route.method} ${route.path} → 普通用户 403`, async () => {
      const response = await request(route.path, { method: route.method, token: TOKEN_USER });
      expect(response.status).toBe(403);
    });
  }

  it('跨源的本站变更请求被拒（Origin 不是允许列表里的）', async () => {
    const response = await request('/admin/notifications/11/read', {
      method: 'POST',
      headers: { origin: 'https://evil.example.com' },
    });
    expect(response.status).toBe(403);
    const body = (await response.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('FORBIDDEN');
  });

  it('同源的变更请求放行（否则后台自己都用不了）', async () => {
    const response = await request('/admin/notifications/11/read', {
      method: 'POST',
      headers: { origin: ALLOWED_ORIGIN },
    });
    expect(response.status).toBe(200);
  });

  it('不带 Origin 的变更请求放行（服务端工具没有 Origin）', async () => {
    const response = await request('/admin/notifications/11/read', { method: 'POST' });
    expect(response.status).toBe(200);
  });
});

/* ------------------------------------------------------------------ */
/* Jobs                                                                */
/* ------------------------------------------------------------------ */

describe('GET /admin/jobs', () => {
  it('返回 `{data, meta}` 偏移分页封套', async () => {
    const response = await request('/admin/jobs');
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      data?: AdminJobRun[];
      meta?: { page: number; pageSize: number; total: number; totalPages: number };
    };
    expect(body.data).toHaveLength(3);
    expect(body.meta).toEqual({ page: 1, pageSize: 20, total: 3, totalPages: 1 });
  });

  it('⚠ 筛选条件真的传到了仓储（不是「响应形状对就算过」）', async () => {
    repository.jobQueries.length = 0;
    await request(`/admin/jobs?jobType=collector.fetch&status=${JobRunStatus.SUCCEEDED}`);

    expect(repository.jobQueries).toHaveLength(1);
    expect(repository.jobQueries[0]).toMatchObject({
      jobType: 'collector.fetch',
      status: JobRunStatus.SUCCEEDED,
    });
  });

  it('pageSize 超上限被夹到 100（**不** 400）', async () => {
    repository.jobQueries.length = 0;
    await request('/admin/jobs?pageSize=9999&page=2');
    expect(repository.jobQueries[0]).toMatchObject({ page: 2, pageSize: 100 });
  });

  it('非法 status → 400 且 `details.fields` 说明是哪一项', async () => {
    const response = await request('/admin/jobs?status=SUCCESS');
    expect(response.status).toBe(400);

    const body = (await response.json()) as {
      error?: { code?: string; details?: { fields?: string[] } };
    };
    expect(body.error?.code).toBe('VALIDATION_FAILED');
    expect(body.error?.details?.fields?.[0]).toContain('status');
  });

  it('失败与运行中的作业不显示成 0 毫秒（`durationMs` 为 null）', async () => {
    const body = (await (await request('/admin/jobs')).json()) as { data: AdminJobRun[] };
    const running = body.data.find((row) => row.status === JobRunStatus.RUNNING);
    expect(running?.durationMs).toBeNull();
    expect(running?.finishedAt).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* Notifications                                                       */
/* ------------------------------------------------------------------ */

describe('GET /admin/notifications 与已读', () => {
  it('列表带上分页封套与未读状态', async () => {
    const body = (await (await request('/admin/notifications')).json()) as {
      data: AdminNotification[];
    };
    expect(body.data[0]?.status).toBe('UNREAD');
    expect(body.data[0]?.targetUrl).toBe('/admin/review/99');
  });

  it('status 筛选传到仓储', async () => {
    repository.notificationQueries.length = 0;
    await request('/admin/notifications?status=UNREAD');
    expect(repository.notificationQueries[0]).toMatchObject({ status: 'UNREAD' });
  });

  it('非法 status → 400', async () => {
    expect((await request('/admin/notifications?status=ARCHIVED')).status).toBe(400);
  });

  it('标记已读 → 200，返回改过的行', async () => {
    const response = await request('/admin/notifications/11/read', { method: 'POST' });
    expect(response.status).toBe(200);

    const body = (await response.json()) as { data?: AdminNotification };
    expect(body.data?.status).toBe('READ');
    expect(body.data?.readAt).toBe(NOW.toISOString());
  });

  it('⚠ 幂等：再点一次**不改写** `readAt`（否则「什么时候读的」就失真了）', async () => {
    repository.readAtById.clear();

    const first = (await (
      await request('/admin/notifications/11/read', { method: 'POST' })
    ).json()) as { data?: AdminNotification };
    const second = (await (
      await request('/admin/notifications/11/read', { method: 'POST' })
    ).json()) as { data?: AdminNotification };

    expect(second.data?.status).toBe('READ');
    expect(second.data?.readAt).toBe(first.data?.readAt);
  });

  it('不存在 → 404（不是 500）', async () => {
    expect((await request('/admin/notifications/777/read', { method: 'POST' })).status).toBe(404);
  });

  it('非数字 id → 404', async () => {
    expect((await request('/admin/notifications/abc/read', { method: 'POST' })).status).toBe(404);
  });

  it('⚠ 超出 BIGINT 上界的 id → 404，而不是 500（直接绑进 SQL 会抛）', async () => {
    const response = await request('/admin/notifications/99999999999999999999999999/read', {
      method: 'POST',
    });
    expect(response.status).toBe(404);
  });

  it('404 的响应体不回显请求里的 id', async () => {
    const response = await request('/admin/notifications/abc/read', { method: 'POST' });
    const raw = await response.text();
    expect(raw).not.toContain('abc');
  });
});

/* ------------------------------------------------------------------ */
/* AI Usage                                                            */
/* ------------------------------------------------------------------ */

describe('GET /admin/ai-usage', () => {
  it('默认窗口 14 天，且按业务日升序、最后一天是今天', async () => {
    const body = (await (await request('/admin/ai-usage')).json()) as { data: AiUsageView };
    const view = body.data;

    expect(view.window.days).toBe(14);
    expect(view.window.to).toBe(TODAY);
    expect(view.window.from).toBe('2026-09-17');
    expect(view.window.timezone).toBe('Asia/Shanghai');

    expect(view.daily).toHaveLength(14);
    const dates = view.daily.map((row) => row.businessDate);
    expect([...dates].sort()).toEqual(dates);
    expect(dates[dates.length - 1]).toBe(TODAY);
  });

  it('`days` 生效，且**每个业务日各一条**聚合（不是一条 GROUP BY）', async () => {
    repository.aiDayWindows.length = 0;
    const body = (await (await request('/admin/ai-usage?days=3')).json()) as { data: AiUsageView };

    expect(body.data.daily).toHaveLength(3);
    expect(body.data.daily.map((row) => row.businessDate)).toEqual([
      '2026-09-28',
      '2026-09-29',
      '2026-09-30',
    ]);
    // 每天一次 —— 这是「时区换算只有 @signal/config 一个真源」的代价，
    // 见 service.ts 的文件头。数字对不上说明实现被改成了一条 SQL 或被合并了。
    expect(repository.aiDayWindows).toHaveLength(3);
    for (const window of repository.aiDayWindows) {
      expect(window.toUtc.getTime() - window.fromUtc.getTime()).toBe(24 * 60 * 60 * 1000);
    }
  });

  it('⚠ 相邻两天的窗口**首尾相接**（半开区间，边界那一毫秒不会被算两次）', async () => {
    repository.aiDayWindows.length = 0;
    await request('/admin/ai-usage?days=3');

    const windows = [...repository.aiDayWindows].sort(
      (a, b) => a.fromUtc.getTime() - b.fromUtc.getTime(),
    );
    expect(windows).toHaveLength(3);
    for (let index = 0; index + 1 < windows.length; index += 1) {
      expect(windows[index]?.toUtc.toISOString()).toBe(windows[index + 1]?.fromUtc.toISOString());
    }
  });

  it('总量 / 分组 / 最近调用都在同一个响应里', async () => {
    const body = (await (await request('/admin/ai-usage')).json()) as { data: AiUsageView };
    expect(body.data.totals.runs).toBe(10);
    expect(body.data.totals.failedRuns).toBe(2);
    expect(body.data.byTaskType[0]?.key).toBe(AiTaskType.SCORE);
    expect(body.data.byModel[0]?.key).toBe('claude-sonnet-5-5');
    expect(body.data.recent[0]?.contentId).toBe('99');
  });

  it('days 超过上限被夹到 30', async () => {
    const body = (await (await request('/admin/ai-usage?days=365')).json()) as {
      data: AiUsageView;
    };
    expect(body.data.window.days).toBe(30);
    expect(body.data.daily).toHaveLength(30);
  });
});
