/**
 * 健康检查的**真 HTTP** 测试 + 跨产物一致性守卫。
 *
 * ── 为什么需要「跨产物一致性」这一整组 ──────────────────────────────
 * `/health/live` 与 `/health/ready` 这两条路径被写在**四个互不相干的地方**
 * （见 `src/modules/health/routes.ts` 的说明）：控制器装饰器、
 * `setGlobalPrefix` 的 `exclude`、`docker-compose.yml` 的 api healthcheck、
 * `scripts/ops/healthcheck.sh`。
 *
 * 任意一处写错的后果是同一种**只在部署后出现**的故障：容器永远
 * `starting`、`depends_on: service_healthy` 卡死、整机起不来 ——
 * 而 `pnpm test` 全绿，因为测试根本不读 compose。
 * 所以下面直接把 compose 与 shell 脚本的**字面量**读出来，与
 * **可执行的常量**比对，并且真的对那个路径发一次 HTTP。
 *
 * ── 为什么是真 HTTP 而不是读控制器元数据 ────────────────────────────
 * 本项目已两次栽在「只读元数据」的假绿上（Agent 06 的集成测试自己拼
 * 字面量、Agent 08 的 worker 持久化层零执行）。这里走真实 HTTP 栈：
 * 真的 `@Res`、真的响应序列化、真的 `AppErrorFilter` ——
 * 最后一条尤其重要，503 的**形状**完全取决于这个过滤器是否会介入。
 */

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { API_PREFIX } from '@signal/contracts';
import { createLogger } from '@signal/logger';
import { TEST_ENV, createMemoryStream, type MemoryLogStream } from '@signal/test-utils';
import { applyApiPrefix } from '../src/bootstrap';
import { APP_LOGGER } from '../src/common/logger/app-logger';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { HEALTH_REDIS_CLIENT, HealthModule } from '../src/modules/health/module';
import { HEALTH_LIVE_PATH, HEALTH_READY_PATH } from '../src/modules/health/routes';
import {
  PROBE_FAILURE_REASONS,
  READINESS_DEPENDENCIES,
  READINESS_PROBES,
  type ProbeResult,
  type ReadinessDependency,
  type ReadinessProbe,
} from '../src/modules/health/ports';
import { classifyFailure } from '../src/modules/health/probes';
import {
  HEALTH_PROBE_TIMEOUT_MS,
  PROBE_TIMEOUT_MS,
  assertProbesCoverDependencies,
} from '../src/modules/health/service';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

/** 测试用的探针超时：够短以验证超时分支，够长以避开 CI 抖动。 */
const TEST_TIMEOUT_MS = 300;

/**
 * ⚠ 先把 env 补齐（Agent 08 的同款测试踩过：worktree 里绿、合并到 main 后红）。
 */
beforeAll(() => {
  for (const [key, value] of Object.entries(TEST_ENV)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
});

/* ------------------------------------------------------------------ */
/* 可控探针                                                            */
/* ------------------------------------------------------------------ */

type ProbeMode = ProbeResult | 'HANG' | { throws: string };

type FakeProbe = {
  probe: ReadinessProbe;
  calls: () => number;
  set: (mode: ProbeMode) => void;
};

function makeProbe(dependency: ReadinessDependency): FakeProbe {
  const state: { mode: ProbeMode; calls: number } = { mode: { status: 'up' }, calls: 0 };

  const probe: ReadinessProbe = {
    dependency,
    async probe(): Promise<ProbeResult> {
      state.calls += 1;
      if (state.mode === 'HANG') return new Promise<ProbeResult>(() => undefined);
      if (typeof state.mode === 'object' && 'throws' in state.mode) {
        throw new Error(state.mode.throws);
      }
      return state.mode;
    },
  };

  return {
    probe,
    calls: () => state.calls,
    set: (mode) => {
      state.mode = mode;
    },
  };
}

const fakes = new Map<ReadinessDependency, FakeProbe>();
for (const dependency of READINESS_DEPENDENCIES) fakes.set(dependency, makeProbe(dependency));

function fakeOf(dependency: ReadinessDependency): FakeProbe {
  const fake = fakes.get(dependency);
  if (fake === undefined) throw new Error(`no fake for ${dependency}`);
  return fake;
}

/** 所有探针回到 up，并清空调用计数。 */
function resetProbes(): void {
  for (const fake of fakes.values()) fake.set({ status: 'up' });
}

let app: INestApplication;
let baseUrl: string;
let logStream: MemoryLogStream;

async function request(path: string): Promise<Response> {
  return fetch(`${baseUrl}${path}`);
}

/** 读 `/health/ready` 的 JSON 体。 */
async function readyBody(response: Response): Promise<{
  status?: string;
  checks?: Record<string, { status?: string; reason?: string }>;
  error?: unknown;
}> {
  return (await response.json()) as never;
}

beforeAll(async () => {
  logStream = createMemoryStream();

  const moduleRef = await Test.createTestingModule({ imports: [HealthModule] })
    // 只要换掉「外部世界」，本模块自己的 provider 全部是真实实现。
    .overrideProvider(HEALTH_REDIS_CLIENT)
    .useValue({ quit: async () => undefined })
    .overrideProvider(PrismaService)
    .useValue({})
    .overrideProvider(READINESS_PROBES)
    .useValue([...fakes.values()].map((fake) => fake.probe))
    .overrideProvider(HEALTH_PROBE_TIMEOUT_MS)
    .useValue(TEST_TIMEOUT_MS)
    .overrideProvider(APP_LOGGER)
    .useValue(createLogger({ service: 'api', destination: logStream }))
    .compile();

  app = moduleRef.createNestApplication({ logger: false });
  // ⚠ 调用**生产的那份实现**（`createApiApp` 内部也调它），不是复制一行
  // `setGlobalPrefix`。复制的话，`exclude` 被删掉时生产会坏而测试全绿 ——
  // 那正是本仓库反复栽过的「测试验自己那份副本」。
  applyApiPrefix(app);
  await app.listen(0);

  const address = app.getHttpServer().address() as { port: number };
  baseUrl = `http://127.0.0.1:${String(address.port)}`;
});

afterAll(async () => {
  await app.close();
});

/* ------------------------------------------------------------------ */
/* 1. 路由与状态码                                                      */
/* ------------------------------------------------------------------ */

describe('两条路由的真实 HTTP 行为', () => {
  it('GET /health/live → 200 + `{status:"ok", uptimeSeconds}`', async () => {
    resetProbes();
    const response = await request(`/${HEALTH_LIVE_PATH}`);
    expect(response.status).toBe(200);

    const body = (await response.json()) as { status?: string; uptimeSeconds?: number };
    expect(body.status).toBe('ok');
    expect(typeof body.uptimeSeconds).toBe('number');
    expect(body.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });

  it('GET /health/ready（两个依赖都 up）→ 200 + 逐项 checks', async () => {
    resetProbes();
    const response = await request(`/${HEALTH_READY_PATH}`);
    expect(response.status).toBe(200);

    const body = await readyBody(response);
    expect(body.status).toBe('ok');
    expect(body.checks).toEqual({ mysql: { status: 'up' }, redis: { status: 'up' } });
  });

  it('GET /health/ready（mysql down）→ 503，且**仍然报出 redis**（不短路）', async () => {
    resetProbes();
    fakeOf('mysql').set({ status: 'down', reason: 'UNREACHABLE' });

    const response = await request(`/${HEALTH_READY_PATH}`);
    expect(response.status).toBe(503);

    const body = await readyBody(response);
    expect(body.status).toBe('error');
    expect(body.checks?.mysql).toEqual({ status: 'down', reason: 'UNREACHABLE' });
    // ⚠ 这条才是重点：redis 的结果**还在**。
    // 短路实现会把第二个故障藏到第一个修好之后才暴露。
    expect(body.checks?.redis).toEqual({ status: 'up' });
  });

  it('两个都 down → 503，两个原因都在', async () => {
    resetProbes();
    fakeOf('mysql').set({ status: 'down', reason: 'TIMEOUT' });
    fakeOf('redis').set({ status: 'down', reason: 'UNREACHABLE' });

    const body = await readyBody(await request(`/${HEALTH_READY_PATH}`));
    expect(body.checks).toEqual({
      mysql: { status: 'down', reason: 'TIMEOUT' },
      redis: { status: 'down', reason: 'UNREACHABLE' },
    });
  });

  it('两个端点都带 `Cache-Control: no-store`（被缓存的 200 会冒充健康）', async () => {
    resetProbes();
    for (const path of [HEALTH_LIVE_PATH, HEALTH_READY_PATH]) {
      const response = await request(`/${path}`);
      expect(response.headers.get('cache-control'), path).toBe('no-store');
    }
  });

  it('`/health/*` 下的未知子路径仍是 404（没有通配兜底）', async () => {
    const response = await request('/health/__nope__');
    expect(response.status).toBe(404);
  });
});

/* ------------------------------------------------------------------ */
/* 2. 全局前缀的 exclude                                                */
/* ------------------------------------------------------------------ */

describe('⚠ health 在 `/api/v1` **之外**（Agent 00 的 exclude 要求）', () => {
  it(`${API_PREFIX}/${HEALTH_READY_PATH} 是 404 —— 证明 exclude 生效，而不是两处都注册`, async () => {
    resetProbes();
    const response = await request(`${API_PREFIX}/${HEALTH_READY_PATH}`);
    expect(response.status).toBe(404);
  });

  it(`同一条路由在根路径上是 200 —— 404 不是「路由不存在」的假象`, async () => {
    resetProbes();
    expect((await request(`/${HEALTH_READY_PATH}`)).status).toBe(200);
  });
});

/* ------------------------------------------------------------------ */
/* 3. live 绝不碰依赖                                                   */
/* ------------------------------------------------------------------ */

describe('⚠ live 不查任何依赖（分不开就失去了两个端点的意义）', () => {
  it('两个依赖都 down 时 live 仍 200，且探针**一次都没被调用**', async () => {
    resetProbes();
    fakeOf('mysql').set({ status: 'down', reason: 'UNREACHABLE' });
    fakeOf('redis').set({ status: 'down', reason: 'UNREACHABLE' });

    const before = [...fakes.values()].map((fake) => fake.calls());
    const response = await request(`/${HEALTH_LIVE_PATH}`);
    const after = [...fakes.values()].map((fake) => fake.calls());

    expect(response.status).toBe(200);
    // 若 live 顺手查了依赖，一次 MySQL 抖动会让所有 api 容器被反复重启 ——
    // 而重启并不会让 MySQL 更快恢复。
    expect(after).toEqual(before);
  });
});

/* ------------------------------------------------------------------ */
/* 4. 503 不是错误封套                                                  */
/* ------------------------------------------------------------------ */

describe('⚠ 503 走 `@Res` 而不是 throw（否则 AppErrorFilter 会吃掉 checks）', () => {
  it('503 的响应体里有 checks，**没有** error 封套', async () => {
    resetProbes();
    fakeOf('redis').set({ status: 'down', reason: 'UNREACHABLE' });

    const body = await readyBody(await request(`/${HEALTH_READY_PATH}`));
    expect(body.checks).toBeDefined();
    // 若改回 `throw new ServiceUnavailableException(...)`，这里会变成
    // `{error:{code:'INTERNAL_ERROR',...}}` —— 只知道坏了，不知道谁坏了。
    expect(body.error).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/* 5. 超时与「探针抛异常」                                              */
/* ------------------------------------------------------------------ */

describe('单条探针的失败不会拖垮整个响应', () => {
  it('挂死的探针 → 503 + reason TIMEOUT，且在超时预算内返回', async () => {
    resetProbes();
    fakeOf('mysql').set('HANG');

    const startedAt = Date.now();
    const response = await request(`/${HEALTH_READY_PATH}`);
    const elapsed = Date.now() - startedAt;

    expect(response.status).toBe(503);
    const body = await readyBody(response);
    expect(body.checks?.mysql).toEqual({ status: 'down', reason: 'TIMEOUT' });
    // 必须显著快于 compose 的 5 秒 healthcheck timeout，否则 docker
    // 先把这次检查判成超时失败，我们的 TIMEOUT 到不了运维手里。
    expect(elapsed).toBeLessThan(3000);
  });

  it('探针违反「不抛」约定 → reason ERROR，且响应仍是 503 而不是连接被重置', async () => {
    resetProbes();
    fakeOf('mysql').set({ throws: 'ECONNREFUSED 10.0.0.7:3306' });

    const response = await request(`/${HEALTH_READY_PATH}`);
    expect(response.status).toBe(503);
    const body = await readyBody(response);
    expect(body.checks?.mysql).toEqual({ status: 'down', reason: 'ERROR' });
  });

  it('⚠ 内网地址只进日志，绝不进响应体（`/health/` 是对外可达的）', async () => {
    resetProbes();
    logStream.reset();
    fakeOf('mysql').set({ throws: 'ECONNREFUSED 10.0.0.7:3306' });

    const raw = await (await request(`/${HEALTH_READY_PATH}`)).text();

    expect(raw).not.toContain('10.0.0.7');
    expect(raw).not.toContain('ECONNREFUSED');
    // 反面：原文必须能在日志里找到，否则等于把可诊断性也一起丢了。
    expect(logStream.lines.join('')).toContain('ECONNREFUSED 10.0.0.7:3306');
  });
});

/* ------------------------------------------------------------------ */
/* 6. 接线不变式                                                        */
/* ------------------------------------------------------------------ */

describe('探针覆盖不变式（漏接一个依赖会让 readiness 永远 ok）', () => {
  const up = (dependency: ReadinessDependency): ReadinessProbe => ({
    dependency,
    probe: async () => ({ status: 'up' }),
  });

  it('齐全时通过', () => {
    expect(() => assertProbesCoverDependencies([up('mysql'), up('redis')])).not.toThrow();
  });

  it('⚠ 少一个依赖 → 抛（否则 readiness 从不检查它却报 ok）', () => {
    expect(() => assertProbesCoverDependencies([up('redis')])).toThrow(/缺少探针.*mysql/s);
  });

  it('重复 → 抛', () => {
    expect(() => assertProbesCoverDependencies([up('mysql'), up('redis'), up('mysql')])).toThrow(
      /重复探针/,
    );
  });

  it('未声明的依赖 → 抛（docs/15 只允许 MySQL 与 Redis 决定 readiness）', () => {
    // 一个覆盖齐全、但偷偷多带了一个外部依赖的接线 —— 例如将来有人
    // 「顺手」把 AI provider 的可用性也加进来，那会让 OpenAI 抖动
    // 时 api 被判成不健康。
    const stranger: ReadinessProbe = {
      dependency: 'openai' as unknown as ReadinessDependency,
      probe: async (): Promise<ProbeResult> => ({ status: 'up' }),
    };
    expect(() => assertProbesCoverDependencies([up('mysql'), up('redis'), stranger])).toThrow(
      /未声明的依赖[\s\S]*openai/,
    );
  });

  it('readiness 的允许清单就是 MySQL 与 Redis 两个（docs/15）', () => {
    expect([...READINESS_DEPENDENCIES]).toEqual(['mysql', 'redis']);
  });
});

/* ------------------------------------------------------------------ */
/* 7. 真实装配的探针真的会被构造、也真的会跑                            */
/* ------------------------------------------------------------------ */

describe('⚠ 不 override `READINESS_PROBES` —— 真实工厂产物必须被执行（Agent 06 / 08 的教训）', () => {
  it('真实探针恰好覆盖 mysql / redis，且能对桩客户端跑出 up', async () => {
    const sqlSeen: string[] = [];
    const moduleRef = await Test.createTestingModule({ imports: [HealthModule] })
      .overrideProvider(HEALTH_REDIS_CLIENT)
      .useValue({ quit: async () => undefined, ping: async () => 'PONG' })
      .overrideProvider(PrismaService)
      .useValue({
        // 记录真的发出去的 SQL：证明探针查的是「库能不能回答一次查询」，
        // 而不是「Prisma 对象在不在」。
        $queryRaw: async (strings: TemplateStringsArray): Promise<unknown> => {
          sqlSeen.push(strings.join('?'));
          return [{ '1': 1 }];
        },
      })
      .overrideProvider(APP_LOGGER)
      .useValue(createLogger({ service: 'api', level: 'silent' }))
      .compile();

    try {
      const probes = moduleRef.get<ReadinessProbe[]>(READINESS_PROBES);
      expect(probes.map((probe) => probe.dependency).sort()).toEqual(
        [...READINESS_DEPENDENCIES].sort(),
      );

      const results = await Promise.all(probes.map(async (probe) => probe.probe()));
      expect(results).toEqual([{ status: 'up' }, { status: 'up' }]);
      expect(sqlSeen).toEqual(['SELECT 1']);
    } finally {
      await moduleRef.close();
    }
  });

  it('探针超时默认值必须小于 compose 的 healthcheck timeout（下面另有逐字比对）', () => {
    expect(PROBE_TIMEOUT_MS).toBeLessThan(5000);
  });
});

/* ------------------------------------------------------------------ */
/* 8. 跨产物一致性                                                      */
/* ------------------------------------------------------------------ */

/**
 * 取 compose 里某个服务的**那一块**文本。
 *
 * ⚠ 与 `scripts/ops/verify-deploy.mjs` 里的同名函数是同一份逻辑：
 * 惰性正则（例如 `mysql:` 到下一个 `ports:`）会一路吃到**后面某个服务**，
 * 于是断言永远为真。服务块必须限定在「本服务键」到「下一个顶层键」之间。
 * （`.mjs` 脚本带顶层副作用、无法 import，所以这里复制 6 行。）
 */
function serviceBlock(source: string, service: string): string {
  const start = source.indexOf(`\n  ${service}:`);
  if (start === -1) return '';
  const rest = source.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[a-z][a-z0-9_-]*:/);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

/**
 * 取一个服务块里 **`healthcheck:` 那一段**。与 `verify-deploy.mjs` 的同名函数同源。
 *
 * ⚠ 为什么不直接在服务块里取「第一个 URL」：**注释和别的配置值里都会出现 URL**。
 * 2026-10-01 实测踩到：给 api 服务补 `APP_BASE_URL: ${PUBLIC_BASE_URL:-https://localhost}`
 * （容器形态必需，否则 `AdminOriginGuard` 会把后台写操作全判成跨源）之后，
 * 「服务块里第一个 URL」变成了它 —— 这条断言随即报
 * `TypeError: Invalid URL`（`new URL()` 收到的是注释里的文字）。
 *
 * 断言要看的是 **healthcheck 里的那个 URL**，所以必须限定到这一段。
 * 服务块内部的一级键是 4 空格缩进，下一个同级键就是边界。
 */
function healthcheckBlock(serviceBlockText: string): string {
  const start = serviceBlockText.indexOf('healthcheck:');
  if (start === -1) return '';
  const rest = serviceBlockText.slice(start);
  const next = rest.slice(1).search(/\n {4}[a-z][a-z0-9_-]*:/);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

describe('⚠ compose / 运维脚本 / nginx 里的路径必须与代码里的常量逐字一致', () => {
  const compose = readFileSync(join(REPO_ROOT, 'docker-compose.yml'), 'utf8');

  it('compose 的 api healthcheck 打的正是 `/health/ready`', async () => {
    const url = /https?:\/\/[^\s"'\\]+/.exec(healthcheckBlock(serviceBlock(compose, 'api')))?.[0];
    expect(url, '没有在 api 服务块里找到 healthcheck URL').toBeDefined();

    const pathname = new URL(url ?? '').pathname;
    expect(pathname).toBe(`/${HEALTH_READY_PATH}`);

    // 而且**真的**对这条路径发一次请求 —— 证明它不只是一个字符串。
    resetProbes();
    expect((await request(pathname)).status).toBe(200);
  });

  it('compose 的 api healthcheck timeout 比探针预算宽（否则报的是 docker 的 timeout）', () => {
    const block = serviceBlock(compose, 'api');
    const timeout = /timeout:\s*(\d+)s/.exec(block)?.[1];
    expect(timeout).toBeDefined();
    expect(Number(timeout) * 1000).toBeGreaterThan(PROBE_TIMEOUT_MS);
  });

  it('`scripts/ops/healthcheck.sh` 检查的两个路径就是声明的两个', () => {
    const script = readFileSync(join(REPO_ROOT, 'scripts/ops/healthcheck.sh'), 'utf8');
    const paths = [...script.matchAll(/\/health\/[a-z]+/g)].map((match) => match[0]);

    expect([...new Set(paths)].sort()).toEqual(
      [`/${HEALTH_LIVE_PATH}`, `/${HEALTH_READY_PATH}`].sort(),
    );
  });

  it('nginx 把 `/health/` 转发到 api（docs/04：不在 /api/v1 下）', () => {
    const nginx = readFileSync(join(REPO_ROOT, 'infra/nginx/nginx.conf'), 'utf8');
    const apiUpstream = /upstream\s+(\w+)\s*\{\s*server\s+api:3001/.exec(nginx)?.[1];
    expect(apiUpstream).toBeDefined();
    expect(
      new RegExp(`location\\s+/health/\\s*\\{[\\s\\S]*?proxy_pass\\s+http://${apiUpstream}`).test(
        nginx,
      ),
    ).toBe(true);
  });

  /**
   * 上面那些用例证明的是 `applyApiPrefix()`（生产实现）的行为。
   *
   * ⚠ 但**空壳 `AppModule` 里没有健康路由**，所以 `createApiApp()` 自己
   * 走不出一个 200 的 `/health/ready` —— 本测试无法用 HTTP 证明
   * `createApiApp` 真的调了 `applyApiPrefix`。所以这里退一步做**接线**断言：
   * 少了它，生产会用一条与测试不同的路径设置前缀。
   * （Agent 14 把 `HealthModule` 挂进 `AppModule` 之后，
   * 这条可以升级成对 `createApiApp()` 的真 HTTP 断言。）
   */
  it('`bootstrap.ts` 的 `createApiApp` 把前缀交给 `applyApiPrefix`（不是自己再写一遍）', () => {
    const source = readFileSync(join(REPO_ROOT, 'apps/api/src/bootstrap.ts'), 'utf8');
    expect(source).toContain('applyApiPrefix(app)');
    // 而且那份实现用的是健康模块导出的路由表，不是手写字面量。
    expect(source).toContain('HEALTH_ROUTE_EXCLUSIONS');
  });
});

/* ------------------------------------------------------------------ */
/* 8.5 失败归类（用的都是**真实抓到的**错误形态，不是编的）              */
/* ------------------------------------------------------------------ */

describe('失败归类：区分配置问题与网络问题', () => {
  it('Node 的 ECONNREFUSED → UNREACHABLE', () => {
    const error = Object.assign(new Error('connect ECONNREFUSED 10.0.0.5:3306'), {
      code: 'ECONNREFUSED',
    });
    expect(classifyFailure(error)).toBe('UNREACHABLE');
  });

  it('ioredis 的重试用尽 → UNREACHABLE（文案是实测抓到的原文）', () => {
    const error = Object.assign(
      new Error(
        'Reached the max retries per request limit (which is 1). Refer to "maxRetriesPerRequest" option for details.',
      ),
      { name: 'MaxRetriesPerRequestError' },
    );
    expect(classifyFailure(error)).toBe('UNREACHABLE');
  });

  it('⚠ Prisma 的「连不上」→ UNREACHABLE（文案与类名都是实测抓到的原文）', () => {
    // Prisma 6.19.3 里 `code` 与 `errorCode` 都是 undefined，只能认文案 ——
    // 这段 message 是从真实 `$queryRaw` 失败时复制的。
    const error = Object.assign(
      new Error(
        "\nInvalid `prisma.$queryRaw()` invocation:\n\n\nCan't reach database server at `127.0.0.1:1`\n\nPlease make sure your database server is running at `127.0.0.1:1`.",
      ),
      { name: 'PrismaClientInitializationError' },
    );
    expect(classifyFailure(error)).toBe('UNREACHABLE');
  });

  it('⚠ Prisma 的「认证失败」→ **ERROR**，不是 UNREACHABLE（该改 secret，不是查防火墙）', () => {
    const error = Object.assign(
      new Error(
        'Authentication failed against database server, the provided database credentials are not valid.',
      ),
      { name: 'PrismaClientInitializationError' },
    );
    expect(classifyFailure(error)).toBe('ERROR');
  });

  it('被刻意排除在外的 Prisma 码（P1003 库不存在）→ ERROR', () => {
    const error = Object.assign(new Error('Database `signal` does not exist'), { code: 'P1003' });
    expect(classifyFailure(error)).toBe('ERROR');
  });

  it('归类的结果只会是那三个枚举值之一', () => {
    const samples: unknown[] = [
      new Error('whatever'),
      'a string',
      null,
      undefined,
      { code: 42 },
      Object.assign(new Error('boom'), { code: 'ETIMEDOUT' }),
    ];
    for (const sample of samples) {
      expect(PROBE_FAILURE_REASONS).toContain(classifyFailure(sample));
    }
  });
});

/* ------------------------------------------------------------------ */
/* 9. readiness 只认内部依赖                                            */
/* ------------------------------------------------------------------ */

describe('⚠ 外部 provider 不得影响 readiness（docs/15）', () => {
  const healthDir = fileURLToPath(new URL('../src/modules/health', import.meta.url));

  /**
   * 健康模块**只允许** import 两类东西：
   *   - `@signal/*` 工作区包
   *   - 本仓库的 `common/`（logger / prisma / http 这些地基）
   *   - 本模块自己的文件
   *
   * 任何别的相对 import（`../auth/...`、`../public-read/...`、
   * 未来的 `../ai/...`）都可能把一个**外部**依赖引进 readiness ——
   * 那正是 `docs/15` 明令禁止的（AI/X/GitHub 挂了不该让 api 不健康）。
   */
  it('健康模块的源码不 import 任何业务模块', () => {
    const offenders: string[] = [];
    const files = readdirSync(healthDir).filter((name) => name.endsWith('.ts'));

    for (const name of files) {
      const source = readFileSync(join(healthDir, name), 'utf8');
      for (const match of source.matchAll(/from\s+'([^']+)'/g)) {
        const specifier = match[1] ?? '';
        if (specifier.startsWith('@signal/')) continue;
        if (specifier.startsWith('.')) {
          // 允许 `./x` 与 `../../common/x`（只允许**恰好**两层向上 + common）。
          const isLocal = specifier.startsWith('./');
          const isCommon = /^\.\.\/\.\.\/common\//.test(specifier);
          if (!isLocal && !isCommon) offenders.push(`${name}: ${specifier}`);
          continue;
        }
        // 外部 npm 包：只允许这两个基础设施依赖。
        if (specifier === 'ioredis' || specifier === '@nestjs/common') continue;
        offenders.push(`${name}: ${specifier}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('扫描确实读到了文件（防止空跑）', () => {
    expect(readdirSync(healthDir).filter((name) => name.endsWith('.ts')).length).toBeGreaterThan(4);
  });
});
