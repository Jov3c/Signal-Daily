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
import { createLogger, serializeError } from '@signal/logger';
import { PUBLIC_CACHE, PUBLIC_REDIS_CLIENT, RedisPublicCache } from './cache';
import { PublicReadController } from './controller';
import { PUBLIC_READ_CLOCK, PublicReadService } from './service';
import { PUBLIC_READ_REPOSITORY } from './repository';
import { PrismaPublicReadRepository } from './prisma-public-read.repository';

/**
 * 本模块的连接级日志。
 *
 * 与 `PUBLIC_CACHE` 里那个 logger 用同一份配置，但**不是同一个对象** ——
 * 它服务的是「连接本身出了问题」（`error` 事件），而那个服务的是
 * 「一次缓存读写失败了」。两件事的日志级别与含义都不同，见工厂里的说明。
 */
const cacheLogger = createLogger({ service: 'api' });

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
      useFactory: (): Redis => {
        const client = new Redis(parseEnv().REDIS_URL, {
          maxRetriesPerRequest: 1,
          enableOfflineQueue: false,
        });

        // ⚠ **必须挂 `error` 监听器。** ioredis 在没有监听器时会自己往
        // **stderr** 打 `[ioredis] Unhandled error event: ...` ——
        // 那绕过了 `@signal/logger`：既不脱敏、也不带 service/requestId，
        // 而且它会在 Redis 挂掉期间**每次重连都打一行**，把真正的日志淹掉。
        //
        // Agent 02（限流）与 Agent 11（健康检查）的连接都收了口，
        // **只有这一处漏了** —— 而它只在「模块被真的挂上 + Redis 不可达」
        // 时才现形，所以直到 Agent 14 集成 `AppModule` 才暴露
        //（实测：`apps/api/test/boot.spec.ts` 的 stderr 里出现该行）。
        //
        // 记 `debug` 而不是 `warn`：`RedisPublicCache` 是 **fail-open** 的
        //（缓存失败只算未命中），Redis 抖动不是需要人起床的事件；
        // 把它记成 warn 会让「Redis 挂了」在日志里看起来比实际严重。
        client.on('error', (error: unknown) => {
          cacheLogger.debug({ err: serializeError(error) }, 'public cache redis connection error');
        });

        return client;
      },
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
