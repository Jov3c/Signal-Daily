/**
 * `UserPreferencesModule` —— 阅读偏好的装配。
 *
 * ⚠ **不要把它挂到 `apps/api/src/app.module.ts`** —— 根注册由 Agent 14 统一完成。
 * `imports: [AuthModule]` 是必需的（`AuthGuard` 及其依赖由 AuthModule 导出）。
 */

import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { UserPreferenceController } from './controller';
import { USER_PREFERENCE_REPOSITORY } from './repository';
import { PrismaUserPreferenceRepository } from './prisma-user-preferences.repository';
import { UserPreferenceService } from './service';

@Module({
  imports: [AuthModule],
  controllers: [UserPreferenceController],
  providers: [
    { provide: USER_PREFERENCE_REPOSITORY, useClass: PrismaUserPreferenceRepository },
    UserPreferenceService,
  ],
  exports: [UserPreferenceService, USER_PREFERENCE_REPOSITORY],
})
export class UserPreferencesModule {}
