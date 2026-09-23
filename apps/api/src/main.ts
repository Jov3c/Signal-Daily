/**
 * API 进程入口。
 *
 * 这是唯一的进程入口：只做 env 校验 → 建 logger → 启动。
 * 测试请 import `bootstrap.ts` 的 `createApiApp()`，不要 import 本文件。
 */

import { DEFAULT_API_PORT, parseEnv } from '@signal/config';
import { createLogger } from '@signal/logger';
import { createApiApp } from './bootstrap';

async function main(): Promise<void> {
  const env = parseEnv();
  const logger = createLogger({
    service: 'api',
    level: env.LOG_LEVEL,
    base: { env: env.NODE_ENV },
  });

  try {
    const app = await createApiApp({ logger });
    await app.listen(DEFAULT_API_PORT);
    logger.info({ port: DEFAULT_API_PORT, apiPrefix: '/api/v1' }, 'signal api started');
  } catch (error) {
    logger.error({ err: error }, 'signal api failed to start');
    process.exitCode = 1;
  }
}

void main();
