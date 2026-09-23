/**
 * Worker bootstrap 空壳。
 *
 * Worker 是 NestJS **standalone** 应用（`docs/01`），不监听 HTTP。
 * 只负责创建应用上下文；Queue 注册、Job 处理、调度属于 Agent 04–08 / 11 / 14。
 */

import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { INestApplicationContext } from '@nestjs/common';
import type { Logger } from '@signal/logger';
import { WorkerModule } from './worker.module';

export type CreateWorkerAppOptions = {
  logger?: Logger | false;
};

/** 创建（但不启动）Worker 应用上下文。 */
export async function createWorkerApp(
  _options: CreateWorkerAppOptions = {},
): Promise<INestApplicationContext> {
  return NestFactory.createApplicationContext(WorkerModule, { logger: false });
}
