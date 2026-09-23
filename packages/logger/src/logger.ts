/**
 * Signal 统一 Logger。
 *
 * 契约（`docs/15-observability-error.md`）：
 *   - Pino JSON。
 *   - 字段：timestamp, level, service, requestId, userId?, sourceId?,
 *     contentId?, jobId?, errorCode?, durationMs?
 *   - 不得记录 token、密码、OTP 明文、完整 secret。
 */

import pino, { type DestinationStream, type Logger, type LoggerOptions } from 'pino';
import { redactSecrets } from './redact';

/** 复用 pino 的 Logger 类型，避免各 app 自己去依赖 pino。 */
export type { Logger, DestinationStream, LoggerOptions } from 'pino';

/** 与 `docs/20` 的 LOG_LEVEL 取值一致。 */
export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/** 贯穿全链路的关联字段。 */
export type LogContext = {
  requestId?: string;
  userId?: string;
  sourceId?: string;
  contentId?: string;
  jobId?: string;
  errorCode?: string;
  durationMs?: number;
};

export type CreateLoggerOptions = {
  /** 运行实体名：`api` / `worker` / `web`，或更细的模块名。 */
  service: string;
  level?: LogLevel;
  /** 自定义输出目标；测试可注入内存流。 */
  destination?: DestinationStream;
  /** 追加到 base 的静态字段。不要放 secret。 */
  base?: Record<string, unknown>;
};

/**
 * 时间戳字段名固定为 `timestamp`（`docs/15`），而不是 pino 默认的 `time`。
 */
const timestampFn = (): string => `,"timestamp":"${new Date().toISOString()}"`;

export function createLogger(options: CreateLoggerOptions): Logger {
  const pinoOptions: LoggerOptions = {
    level: options.level ?? 'info',
    base: { service: options.service, ...options.base },
    messageKey: 'msg',
    timestamp: timestampFn,
    formatters: {
      level: (label) => ({ level: label }),
      // 深度脱敏，覆盖任意嵌套的 secret 字段与连接串凭据。
      log: (object) => redactSecrets(object) as Record<string, unknown>,
    },
  };

  return options.destination ? pino(pinoOptions, options.destination) : pino(pinoOptions);
}

/** 绑定关联字段，返回 child logger。 */
export function childLogger(logger: Logger, context: LogContext): Logger {
  return logger.child(redactSecrets(context) as Record<string, unknown>);
}

/**
 * 把 unknown 异常收敛为可安全序列化的结构。
 * 只保留 name / message / stack / code，避免把任意对象打进日志。
 */
export function serializeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
      ...(typeof code === 'string' ? { code } : {}),
    };
  }
  return { message: String(error) };
}

/** 判断字符串是否为合法日志级别。 */
export function isLogLevel(value: string): value is LogLevel {
  return (LOG_LEVELS as readonly string[]).includes(value);
}

/** 不可用的空 logger，便于测试或完全静默场景。 */
export function silentLogger(service = 'silent'): Logger {
  return createLogger({ service, level: 'silent' });
}

/**
 * NestJS `LoggerService` 的结构化最小契约。
 *
 * 这里刻意不 import `@nestjs/common`：
 *   - 让 @signal/logger 保持框架无关；
 *   - 结构上满足 Nest 的 `LoggerService`，可直接传给 `app.useLogger()`。
 */
export type NestLikeLoggerService = {
  log(message: unknown, ...optionalParams: unknown[]): void;
  error(message: unknown, ...optionalParams: unknown[]): void;
  warn(message: unknown, ...optionalParams: unknown[]): void;
  debug(message: unknown, ...optionalParams: unknown[]): void;
  verbose(message: unknown, ...optionalParams: unknown[]): void;
};

/**
 * 把 @signal/logger 接到 Nest 的内部日志上。
 *
 * 用法：`app.useLogger(createNestLoggerBridge(logger))`
 *
 * Nest 的调用形态是 `(message, ...optionalParams)`，
 * 其中 error 可能是 `(message, stack, context)`。此处取**最后一个字符串参数**
 * 作为 context，其余仍进入日志对象并统一脱敏。
 */
export function createNestLoggerBridge(logger: Logger): NestLikeLoggerService {
  const emit = (
    level: 'info' | 'error' | 'warn' | 'debug' | 'trace',
    message: unknown,
    optionalParams: unknown[],
  ): void => {
    const context = [...optionalParams].reverse().find((param) => typeof param === 'string');
    const fields: Record<string, unknown> = {};
    if (typeof context === 'string') fields.context = context;

    if (typeof message === 'string') {
      logger[level](fields, message);
    } else {
      logger[level]({ ...fields, message });
    }
  };

  return {
    log: (message, ...optionalParams) => emit('info', message, optionalParams),
    error: (message, ...optionalParams) => emit('error', message, optionalParams),
    warn: (message, ...optionalParams) => emit('warn', message, optionalParams),
    debug: (message, ...optionalParams) => emit('debug', message, optionalParams),
    verbose: (message, ...optionalParams) => emit('trace', message, optionalParams),
  };
}
