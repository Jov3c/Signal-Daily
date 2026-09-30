/**
 * API 根模块 —— **Agent 14 在集成阶段完成总注册**（`docs/18`）。
 *
 * ```text
 * CommonModule            地基：APP_LOGGER + APP_FILTER（全局）+ PrismaModule（@Global）
 *
 * AuthModule              认证（守卫、会话、令牌）—— 被下面 8 个模块依赖
 * HealthModule            /health/live 与 /health/ready（**刻意不依赖 Auth**）
 *
 * PublicReadModule        公开读（游客可读）
 * SearchModule            搜索（复用 PublicReadModule 的仓储与缓存）
 * FeaturedModule          精选
 * DailyModule             日报
 *
 * BookmarksModule         收藏           ┐
 * ReadingProgressModule   阅读进度        ├ 登录用户的三件事
 * UserPreferencesModule   阅读偏好同步    ┘
 *
 * SourcesModule           Source Registry / X 白名单
 * AdminReviewModule       审核队列 / 证据链 / Dashboard
 * AdminOpsModule          运维视图（Jobs / 通知 / AI 用量）
 * ```
 *
 * ── 三件刻意不做的事 ────────────────────────────────────────────────
 *
 * 1. **不重复注册全局过滤器。** `CommonModule` 已经以 `APP_FILTER` 注册了
 *    `AppErrorFilter`；再注册一个会**套两层封套**（Agent 02 的 HANDOFF 明确警告过）。
 * 2. **不给 `/health/*` 加守卫。** 容器探针不带 token；`HealthModule` 也刻意
 *    没有 `imports: [AuthModule]`（`docs/15`：它不返回任何业务数据）。
 * 3. **不手动提供 `ADMIN_ORIGIN_CONFIG`。** 用到 `AdminOriginGuard` 的四个模块
 *    （sources / admin-review / featured / daily / admin-ops）**各自**在自己的
 *    `providers` 里提供它 —— 那是模块作用域的，根模块再提供一份不会覆盖它们，
 *    只会让「谁提供的那一份」变得可疑。
 *
 * ── ⚠ 挂上之后，**进程启动就需要一份完整的 env** ──────────────────────
 * 多个模块的工厂会调 `parseEnv()`（Auth 的 `AUTH_CONFIG`、Sources 的 `SOURCE_CONFIG`、
 * Health 与 PublicRead 的 `REDIS_URL`、四个模块的 `createAdminOriginConfig()`）。
 * 缺任何一个都会在**实例化时**抛 `EnvValidationError` —— 这是刻意的：
 * 配置缺失应该在启动时炸，而不是在第一次请求时。
 *
 * 对测试的含义：任何 `imports: [AppModule]` 的用例都必须先种好 env
 *（用 `@signal/test-utils` 的 `TEST_ENV`）—— 见 `apps/api/test/boot.spec.ts`。
 */

import { Module } from '@nestjs/common';
import { CommonModule } from './common/common.module';
import { AdminOpsModule } from './modules/admin-ops/module';
import { AdminReviewModule } from './modules/admin-review/module';
import { AuthModule } from './modules/auth/auth.module';
import { BookmarksModule } from './modules/bookmarks/module';
import { DailyModule } from './modules/daily/module';
import { FeaturedModule } from './modules/featured/module';
import { HealthModule } from './modules/health/module';
import { PublicReadModule } from './modules/public-read/module';
import { ReadingProgressModule } from './modules/reading-progress/module';
import { SearchModule } from './modules/search/module';
import { SourcesModule } from './modules/sources/module';
import { UserPreferencesModule } from './modules/user-preferences/module';

@Module({
  imports: [
    // 地基：必须先于其它模块被解析（它提供 APP_FILTER 与 @Global 的 PrismaModule）。
    CommonModule,

    // 认证（被下面绝大多数模块 import —— Nest 按类去重，这里是显式声明意图）。
    AuthModule,

    // 公开面（游客可读，不加守卫）。
    PublicReadModule,
    SearchModule,
    FeaturedModule,
    DailyModule,

    // 登录用户的三件事。
    BookmarksModule,
    ReadingProgressModule,
    UserPreferencesModule,

    // 后台。
    SourcesModule,
    AdminReviewModule,
    AdminOpsModule,

    // 健康检查（不在 /api/v1 下，见 `bootstrap.ts` 的 exclude）。
    HealthModule,
  ],
  controllers: [],
  providers: [],
})
export class AppModule {}
