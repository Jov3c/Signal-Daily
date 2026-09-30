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
  return NestFactory.createApplicationContext(WorkerModule, {
    logger: false,
    // ⚠ `abortOnError` 默认是 **true** —— 初始化出错时 Nest 直接
    // `process.abort()`（SIGABRT），错误信息被崩掉的进程吞掉，
    // 只剩一段 native stack trace。集成时实测踩到：worker 挂上四个模块后
    // 启动失败，屏幕上只有 `exit code 134`，**看不到是哪一行**。
    //
    // 关掉它之后异常会正常冒到调用方：`main.ts` 的 `catch` 能拿到它并用
    // 脱敏 logger 记下来（`docs/15`），测试也能拿到真正的堆栈。
    // 失败依旧是失败（`main.ts` 会 `process.exitCode = 1`），只是可见了。
    abortOnError: false,
  });
}
