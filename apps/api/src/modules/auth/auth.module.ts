/**
 * AuthModule —— 认证模块装配。
 *
 * 归属：Agent 02（`tasks/agent-02-auth.md`）。
 *
 * ⚠ **不要把它挂到 `app.module.ts`** —— 根注册由 Agent 14 统一完成
 * （Agent 00 HANDOFF Integration Notes 第 3 条）。
 * 下游 Agent（03 / 07 / 09 / 12）在自己模块里 `imports: [AuthModule]`
 * 即可拿到导出的 `AuthGuard` / `AdminGuard`。
 *
 * 全部外部依赖都是可 override 的 provider token，
 * 因此单元测试可以用 `Test.createTestingModule().overrideProvider(...)`
 * 在没有 MySQL、没有 Redis、没有网络的情况下跑完整流程。
 */

import { Module } from '@nestjs/common';
import { serializeError, type Logger } from '@signal/logger';
import { CommonModule } from '../../common/common.module';
import { APP_LOGGER } from '../../common/logger/app-logger';
import { AdminGuard } from '../../common/guards/admin.guard';
import { AuthGuard } from '../../common/guards/auth.guard';
import { ACCESS_TOKEN_VERIFIER, AUTH_SESSION_LOOKUP } from '../../common/guards/ports';
import { UsersModule } from '../users/users.module';
import { AccessTokenService, ACCESS_TOKEN_SERVICE } from './access-token.service';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AUTH_CONFIG, createAuthConfig } from './auth.config';
import { CLOCK, SystemClock } from './clock';
import { FetchGithubClient, GITHUB_CLIENT } from './github.client';
import {
  ConsoleMailSender,
  MAIL_SENDER,
  MAIL_TRANSPORT_FACTORY,
  SmtpMailSender,
  UnavailableMailSender,
  defaultMailTransportFactory,
  type MailSender,
} from './mail-sender';
import { OtpService, OTP_CODE_GENERATOR, defaultOtpCodeGenerator } from './otp.service';
import { RateLimitService } from './rate-limit.service';
import { RATE_LIMITER } from './rate-limiter';
import { REDIS_CLIENT, RedisRateLimiter, createRedisClient } from './redis-rate-limiter';
import { AUTH_REPOSITORY } from './repository';
import { PrismaAuthRepository } from './prisma-auth.repository';
import { SessionService } from './session.service';

/**
 * 邮件通道选择。
 *
 *   - 配了 SMTP            → 真实投递
 *   - 未配 + 生产          → `UnavailableMailSender`，请求得到 503
 *                            （**绝不降级成写日志**，否则验证码会进日志，违反 `docs/14`）
 *   - 未配 + 非生产        → `ConsoleMailSender`，写 stderr，本地才能登录
 *
 * 导出以便单元测试直接断言这个**安全决策**本身，而不必真的去连 SMTP。
 */
export function selectMailSender(
  config: { smtp: unknown; nodeEnv: string },
  candidates: { smtp: MailSender; unavailable: MailSender; consoleSender: MailSender },
): MailSender {
  if (config.smtp !== null) return candidates.smtp;
  return config.nodeEnv === 'production' ? candidates.unavailable : candidates.consoleSender;
}

@Module({
  imports: [CommonModule, UsersModule],
  controllers: [AuthController],
  providers: [
    { provide: AUTH_CONFIG, useFactory: () => createAuthConfig() },
    { provide: CLOCK, useClass: SystemClock },
    { provide: OTP_CODE_GENERATOR, useValue: defaultOtpCodeGenerator },
    { provide: AUTH_REPOSITORY, useClass: PrismaAuthRepository },
    // AuthGuard 的认证主体查询：同一个仓储对象，避免多一次查询往返。
    { provide: AUTH_SESSION_LOOKUP, useExisting: AUTH_REPOSITORY },

    // Redis 限流
    {
      provide: REDIS_CLIENT,
      useFactory: (config: { redisUrl: string }, logger: Logger) =>
        // 把 ioredis 的连接错误收口到脱敏 logger，而不是让它直接打到 stderr。
        createRedisClient(config.redisUrl, (error) =>
          logger.warn(
            { err: serializeError(error), errorCode: 'REDIS_CONNECTION_ERROR' },
            'redis error',
          ),
        ),
      inject: [AUTH_CONFIG, APP_LOGGER],
    },
    { provide: RATE_LIMITER, useClass: RedisRateLimiter },

    // 邮件：三个实现都注册为普通 provider，再由工厂挑一个绑定到 MAIL_SENDER。
    { provide: MAIL_TRANSPORT_FACTORY, useValue: defaultMailTransportFactory },
    SmtpMailSender,
    ConsoleMailSender,
    UnavailableMailSender,
    {
      provide: MAIL_SENDER,
      useFactory: (
        config: { smtp: unknown; nodeEnv: string },
        smtp: SmtpMailSender,
        unavailable: UnavailableMailSender,
        consoleSender: ConsoleMailSender,
      ) => selectMailSender(config, { smtp, unavailable, consoleSender }),
      inject: [AUTH_CONFIG, SmtpMailSender, UnavailableMailSender, ConsoleMailSender],
    },

    // 认证核心
    { provide: GITHUB_CLIENT, useClass: FetchGithubClient },
    AccessTokenService,
    { provide: ACCESS_TOKEN_SERVICE, useExisting: AccessTokenService },
    { provide: ACCESS_TOKEN_VERIFIER, useExisting: AccessTokenService },
    OtpService,
    SessionService,
    RateLimitService,
    AuthService,

    // 对下游导出的守卫
    AuthGuard,
    AdminGuard,
  ],
  exports: [
    // 下游在自己模块里 @UseGuards(AuthGuard) 时，守卫的依赖要在**使用方模块**的
    // 注入上下文里可解析，因此这几个 token 必须一起导出。
    AuthGuard,
    AdminGuard,
    ACCESS_TOKEN_VERIFIER,
    AUTH_SESSION_LOOKUP,
    AuthService,
    ACCESS_TOKEN_SERVICE,
    AUTH_CONFIG,
  ],
})
export class AuthModule {}
