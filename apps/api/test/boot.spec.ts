import { beforeAll, describe, expect, it } from 'vitest';
import {
  API_PREFIX,
  ContentPipelineStatus,
  SourceType,
  PlatformErrorCode,
} from '@signal/contracts';
import { TEST_ENV } from '@signal/test-utils';
import { createApiApp } from '../src/bootstrap';

/**
 * 验收项：`contracts import` + `三个 app 空壳可启动`（api 部分）。
 *
 * ── ⚠ 这个文件在 Agent 14 集成之后**变重了** ────────────────────────
 * 集成前 `AppModule.imports` 是空数组，所以它只证明「一个空的 Nest 应用
 * 能起来」。集成后 `AppModule` 挂了 13 个模块，于是这一条变成了
 * **整个 API 的启动自检**：它会实例化全部 provider（含 `parseEnv()`、
 * Prisma、ioredis、BullMQ Queue）。
 *
 * 两件事因此变成硬前提：
 *
 * 1. **先种 env。** 多个模块的工厂会调 `parseEnv()`
 *   （Auth 的 `AUTH_CONFIG`、Sources 的 `SOURCE_CONFIG`、
 *    Health 与 PublicRead 的 `REDIS_URL`、四个模块的
 *    `createAdminOriginConfig()`）。缺任何一个都会在**实例化时**抛 ——
 *    这是刻意的（配置缺失该在启动时炸），但对测试意味着必须先种。
 * 2. **依赖图必须能解析。** 少一个 provider 会在这里炸，而不是在生产启动时。
 *    集成时正是这一条抓出了 `BullSourceFetchQueue` 那个
 *    「`useClass` + 无 `@Inject` 的 `string` 参数」缺陷
 *    （`dist` 崩、全部单测绿，因为元数据只出现在 `tsc` 产物里）。
 *
 * ⚠ 它**不**连真库：`PrismaService` 是惰性的（不在 `onModuleInit` 里
 * `$connect()`），ioredis 是惰性的，消费者/定时器在 `NODE_ENV=test` 下不启动。
 * 所以这个文件在没有 MySQL、没有 Redis 的机器上也应当能过。
 */
beforeAll(() => {
  for (const [key, value] of Object.entries(TEST_ENV)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
});

describe('@signal/api 空壳', () => {
  it('可以从 api 正确 import 公共契约', () => {
    expect(API_PREFIX).toBe('/api/v1');
    expect(SourceType.X_USER).toBe('X_USER');
    expect(ContentPipelineStatus.REVIEW_PENDING).toBe('REVIEW_PENDING');
    expect(PlatformErrorCode.INTERNAL_ERROR).toBe('INTERNAL_ERROR');
  });

  it('挂了全部模块之后，Nest 应用仍可创建、可真实监听 HTTP、可正常关闭', async () => {
    const app = await createApiApp();

    await app.listen(0, '127.0.0.1');
    const baseUrl = await app.getUrl();

    // 真实发一次 HTTP 请求：证明 HTTP 栈已起来（无路由时 404）。
    const response = await fetch(`${baseUrl}${API_PREFIX}/__bootstrap_probe__`);
    expect(response.status).toBe(404);

    await app.close();
  });

  it('⚠ 健康检查在根路径上（不在 /api/v1 下）—— 挂上全部模块后仍然成立', async () => {
    const app = await createApiApp();
    await app.listen(0, '127.0.0.1');
    const baseUrl = await app.getUrl();

    // 这一条在集成后才有意义：`/health/*` 要能被 nginx 转到，
    // 而它之所以不在 /api/v1 下，靠的是 `bootstrap.ts` 的 `exclude`。
    // 挂了 13 个模块之后 exclude 仍要生效（路由变多了）。
    const live = await fetch(`${baseUrl}/health/live`);
    expect(live.status).toBe(200);

    // 反向：带前缀的那条必须是 404（否则两处都注册了）。
    expect((await fetch(`${baseUrl}${API_PREFIX}/health/live`)).status).toBe(404);

    await app.close();
  });
});
