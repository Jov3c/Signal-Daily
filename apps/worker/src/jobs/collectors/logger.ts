/**
 * Worker 进程内的 logger 注入点。
 *
 * 与 `apps/api/src/common/logger/app-logger.ts` 同一套做法
 * （见 `prisma.service.ts` 关于「哪些重复是刻意的」的说明）：
 * 通过注入拿到**同一个**脱敏 logger，而不是每个 provider 各自
 * `createLogger()` —— 后者会让日志里出现多份重复的 base 字段，
 * 而 `docs/15` 要求日志字段是稳定的。
 *
 * `service: 'worker'` 与 `apps/worker/src/main.ts` 一致：
 * `docs/15` 的字段契约里有 `service`，Agent 11 靠它区分进程。
 */

import { createLogger, isLogLevel, type LogLevel, type Logger } from '@signal/logger';

/** 注入 token。 */
export const WORKER_LOGGER = 'WORKER_LOGGER';

/**
 * 构建 worker 的 logger。
 *
 * 刻意不调用 `parseEnv()`：logger 是**启动最早期**的依赖，
 * 不该因为某个无关 env 缺失就让「日志」本身不可用。
 * `LOG_LEVEL` 非法时回退到 `info`。
 */
export function createWorkerLogger(
  rawLevel: string | undefined = process.env.LOG_LEVEL,
  destination?: Parameters<typeof createLogger>[0]['destination'],
): Logger {
  const level: LogLevel = rawLevel !== undefined && isLogLevel(rawLevel) ? rawLevel : 'info';
  return createLogger({ service: 'worker', level, destination });
}
