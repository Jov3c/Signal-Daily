/**
 * 健康检查的真库集成测试 —— **真实 MySQL 8.4 + 真实 Redis**。
 *
 * 运行：
 *
 * ```bash
 * REDIS_URL=redis://127.0.0.1:6390 pnpm --filter @signal/api test:integration
 * ```
 *
 * ── 这个文件要证明的，是桩证明不了的那几件事 ────────────────────────
 *
 * | # | 断言                                          | 桩为什么不行 |
 * | - | --------------------------------------------- | ------------ |
 * | 1 | 真 PrismaClient 上探针返回 up                  | 桩永远返回 up，`SELECT 1` 有没有真的发出去没人知道 |
 * | 2 | 真 ioredis 上探针返回 up                       | 同上 |
 * | 3 | **第一次** `ping()` 就成功                     | 见 `redis-client.ts` 的 `enableOfflineQueue` 说明 —— 这是一个只在「新建连接的第一个命令」上出现的坑 |
 * | 4 | MySQL 真的连不上时返回 down 且**不抛**          | 桩不会给出 ECONNREFUSED/P1001 这些真实错误形态 |
 * | 5 | Redis 真的连不上时返回 down 且**不抛**          | 同上 |
 * | 6 | 一个依赖挂掉时，另一个的结果**照常出现在响应里** | 需要真实 HTTP + 真实 MySQL 同时成立 |
 *
 * 不静默跳过：连不上库/Redis 就直接失败（与 Agent 01 / 10 的集成测试同一约定）。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import type { Redis } from 'ioredis';
import { applyApiPrefix } from '../src/bootstrap';
import { createLogger } from '@signal/logger';
import { TEST_ENV } from '@signal/test-utils';
import { APP_LOGGER } from '../src/common/logger/app-logger';
import { HEALTH_REDIS_CLIENT, HealthModule } from '../src/modules/health/module';
import { HEALTH_READY_PATH } from '../src/modules/health/routes';
import {
  createMysqlProbe,
  createRedisProbe,
  type SqlPinger,
} from '../src/modules/health/probes';
import { createHealthRedisClient } from '../src/modules/health/redis-client';

/**
 * 与 `module.ts` 里装配的那一行**逐字相同**的 pinger。
 *
 * ⚠ 刻意在测试里重写一遍而不是从模块里 import：`module.ts` 的实现绑定在
 * Nest 的 provider 工厂上，脱离容器取不出来。代价是「两处 `SELECT 1`
 * 可能漂移」—— 那由第三组用例（真 HTTP 走真实 `HealthModule`）兜底，
 * 那条路径用的是生产实现。
 */
function pingerOf(prisma: PrismaClient): SqlPinger {
  return { ping: () => prisma.$queryRaw`SELECT 1` };
}

/** 从环境变量或仓库根 `.env` 取连接串（与其它集成测试同一约定）。 */
function resolveEnv(name: string, fallbackFromDotEnv: boolean): string {
  const fromEnv = process.env[name];
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;

  const envPath = fileURLToPath(new URL('../../../.env', import.meta.url));
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const match = new RegExp(`^${name}=(.*)$`).exec(line.trim());
    if (match?.[1] !== undefined) {
      if (!fallbackFromDotEnv) {
        throw new Error(
          `${name} 必须由环境变量显式给出（仓库 .env 里的值是本机默认，不一定是测试实例）。` +
            `\n用法：REDIS_URL=redis://127.0.0.1:6390 pnpm --filter @signal/api test:integration`,
        );
      }
      return match[1].trim();
    }
  }
  throw new Error(`${name} is not set and could not be read from the repository .env`);
}

const DATABASE_URL = resolveEnv('DATABASE_URL', true);
const REDIS_URL = resolveEnv('REDIS_URL', false);

/** 一个**必然连不上**的地址：端口 1 上不会有我们的服务。 */
const UNREACHABLE_MYSQL = 'mysql://signal:signal@127.0.0.1:1/signal';
const UNREACHABLE_REDIS = 'redis://127.0.0.1:1';

beforeAll(() => {
  for (const [key, value] of Object.entries(TEST_ENV)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
  process.env.DATABASE_URL = DATABASE_URL;
  process.env.REDIS_URL = REDIS_URL;
});

/* ------------------------------------------------------------------ */
/* 1 / 2. 真实依赖上探针返回 up                                         */
/* ------------------------------------------------------------------ */

describe('真 MySQL / 真 Redis 上，两条探针都返回 up', () => {
  const prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
  let redis: Redis;

  beforeAll(async () => {
    redis = createHealthRedisClient(REDIS_URL, () => undefined);
    // 先确认这个测试实例本身是活的 —— 否则下面的 up 断言只是在证明
    // 「碰巧两个都挂了所以都没抛」。
    await prisma.$queryRaw`SELECT 1`;
  });

  afterAll(async () => {
    await redis.quit().catch(() => undefined);
    await prisma.$disconnect();
  });

  it('MySQL 探针 → up（真的发出了查询）', async () => {
    const probe = createMysqlProbe(pingerOf(prisma));
    expect(probe.dependency).toBe('mysql');
    expect(await probe.probe()).toEqual({ status: 'up' });
  });

  it('Redis 探针 → up（真的收到了 PONG）', async () => {
    const probe = createRedisProbe(redis);
    expect(probe.dependency).toBe('redis');
    expect(await probe.probe()).toEqual({ status: 'up' });
  });

  /**
   * ⚠ **这是本文件里最要紧的一条。**
   *
   * `redis-client.ts` 里 `enableOfflineQueue` 必须是 `true`：直觉会写成
   * `false`（「探针不该排队」），但 `lazyConnect: true` 下 ioredis 的
   * `connect()` 是异步的，第一个命令执行到可写性判定时连接状态一定是
   * `connecting` —— 于是 `false` 会让**健康 Redis 上的第一个探针**也报 down。
   * 表现是「容器起来后的第一次 healthcheck 是红的，重启一次就好了」。
   *
   * 所以这里用一条**从未发过命令**的新连接，断言它的第一次 `ping()` 成功。
   * 把 `enableOfflineQueue` 改回 `false`，这条会红。
   */
  it('⚠ 全新连接的**第一个** ping() 就成功（enableOfflineQueue 的回归守卫）', async () => {
    const fresh = createHealthRedisClient(REDIS_URL, () => undefined);
    try {
      expect(fresh.status).not.toBe('ready'); // 懒连接：此刻还没连
      await expect(fresh.ping()).resolves.toBe('PONG');
    } finally {
      await fresh.quit().catch(() => undefined);
    }
  });
});

/* ------------------------------------------------------------------ */
/* 4 / 5. 真实不可达时返回 down，而不是抛                                */
/* ------------------------------------------------------------------ */

describe('⚠ 依赖不可达时探针返回 down（不抛、不挂死）', () => {
  it('MySQL 指向坏端口 → down / UNREACHABLE，且不抛异常', async () => {
    const broken = new PrismaClient({ datasources: { db: { url: UNREACHABLE_MYSQL } } });
    try {
      const probe = createMysqlProbe(pingerOf(broken));
      const startedAt = Date.now();
      const result = await probe.probe();
      const elapsed = Date.now() - startedAt;

      // ⚠ 原因必须是 UNREACHABLE 而不是笼统的 ERROR：`classifyFailure` 认的是
      // Prisma 的 `PrismaClientInitializationError` + "Can't reach database server"。
      // 这条同时钉住了 `PROBE_TIMEOUT_MS = 3000` 的选值理由 ——
      // 实测这次失败约 2050ms，预算若回到 2000，服务层就会把它盖成 TIMEOUT。
      expect(result).toEqual({ status: 'down', reason: 'UNREACHABLE' });
      expect(elapsed).toBeLessThan(3000);
    } finally {
      await broken.$disconnect().catch(() => undefined);
    }
  });

  it('Redis 指向坏端口 → down / UNREACHABLE，且**很快**返回', async () => {
    const broken = createHealthRedisClient(UNREACHABLE_REDIS, () => undefined);
    try {
      const probe = createRedisProbe(broken);
      const startedAt = Date.now();
      const result = await probe.probe();
      const elapsed = Date.now() - startedAt;

      expect(result).toEqual({ status: 'down', reason: 'UNREACHABLE' });
      // 实测约 68ms（maxRetriesPerRequest=1 + connectTimeout=1s）。
      // 给足余量但远小于探针预算：如果哪天退化成「挂着重试」，
      // 这条会红，而不是等到 docker 报 healthcheck timeout 才发现。
      expect(elapsed).toBeLessThan(1500);
    } finally {
      // 坏连接上 quit() 也可能失败；这里只要求不留悬挂句柄。
      await broken.disconnect();
    }
  });
});

/* ------------------------------------------------------------------ */
/* 6. 真实 HTTP：一个依赖挂掉，另一个照常出现在响应里                    */
/* ------------------------------------------------------------------ */

describe('⚠ 真实 HTTP 上的 503：MySQL 照常 up，Redis 报 down', () => {
  let app: INestApplication;
  let baseUrl: string;
  /** 指向坏端口 —— 但 MySQL 是真的。 */
  let brokenRedis: Redis;

  beforeAll(async () => {
    brokenRedis = createHealthRedisClient(UNREACHABLE_REDIS, () => undefined);

    const moduleRef = await Test.createTestingModule({ imports: [HealthModule] })
      // 只换 Redis 连接（换成真的连不上的那一个）。
      // `PrismaService`、两条探针、`HealthService`、控制器**全部是真实实现**。
      .overrideProvider(HEALTH_REDIS_CLIENT)
      .useValue(brokenRedis)
      .overrideProvider(APP_LOGGER)
      .useValue(createLogger({ service: 'api', level: 'silent' }))
      .compile();

    app = moduleRef.createNestApplication({ logger: false });
    // 用生产的那份实现（`createApiApp` 也调它），不复制一行 setGlobalPrefix。
    applyApiPrefix(app);
    await app.listen(0);

    const address = app.getHttpServer().address() as { port: number };
    baseUrl = `http://127.0.0.1:${String(address.port)}`;
  });

  afterAll(async () => {
    await app.close();
    brokenRedis.disconnect();
  });

  it('GET /health/live 仍是 200（Redis 挂了不该让容器被重启）', async () => {
    const response = await fetch(`${baseUrl}/health/live`);
    expect(response.status).toBe(200);
  });

  it('GET /health/ready → 503，`mysql: up` 与 `redis: down` **同时**出现', async () => {
    const response = await fetch(`${baseUrl}/${HEALTH_READY_PATH}`);
    expect(response.status).toBe(503);

    const body = (await response.json()) as {
      status?: string;
      checks?: Record<string, { status?: string; reason?: string }>;
    };
    expect(body.status).toBe('error');
    // 这一条同时证明三件事：真 MySQL 的探针真的跑到了、真 Redis 的
    // 探针真的失败了、而且**没有短路**（否则 mysql 的结果不会出现）。
    expect(body.checks?.mysql).toEqual({ status: 'up' });
    expect(body.checks?.redis?.status).toBe('down');
    expect(['UNREACHABLE', 'TIMEOUT', 'ERROR']).toContain(body.checks?.redis?.reason);
  });
});
