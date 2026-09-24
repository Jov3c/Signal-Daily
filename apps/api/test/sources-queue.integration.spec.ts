/**
 * 入队集成测试 —— **真实 Redis + 真实 BullMQ**。
 *
 * 运行（需要一个可用的 Redis）：
 *   REDIS_URL=redis://127.0.0.1:6390 pnpm --filter @signal/api test:integration
 *
 * ── 为什么这条必须打真 Redis ────────────────────────────────────────
 * `fetch-now` 的整个价值就是「管理员点一下，采集任务真的进了 collector 队列」。
 * 如果只测内存替身，那么连接参数拼错、Job 名写错、队列名写错、
 * `jobId` 拼错这类问题**一个都不会被发现** —— 而它们恰好是
 * 「接口返回 202 但实际什么也没发生」的全部成因。
 *
 * 这里不碰 MySQL：仓储被换成内存替身（PrismaService 的连接是惰性的，
 * 不在 onModuleInit 里 connect），所以本文件只依赖 Redis。
 */

import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { Queue } from 'bullmq';
import { createLogger } from '@signal/logger';
import { API_PREFIX, JobId, JobName, QueueName, UserRole } from '@signal/contracts';
import { createMemoryStream } from '@signal/test-utils';
import { SourcesModule } from '../src/modules/sources/module';
import { SOURCE_CLOCK } from '../src/modules/sources/clock';
import { SOURCE_REPOSITORY } from '../src/modules/sources/repository';
import {
  BullSourceFetchEnqueuer,
  fetchWindow,
  redisConnectionOptions,
} from '../src/modules/sources/source-enqueuer';
import { SOURCE_TESTER, SOURCE_TESTER_DEPS } from '../src/modules/sources/source-tester';
import { SOURCE_CONFIG } from '../src/modules/sources/source.config';
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
  FakeSourceTester,
  InMemorySourceRepository,
} from './support/source-fakes';
import { createTestSourceConfig } from './support/sources-test-app';
import { cookieHeader, setCookies } from './support/test-app';
import type { INestApplication } from '@nestjs/common';

/* ------------------------------------------------------------------ */
/* 环境                                                                */
/* ------------------------------------------------------------------ */

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

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

/** 集成测试用的 Redis。默认指向临时实例，可用 REDIS_URL 覆盖。 */
const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6390';

/** 一个确定没人监听的端口，用来验证「Redis 挂了」的路径。 */
const DEAD_REDIS_URL = 'redis://127.0.0.1:6399';

const SLUG_PREFIX = `it-agent03q-${randomBytes(4).toString('hex')}`;
const ADMIN_EMAIL = `${SLUG_PREFIX}-admin@signal.test`;
const OTP_CODE = '424242';

let app: INestApplication;
let baseUrl: string;
let cookie: string;
let inspect: Queue;

const sources = new InMemorySourceRepository();
const userRepository = new InMemoryUserRepository();
const authRepository = new InMemoryAuthRepository();
const mail = new FakeMailSender();
authRepository.users = userRepository;

const clock = new FakeSourceClock();

/** 本次运行创建的任务 id —— 清理时精确删除，绝不清空整个队列。 */
const createdJobIds = new Set<string>();

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

async function createSource(): Promise<string> {
  const response = await request('/api/v1/admin/sources', {
    method: 'POST',
    body: JSON.stringify({
      name: '入队检查',
      slug: `${SLUG_PREFIX}-${sources.rows.size + 1}`,
      type: 'RSS',
      kind: 'MEDIA',
      feedUrl: 'https://example.com/feed.xml',
    }),
  });
  if (response.status !== 201) throw new Error(`建源失败：${response.status} ${await response.text()}`);
  return ((await response.json()) as { data: { id: string } }).data.id;
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [SourcesModule] })
    .overrideProvider(SOURCE_CONFIG)
    .useValue(createTestSourceConfig({ redisUrl: REDIS_URL }))
    .overrideProvider(SOURCE_REPOSITORY)
    .useValue(sources)
    .overrideProvider(SOURCE_TESTER)
    .useValue(new FakeSourceTester())
    .overrideProvider(SOURCE_TESTER_DEPS)
    .useValue({})
    .overrideProvider(SOURCE_CLOCK)
    .useValue(clock)
    // 刻意**不**覆盖 SOURCE_FETCH_ENQUEUER：要的就是真实的 BullMQ 实现。
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
    .useValue(
      createLogger({ service: 'api-it', level: 'silent', destination: createMemoryStream() }),
    )
    .overrideProvider(REDIS_CLIENT)
    .useValue({ eval: async () => [1, 1000], quit: async () => 'OK' })
    .compile();

  app = moduleRef.createNestApplication({ logger: false });
  app.setGlobalPrefix(API_PREFIX.slice(1));
  await app.listen(0, '127.0.0.1');
  baseUrl = await app.getUrl();

  // 一个独立的只读 Queue，用来**从真实 Redis 里读回**任务。
  inspect = new Queue(QueueName.COLLECTOR, { connection: redisConnectionOptions(REDIS_URL) });

  userRepository.seed({ email: ADMIN_EMAIL, role: UserRole.ADMIN });
  await request('/api/v1/auth/email/request-code', {
    method: 'POST',
    body: JSON.stringify({ email: ADMIN_EMAIL }),
  });
  const verify = await request('/api/v1/auth/email/verify', {
    method: 'POST',
    body: JSON.stringify({ email: ADMIN_EMAIL, code: mail.latestCode() }),
  });
  if (!verify.ok) throw new Error(`登录失败：${verify.status} ${await verify.text()}`);
  cookie = cookieHeader(setCookies(verify));
}, 60_000);

afterAll(async () => {
  // 只删本次运行明确创建过的任务，不清空整个队列（别的 Agent 可能也在用）。
  for (const jobId of createdJobIds) {
    const job = await inspect.getJob(jobId);
    await job?.remove();
  }
  await inspect.close();
  await app?.close();
}, 30_000);

/* ------------------------------------------------------------------ */
/* 测试                                                                */
/* ------------------------------------------------------------------ */

describe('fetch-now 真的把任务送进了 collector 队列', () => {
  it('HTTP 202 → Redis 里能读回同名同 JobId 的任务', async () => {
    const sourceId = await createSource();
    const response = await request(`/api/v1/admin/sources/${sourceId}/fetch-now`, {
      method: 'POST',
    });
    expect(response.status).toBe(202);

    const body = (await response.json()) as {
      data: { queue: string; jobName: string; jobId: string; window: string };
    };
    createdJobIds.add(body.data.jobId);

    // ★ 关键：不是断言响应体「说了什么」，而是去 Redis 里**真的读回来**。
    const job = await inspect.getJob(body.data.jobId);
    expect(job, `队列里找不到 JobId=${body.data.jobId} 的任务`).toBeDefined();
    expect(job?.name).toBe(JobName.COLLECTOR_FETCH_SOURCE);
    expect(job?.queueName).toBe(QueueName.COLLECTOR);
    expect(String(job?.id)).toBe(body.data.jobId);
  });

  it('任务载荷形状与 Agent 04 约定的一致', async () => {
    const sourceId = await createSource();
    await request(`/api/v1/admin/sources/${sourceId}/fetch-now`, { method: 'POST' });

    const expectedId = JobId.collectorFetchSource(sourceId, fetchWindow(clock.now()));
    createdJobIds.add(expectedId);
    const job = await inspect.getJob(expectedId);
    expect(job?.data).toEqual({
      sourceId,
      trigger: 'manual',
      requestedAt: clock.now().toISOString(),
    });
  });

  it('重试策略来自契约（collector：3 次指数退避）', async () => {
    const sourceId = await createSource();
    await request(`/api/v1/admin/sources/${sourceId}/fetch-now`, { method: 'POST' });

    const jobId = JobId.collectorFetchSource(sourceId, fetchWindow(clock.now()));
    createdJobIds.add(jobId);
    const job = await inspect.getJob(jobId);
    expect(job?.opts.attempts).toBe(3);
    expect(job?.opts.backoff).toMatchObject({ type: 'exponential' });
  });

  it('同一分钟内重复点「立即抓取」→ 队列里仍然只有 1 个任务（JobId 幂等）', async () => {
    const sourceId = await createSource();
    const window = fetchWindow(clock.now());
    const jobId = JobId.collectorFetchSource(sourceId, window);
    createdJobIds.add(jobId);

    const first = await request(`/api/v1/admin/sources/${sourceId}/fetch-now`, { method: 'POST' });
    clock.advanceSeconds(20);
    const second = await request(`/api/v1/admin/sources/${sourceId}/fetch-now`, { method: 'POST' });

    expect(first.status).toBe(202);
    expect(second.status).toBe(202);

    const jobs = await inspect.getJobs(['waiting', 'delayed', 'active', 'completed']);
    const matching = jobs.filter((job) => String(job.id) === jobId);
    expect(matching).toHaveLength(1);
  });
});

describe('Redis 不可用时的行为', () => {
  it('入队失败 → 503 SOURCE_ENQUEUE_FAILED，而不是静默返回「已入队」', async () => {
    // 直接构造一个指向死端口的入队器，并把等待上限压到 400ms ——
    // 否则 BullMQ 要求 `maxRetriesPerRequest: null`，ioredis 会**无限重试**，
    // 这个 promise 永远不会 settle（见 source-enqueuer.ts 的说明）。
    const enqueuer = new BullSourceFetchEnqueuer(
      createTestSourceConfig({ redisUrl: DEAD_REDIS_URL }),
      createLogger({ service: 'it', level: 'silent', destination: createMemoryStream() }),
      { timeoutMs: 400 },
    );

    await expect(enqueuer.enqueueFetchNow('1', new Date())).rejects.toMatchObject({
      code: 'SOURCE_ENQUEUE_FAILED',
      httpStatus: 503,
    });

    // 关闭也不能被无限重试卡住。
    await Promise.race([
      enqueuer.close(),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
  }, 20_000);

  it('对照组：同样的构造方式换成可用的 Redis 必须成功', async () => {
    // 没有这条，「Redis 不可用 → 503」的用例可能只是因为构造参数有问题而失败，
    // 那就变成了假绿。
    const enqueuer = new BullSourceFetchEnqueuer(
      createTestSourceConfig({ redisUrl: REDIS_URL }),
      createLogger({ service: 'it', level: 'silent', destination: createMemoryStream() }),
      { timeoutMs: 5_000 },
    );

    const at = new Date('2026-09-24T00:00:00.000Z');
    const result = await enqueuer.enqueueFetchNow('999999', at);
    expect(result.jobId).toBe(JobId.collectorFetchSource('999999', fetchWindow(at)));

    // 收尾：删掉自己造的那条记录，避免污染 Redis。
    const job = await inspect.getJob(result.jobId);
    await job?.remove();
    await enqueuer.close();
  }, 20_000);
});
