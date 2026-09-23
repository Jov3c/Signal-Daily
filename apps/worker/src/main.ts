/**
 * Worker 进程入口。
 *
 * 测试请 import `bootstrap.ts` 的 `createWorkerApp()`，不要 import 本文件。
 *
 * 说明：Worker 是 standalone 应用，不监听端口。
 * 一个空的 Nest 应用上下文没有任何「句柄」持有 Node 事件循环，
 * 进程会在 main() 结束后立即退出（注册 SIGINT/SIGTERM 监听本身并不持有事件循环）。
 * 因此这里显式放一个占位定时器，并在收到终止信号时清理。
 *
 * 接入 BullMQ 之后，Queue 的 Worker 自身就会持有事件循环，
 * 这个占位定时器可以在那时移除。
 */

import { parseEnv } from '@signal/config';
import { createLogger } from '@signal/logger';
import { createWorkerApp } from './bootstrap';

/** Node 定时器上限，约 24.8 天；仅作占位句柄使用。 */
const KEEP_ALIVE_INTERVAL_MS = 2_147_483_647;

/** 等待 SIGINT / SIGTERM。 */
function waitForShutdownSignal(): Promise<NodeJS.Signals> {
  return new Promise((resolve) => {
    const onSignal = (signal: NodeJS.Signals): void => {
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
      resolve(signal);
    };
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
  });
}

async function main(): Promise<void> {
  const env = parseEnv();
  const logger = createLogger({
    service: 'worker',
    level: env.LOG_LEVEL,
    base: { env: env.NODE_ENV },
  });

  let keepAlive: NodeJS.Timeout | undefined;

  try {
    const app = await createWorkerApp({ logger });
    await app.init();

    keepAlive = setInterval(() => {
      // 占位：不做事，只让进程保持存活，等待 BullMQ 接管。
    }, KEEP_ALIVE_INTERVAL_MS);

    logger.info({ timezone: env.APP_TIMEZONE }, 'signal worker started');

    const signal = await waitForShutdownSignal();
    logger.info({ signal }, 'signal worker shutting down');

    await app.close();
    logger.info('signal worker stopped');
  } catch (error) {
    logger.error({ err: error }, 'signal worker failed to start');
    process.exitCode = 1;
  } finally {
    if (keepAlive) clearInterval(keepAlive);
  }
}

void main();
