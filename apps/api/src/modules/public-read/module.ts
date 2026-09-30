/**
 * `PublicReadModule` —— 公开读的装配（含 Redis 缓存）。
 *
 * ⚠ **不要把它挂到 `apps/api/src/app.module.ts`** —— 根注册由 Agent 14 统一完成。
 *
 * ── 这个模块**不需要** `imports: [AuthModule]` ───────────────────────
 * 公开读是**游客可读**的（`docs/00`）：控制器上一个守卫都没有。
 * 这是它与本仓库其它模块（09 / 07 / 03 都要 `imports: [AuthModule]`）的区别 ——
 * 不要为了「统一」而加上它，那会给公开接口引入一次无谓的会话查询。
 *
 * ── Redis 是**可选**依赖（与 03 / 04 / 05 / 06 / 08 相反）────────────
 * 缓存是性能优化，不是正确性依赖：`RedisPublicCache` 在读写失败时
 * **只记日志、返回未命中**（见 `cache.ts`）。所以 Redis 挂了前台仍然可用 ——
 * 与 Agent 02 的限流（fail-closed）**刻意相反**。
 * 这也意味着本模块**可以**在 worker 的「测试期不开消费者」讨论之外独立存在。
 */

import { Inject, Module, type OnModuleDestroy } from '@nestjs/common';
import { Redis } from 'ioredis';
import { parseEnv } from '@signal/config';
import { createLogger } from '@signal/logger';
import { PUBLIC_CACHE, PUBLIC_REDIS_CLIENT, RedisPublicCache } from './cache';
import { PublicReadController } from './controller';
import { PUBLIC_READ_CLOCK, PublicReadService } from './service';
import { PUBLIC_READ_REPOSITORY } from './repository';
import { PrismaPublicReadRepository } from './prisma-public-read.repository';

@Module({
  controllers: [PublicReadController],
  providers: [
    { provide: PUBLIC_READ_REPOSITORY, useClass: PrismaPublicReadRepository },
    { provide: PUBLIC_READ_CLOCK, useFactory: () => ({ now: () => new Date() }) },
    {
      // ⚠ 惰性连接：ioredis 在 `new` 时就会开始连。这里显式关掉
      // `lazyConnect` 之外的自动重连噪音 —— 用 `maxRetriesPerRequest: 1`
      // 让「Redis 挂了」快速失败到 `RedisPublicCache` 的 catch 分支，
      // 而不是把请求挂在重试里（那是 fail-closed 的形状，而这里是优化）。
      provide: PUBLIC_REDIS_CLIENT,
      useFactory: (): Redis =>
        new Redis(parseEnv().REDIS_URL, {
          maxRetriesPerRequest: 1,
          enableOfflineQueue: false,
        }),
    },
    {
      provide: PUBLIC_CACHE,
      useFactory: (client: Redis) => new RedisPublicCache(client, createLogger({ service: 'api' })),
      inject: [PUBLIC_REDIS_CLIENT],
    },
    PublicReadService,
  ],
  exports: [PublicReadService, PUBLIC_READ_REPOSITORY, PUBLIC_CACHE],
})
export class PublicReadModule implements OnModuleDestroy {
  constructor(@Inject(PUBLIC_REDIS_CLIENT) private readonly redis: Redis) {}

  /** 关掉本模块自己的那条 Redis 连接（不要留悬挂句柄）。 */
  async onModuleDestroy(): Promise<void> {
    await this.redis.quit().catch(() => undefined);
  }
}
