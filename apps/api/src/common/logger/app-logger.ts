/**
 * 进程级 Logger 注入点。
 *
 * `apps/api/src/main.ts` 会把它交给 `app.useLogger()`；模块内的过滤器/服务
 * 通过 `@Inject(APP_LOGGER)` 拿到**同一个**脱敏 logger，而不是各自 `createLogger()`。
 *
 * 归属：Agent 02 落地（错误过滤器需要 logger）。下游复用，不要再建一套。
 */

import { createLogger, isLogLevel, type LogLevel, type Logger } from '@signal/logger';

/** 注入 token。 */
export const APP_LOGGER = 'APP_LOGGER';

/**
 * 构建 API 进程的 logger。
 *
 * 刻意不调用 `parseEnv()`：logger 是**启动最早期**的依赖，
 * 不应该因为某个无关 env 缺失就让「日志」本身不可用。
 * `LOG_LEVEL` 非法时回退到 `info`（并会在第一行日志里体现）。
 */
export function createAppLogger(
  rawLevel: string | undefined = process.env.LOG_LEVEL,
  destination?: Parameters<typeof createLogger>[0]['destination'],
): Logger {
  const level: LogLevel = rawLevel !== undefined && isLogLevel(rawLevel) ? rawLevel : 'info';
  return createLogger({ service: 'api', level, destination });
}
