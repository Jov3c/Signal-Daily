/**
 * @signal/test-utils — 测试公共工具。
 *
 * 由 Agent 00 拥有。后续 Agent 的模块测试可复用，避免各写一套。
 */

import type { DestinationStream } from 'pino';

/**
 * 内存日志目标：把 pino 输出收集成字符串数组，便于断言。
 * 用法：`createLogger({ service: 'x', destination: createMemoryStream() })`
 */
export type MemoryLogStream = DestinationStream & {
  lines: string[];
  /** 把每行按 JSON 解析后的对象列表。 */
  records: () => Record<string, unknown>[];
  /** 清空已收集内容。 */
  reset: () => void;
};

export function createMemoryStream(): MemoryLogStream {
  const lines: string[] = [];
  return {
    lines,
    write(chunk: string): void {
      lines.push(chunk);
    },
    records(): Record<string, unknown>[] {
      return lines
        .join('')
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line) as Record<string, unknown>);
    },
    reset(): void {
      lines.length = 0;
    },
  };
}

/**
 * 一份合法的测试 env（对应 `.env.example`）。
 * 需要覆盖时传入 overrides。
 */
export const TEST_ENV = {
  NODE_ENV: 'test',
  APP_TIMEZONE: 'Asia/Shanghai',
  APP_BASE_URL: 'http://localhost:3000',
  API_BASE_URL: 'http://localhost:3000/api',
  DATABASE_URL: 'mysql://signal:signal@localhost:3306/signal',
  REDIS_URL: 'redis://localhost:6379',
  AUTH_ACCESS_TOKEN_SECRET: 'test-access-token-secret',
  AUTH_REFRESH_TOKEN_PEPPER: 'test-refresh-token-pepper',
  EMAIL_OTP_PEPPER: 'test-email-otp-pepper',
} as const;

/** 生成测试 env 对象。 */
export function createTestEnv(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...TEST_ENV, ...overrides };
}
