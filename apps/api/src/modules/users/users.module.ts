/**
 * UsersModule —— 用户身份。
 *
 * 只导出 `USER_REPOSITORY` 与 `UsersService`。
 * 认证主体查询（AuthGuard 用）走 `sessions` 表的 join，属于 AuthModule，
 * 因此不在这里绑定。
 */

import { Module } from '@nestjs/common';
import { PrismaUserRepository } from './prisma-user.repository';
import { USER_REPOSITORY } from './user.repository';
import { UsersService } from './users.service';

@Module({
  providers: [{ provide: USER_REPOSITORY, useClass: PrismaUserRepository }, UsersService],
  exports: [USER_REPOSITORY, UsersService],
})
export class UsersModule {}
