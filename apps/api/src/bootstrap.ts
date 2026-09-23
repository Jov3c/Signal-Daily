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

export type CreateApiAppOptions = {
  /** 传入后接管 Nest 内部日志，并统一走 secret 脱敏。 */
  logger?: Logger;
};

/**
 * 创建（但不监听）API 应用。
 *
 * 全局前缀固定为 `/api/v1`（`docs/04`）。
 * `/health/*` 按契约不在 `/api/v1` 下，Agent 11 接入健康检查时
 * 需要使用 `setGlobalPrefix` 的 `exclude` 选项，不要改这里的前缀常量。
 */
export async function createApiApp(options: CreateApiAppOptions = {}): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule, { logger: false });

  app.setGlobalPrefix(API_PREFIX.slice(1));
  // 收到 SIGTERM / SIGINT 时优雅关闭，先停止接收新请求再释放资源。
  app.enableShutdownHooks();

  if (options.logger) {
    app.useLogger(createNestLoggerBridge(options.logger));
  }

  return app;
}
