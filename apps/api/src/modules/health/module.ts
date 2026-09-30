/**
 * `HealthModule` —— 健康检查的装配。
 *
 * ⚠ **不要把它挂到 `apps/api/src/app.module.ts`** —— 根注册由 Agent 14 统一完成。
 *
 * ── 两件它**不做**的事，都是刻意的 ──────────────────────────────────
 *
 * 1. **不 import `AuthModule`**。健康检查没有守卫：docker healthcheck
 *    不会带 token，套上 `AuthGuard` 会让容器永远不健康。
 *    （`docs/14` 也没有为这两条路由要求鉴权 —— 它们不返回任何业务数据。）
 * 2. **不往外抛原始错误**。探针的失败原因只有三个枚举值；
 *    原始异常走 `onFailure` 回调进 logger。理由写在 `ports.ts`。
 *
 * ── 探针的接线正确性 ────────────────────────────────────────────────
 * `HealthService` 在构造函数里断言「每个声明依赖恰好一条探针」，
 * 所以漏接 mysql 会在**启动时**抛错，而不是安静地永远返回 200。
 */

import { Inject, Module, type OnModuleDestroy } from '@nestjs/common';
import { parseEnv } from '@signal/config';
import { serializeError, type Logger } from '@signal/logger';
import type { Redis } from 'ioredis';
import { CommonModule } from '../../common/common.module';
import { APP_LOGGER } from '../../common/logger/app-logger';
import { PrismaService } from '../../common/prisma/prisma.service';
import { HealthController } from './controller';
import { READINESS_PROBES, type ReadinessProbe } from './ports';
import { createMysqlProbe, createRedisProbe, type FailureSink } from './probes';
import { createHealthRedisClient } from './redis-client';
import { HEALTH_PROBE_TIMEOUT_MS, HealthService, PROBE_TIMEOUT_MS } from './service';

/** 探针专用连接的注入 token（测试里 override 它即可，不必真的连 Redis）。 */
export const HEALTH_REDIS_CLIENT = 'HEALTH_REDIS_CLIENT';

/** 把探针失败接到脱敏 logger 上，并带上是哪个依赖。 */
function failureSink(logger: Logger, dependency: string): FailureSink {
  return (error: unknown): void => {
    // `serializeError` + logger 的脱敏是**唯一**允许看到错误原文的地方。
    logger.warn({ dependency, err: serializeError(error) }, 'health probe failed');
  };
}

@Module({
  // `CommonModule` 带来 `PrismaService`（经 PrismaModule）与 `APP_LOGGER`。
  imports: [CommonModule],
  controllers: [HealthController],
  providers: [
    {
      provide: HEALTH_REDIS_CLIENT,
      useFactory: (logger: Logger): Redis =>
        createHealthRedisClient(parseEnv().REDIS_URL, failureSink(logger, 'redis')),
      inject: [APP_LOGGER],
    },
    {
      provide: READINESS_PROBES,
      useFactory: (prisma: PrismaService, logger: Logger, redis: Redis): ReadinessProbe[] => [
        createMysqlProbe(
          {
            // ⚠ 全系统唯一一处「健康检查发什么 SQL」。只读、无插值的标签模板
            // （`${}` 会被绑定成参数），且**不碰任何业务表** ——
            // 于是它不依赖迁移是否跑完，也不会被业务表锁误伤。
            ping: () => prisma.$queryRaw`SELECT 1`,
          },
          failureSink(logger, 'mysql'),
        ),
        createRedisProbe(redis, failureSink(logger, 'redis')),
      ],
      inject: [PrismaService, APP_LOGGER, HEALTH_REDIS_CLIENT],
    },
    // 超时是**可注入的**：测试用 10ms 验证超时分支，不必真等 2 秒。
    { provide: HEALTH_PROBE_TIMEOUT_MS, useValue: PROBE_TIMEOUT_MS },
    HealthService,
  ],
  exports: [HealthService],
})
export class HealthModule implements OnModuleDestroy {
  constructor(@Inject(HEALTH_REDIS_CLIENT) private readonly redis: Redis) {}

  /** 关掉本模块自己的那条 Redis 连接（不要留悬挂句柄）。 */
  async onModuleDestroy(): Promise<void> {
    await this.redis.quit().catch(() => undefined);
  }
}
