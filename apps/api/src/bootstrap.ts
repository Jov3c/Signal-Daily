/**
 * API bootstrap 空壳。
 *
 * 只负责：创建 Nest 应用、套用公共 API 前缀。
 * 不包含任何业务模块、中间件、守卫或过滤器 —— 那些属于 Agent 02–11 / 14。
 */

import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { API_PREFIX } from '@signal/contracts';
import { createNestLoggerBridge, type Logger } from '@signal/logger';
import { AppModule } from './app.module';
import { HEALTH_ROUTE_EXCLUSIONS } from './modules/health/routes';

export type CreateApiAppOptions = {
  /** 传入后接管 Nest 内部日志，并统一走 secret 脱敏。 */
  logger?: Logger;
};

/**
 * 创建（但不监听）API 应用。
 *
 * 全局前缀固定为 `/api/v1`（`docs/04`）。
 * `/health/*` 按契约**不在** `/api/v1` 下，因此用 `setGlobalPrefix` 的
 * `exclude` 把它们摘出去（Agent 00 的 HANDOFF 原话：「接入健康检查时请用
 * `setGlobalPrefix` 的 `exclude` 选项，不要改这里的前缀常量」）。
 *
 * ⚠ 摘出的是 `HEALTH_ROUTE_EXCLUSIONS` —— **Agent 11 的健康模块导出的
 * 那张路由表**，不是手写的字面量。compose 的 healthcheck 打的就是
 * `/health/ready`：这里少写一条，容器会永远停在 `starting`，
 * 而 `pnpm test` 依然全绿（测试不读 compose）。
 * 从 `modules/health/routes` 直接 import 而不是 `modules/health`：
 * 这里只需要两张路径，没必要把 ioredis 与 PrismaService 拉进启动期的 import 图。
 */
/**
 * 给任何 Nest 应用套上 `/api/v1` 前缀，并把健康检查摘出去。
 *
 * ── 为什么单独导出（Agent 11 提，见 CCR-agent-11 第 1 项）────────────
 * 测试里构造的应用**不走 `createApiApp()`** —— `AppModule` 是空壳
 *（根注册由 Agent 14 完成），所以测试只能自己
 * `Test.createTestingModule({ imports: [某个业务模块] })`。
 * 于是它们全都**手工复制**了下面这一行 `setGlobalPrefix`。
 *
 * 那是本项目反复栽过的形状：测试复制了生产配置，于是**测试验的是
 * 它自己那份副本**。具体到这里，如果 `exclude` 被删掉，生产上
 * `/health/ready` 会变成 `/api/v1/health/ready` → 容器永远不健康，
 * 而所有测试仍然全绿。
 *
 * 把这一行抽出来，测试就能调用**同一份**实现（见
 * `apps/api/test/health-routes.spec.ts`）—— 删掉 `exclude` 会让那些
 * 真 HTTP 用例直接 404 变红。
 */
export function applyApiPrefix(app: INestApplication): void {
  app.setGlobalPrefix(API_PREFIX.slice(1), { exclude: HEALTH_ROUTE_EXCLUSIONS });
}

export async function createApiApp(options: CreateApiAppOptions = {}): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule, {
    logger: false,
    // ⚠ 同 worker 侧：`abortOnError` 默认 true，初始化失败会 `process.abort()`
    // 并把错误吞掉。关掉之后 `main.ts` 的 `catch` 才能记下真正的启动失败原因。
    abortOnError: false,
  });

  applyApiPrefix(app);
  // 收到 SIGTERM / SIGINT 时优雅关闭，先停止接收新请求再释放资源。
  app.enableShutdownHooks();

  if (options.logger) {
    app.useLogger(createNestLoggerBridge(options.logger));
  }

  return app;
}
