/**
 * `@CurrentUser()` —— 从请求里取 AuthGuard 写入的认证主体。
 *
 * 必须在 `@UseGuards(AuthGuard)` / `AdminGuard` 之后使用；否则取到 `undefined`。
 * 这里不抛异常：装饰器返回值直接进入业务代码，让业务自己决定「未认证」是否合法。
 */

import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { AuthUser, HttpRequestLike } from '../http/http-types';

export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthUser | undefined =>
    context.switchToHttp().getRequest<HttpRequestLike>().authUser,
);

/** 取认证主体，缺失即抛错。用于「一定已认证」的路由，省掉业务里的判空。 */
export function requireAuthUser(req: HttpRequestLike): AuthUser {
  if (req.authUser === undefined) {
    throw new Error('requireAuthUser() 必须在 AuthGuard 之后调用');
  }
  return req.authUser;
}
