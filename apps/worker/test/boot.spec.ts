import { beforeAll, describe, expect, it } from 'vitest';
import { JOB_NAMES, QueueName, BUSINESS_TIMEZONE } from '@signal/contracts';
import { TEST_ENV } from '@signal/test-utils';
import { createWorkerApp } from '../src/bootstrap';
import { shouldStartConsumers } from '../src/common/consumers';

/**
 * 验收项：`contracts import` + 三个 app 空壳可启动（worker 部分）。
 *
 * ── ⚠ 这个文件在 Agent 14 集成之后**变重了** ────────────────────────
 * 集成前 `WorkerModule.imports` 是空数组，所以它「能过」是**必然的** ——
 * 没有任何模块被挂上，也就没有任何消费者、定时器或 Redis 连接。
 *
 * 集成后 `WorkerModule` 挂了四个 Job 模块，每个都会在 `onModuleInit` 里
 * `new Worker(queue)`（其中三个还各带定时器）。这个文件之所以仍然能过，
 * 靠的是**统一开关** `shouldStartConsumers()`（`src/common/consumers.ts`）——
 * 它在 `NODE_ENV=test` 下让那六个启动点全部 early-return。
 *
 * 所以这里有两条断言在守着那件事：
 *   1. **env**：`parseEnv()` 仍会被各 provider 工厂调用，缺 env 会抛 ——
 *      这是刻意的（配置缺失该在启动时炸）。所以先种好 `TEST_ENV`。
 *   2. **开关确实关着**：`NODE_ENV=test` 时 `shouldStartConsumers()` 必须是 false，
 *      否则这个文件会去连 Redis（`TEST_ENV.REDIS_URL` 指向 6379，本机没有）。
 */
beforeAll(() => {
  for (const [key, value] of Object.entries(TEST_ENV)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
});

describe('@signal/worker 空壳', () => {
  it('可以从 worker 正确 import 公共契约', () => {
    expect(QueueName.COLLECTOR).toBe('collector');
    expect(JOB_NAMES).toContain('collector.fetch-source');
    expect(BUSINESS_TIMEZONE).toBe('Asia/Shanghai');
  });

  it('⚠ 测试期消费者与定时器都不启动（否则这个文件会去连 Redis）', () => {
    // Vitest 默认把 NODE_ENV 设成 test；这条断言把「默认」变成「契约」。
    expect(process.env['NODE_ENV']).toBe('test');
    expect(shouldStartConsumers()).toBe(false);
  });

  it('挂了全部四个 Job 模块之后，应用上下文仍可创建并可正常关闭', async () => {
    // ⚠ 这一步会**实例化四个模块的全部 provider** —— 包括
    // `parseEnv()` 与 `new Redis(...)`（惰性连接）。它同时证明了：
    //   - 依赖图能解析（少一个 provider 会在这里炸，而不是在生产启动时）
    //   - 没有消费者被真的启动（否则 `close()` 要等 BullMQ 断连）
    const context = await createWorkerApp();
    expect(context).toBeDefined();
    expect(typeof context.close).toBe('function');
    await context.close();
  });
});
