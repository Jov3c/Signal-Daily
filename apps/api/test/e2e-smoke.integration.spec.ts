/**
 * 端到端冒烟 —— **真的把整个 API 起起来**（真 `AppModule`、真 MySQL、真 Redis），
 * 然后走一遍公开读路径。
 *
 * 运行：
 *
 * ```bash
 * REDIS_URL=redis://127.0.0.1:6390 pnpm --filter @signal/api test:integration
 * ```
 *
 * ── 这个文件为什么必须存在（Agent 14 的教训）────────────────────────
 * 在它之前，**没有任何一个测试跑过完整的 `AppModule`**：每一个模块测试都
 * 只 `imports`[自己的模块]，而 `boot.spec.ts` 用的是空壳。于是：
 *
 * ```text
 * 模块能编译、能过全部单测、能过自己的集成测试 —— 一挂进根模块就启动即崩
 * ```
 *
 * 集成时实测到的两处，都是这个盲区里的：
 *   1. `BullSourceFetchEnqueue` 的 `useClass` 让 Nest 去解析一个
 *      没有 `@Inject` 的 `string` 参数（token 是元数据里的 `String`）→ 启动炸
 *   2. `public-read` 的 Redis 连接没有 `error` 监听器 → ioredis 直接往 stderr 打
 *
 * ⚠ 与 `boot.spec.ts` 的分工：那个跑在**没有 MySQL / 没有 Redis**的机器上
 *（证明依赖图能解析、且测试期不开消费者）；**这个文件要真库真 Redis**，
 * 证明「路由真的挂上了、真的返回 200」。
 * 不静默跳过：连不上就直接失败。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { API_PREFIX } from '@signal/contracts';
import { TEST_ENV } from '@signal/test-utils';
import { createApiApp } from '../src/bootstrap';

function resolveEnv(name: string, requireExplicit: boolean): string {
  const fromEnv = process.env[name];
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  if (requireExplicit) {
    throw new Error(
      `${name} 必须由环境变量显式给出。` +
        `\n用法：REDIS_URL=redis://127.0.0.1:6390 pnpm --filter @signal/api test:integration`,
    );
  }
  const envPath = fileURLToPath(new URL('../../../.env', import.meta.url));
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const match = new RegExp(`^${name}=(.*)$`).exec(line.trim());
    if (match?.[1] !== undefined) return match[1].trim();
  }
  throw new Error(`${name} is not set and could not be read from the repository .env`);
}

beforeAll(() => {
  for (const [key, value] of Object.entries(TEST_ENV)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
  process.env['DATABASE_URL'] = resolveEnv('DATABASE_URL', false);
  process.env['REDIS_URL'] = resolveEnv('REDIS_URL', true);
});

let app: INestApplication;
let baseUrl: string;

beforeAll(async () => {
  app = await createApiApp();
  await app.listen(0, '127.0.0.1');
  baseUrl = await app.getUrl();
});

afterAll(async () => {
  await app.close();
});

/** 发一个请求，返回状态码与解析后的 JSON（非 JSON 时给 `null`）。 */
async function get(path: string): Promise<{ status: number; body: any }> {
  const response = await fetch(`${baseUrl}${path}`);
  const text = await response.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  return { status: response.status, body };
}

describe('⚠ 真的把整个 API 起起来（挂在根模块上的路由真的可达）', () => {
  it('健康检查：/health/live 与 /health/ready 都在根路径上', async () => {
    expect((await get('/health/live')).status).toBe(200);

    // ready 依赖 MySQL + Redis，本文件的前提就是它们可达 —— 所以这里应当是 200。
    // 若不是 200，说明**真的**有依赖挂了（而不是测试环境问题）。
    const ready = await get('/health/ready');
    expect(ready.status, JSON.stringify(ready.body)).toBe(200);
    expect(ready.body).toMatchObject({ status: 'ok' });
  });

  it('公开读：/today 返回封套与当日的 featured / latest', async () => {
    const { status, body } = await get(`${API_PREFIX}/today`);
    expect(status).toBe(200);
    // 400/401/403 都意味着「路由没挂上或守卫被误加」—— 它们都是失败，不是空数据。
    expect(body.data).toHaveProperty('businessDate');
    expect(Array.isArray(body.data.featured)).toBe(true);
    expect(Array.isArray(body.data.latest)).toBe(true);
  });

  it('公开面是**游客可读**的：不带任何凭据也拿得到', async () => {
    // `docs/00`：今日 / 精选 / 日报 / X / 人物 / 主题 / 搜索 都不需要登录。
    // 这条在集成前从来没被验过 —— 各模块的单测只证明「自己的路由不带守卫」，
    // 证明不了「挂进根模块后没有被全局守卫拦住」。
    for (const path of [
      `${API_PREFIX}/featured`,
      `${API_PREFIX}/x`,
      `${API_PREFIX}/people`,
      `${API_PREFIX}/topics`,
      `${API_PREFIX}/daily/archive`,
    ]) {
      const { status } = await get(path);
      expect([200, 404], `${path} → ${String(status)}`).toContain(status);
    }
  });

  it('⚠ 需要登录的路由仍然是 401（守卫真的生效，而不是被挂载顺序弄丢）', async () => {
    const { status, body } = await get(`${API_PREFIX}/bookmarks`);
    expect(status).toBe(401);
    expect(body.error.code).toBe('UNAUTHORIZED');
  });

  it('⚠ 后台路由对匿名者是 401（不是 200，也不是 500）', async () => {
    for (const path of [
      `${API_PREFIX}/admin/review`,
      `${API_PREFIX}/admin/sources`,
      `${API_PREFIX}/admin/dashboard`,
      `${API_PREFIX}/admin/jobs`,
    ]) {
      const { status } = await get(path);
      expect(status, path).toBe(401);
    }
  });

  it('⚠ `/subscriptions/*` 不存在（规则 §13 / docs/17 第 18 条）', async () => {
    // 这一条在真 HTTP 上再验一次：源码级守卫证明「没人写这个控制器」，
    // 这条证明「挂上全部模块之后它确实不可达」。
    const { status } = await get(`${API_PREFIX}/subscriptions`);
    expect(status).toBe(404);
  });

  it('未知路径是 404（不是 500 —— 说明错误过滤器在工作）', async () => {
    const { status } = await get(`${API_PREFIX}/__definitely_not_a_route__`);
    expect(status).toBe(404);
  });
});
