/**
 * AdminGuard —— 管理员守卫。**供 Agent 03 / 07 / 12 用于 `/api/v1/admin/*` 复用。**
 *
 * `docs/14`：Admin endpoint 强制 auth + role。
 *
 * 实现上**刻意不用继承**：TypeScript 不会把基类构造函数的 `design:paramtypes`
 * 元数据带到子类，Nest 的注入器在子类上拿不到依赖，会静默注入 `undefined`。
 * 这里改为显式委托给 `AuthGuard`，顺序固定：先认证，再判角色。
 */

import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { AppError, PlatformErrorCode, UserRole } from '@signal/contracts';
import type { HttpRequestLike } from '../http/http-types';
import { AuthGuard } from './auth.guard';

/** 权限不足文案。不回显所需角色，避免给探测者额外信息。 */
export const FORBIDDEN_MESSAGE = 'Administrator privileges required';

@Injectable()
export class AdminGuard implements CanActivate {
  // ⚠ 显式 @Inject：不要依赖 `emitDecoratorMetadata`。
  // 一旦 import 被写成 `import type`（`consistent-type-imports` 的自动修复就会这么干），
  // 编译产物里的 `design:paramtypes` 会退化成 `Function`，Nest 在**生产构建**中
  // 解析不到依赖 —— 而所有测试（跑的是另一套 transform）仍然是绿的。
  constructor(@Inject(AuthGuard) private readonly authGuard: AuthGuard) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // 未认证会在这里抛 401，不会降级成 403 —— 这是刻意的：
    // 403 意味着「你的身份我们知道，但不够」，401 才是「先登录」。
    await this.authGuard.canActivate(context);

    const req = context.switchToHttp().getRequest<HttpRequestLike>();
    if (req.authUser?.role !== UserRole.ADMIN) {
      throw new AppError({
        code: PlatformErrorCode.FORBIDDEN,
        httpStatus: 403,
        safeMessage: FORBIDDEN_MESSAGE,
      });
    }

    return true;
  }
}
