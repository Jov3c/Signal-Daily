/**
 * Admin 变更请求的 Origin 校验 —— `docs/14`：
 * 「敏感 Admin mutation 进行 Origin check」。
 *
 * ── ⚠ 这是同一件事的第二份实现（已提 CCR）────────────────────────────
 * 第一份在 Agent 03 的 `modules/sources/admin-origin.guard.ts`，
 * 它的 CCR 第 7 项已经建议把它提到 `common/`「一次覆盖 03/07/12」。
 * 那个建议**至今未裁决**，所以我按 §9「只改自己模块目录」写在本地，
 * 并把这条重复一并记进本模块的 CCR。
 *
 * 为什么不直接 import Agent 03 的那一份：它依赖 `SOURCE_CONFIG`
 *（`modules/sources/source.config.ts`）—— 复用守卫就得连带复用那个模块的
 * 配置装配，两个模块的生命周期会绑在一起。而这里只需要两个 env 值。
 *
 * ── 语义（与 Agent 03 逐条一致）────────────────────────────────────
 * - **只拦变更类方法**：GET / HEAD / OPTIONS 直接放行（它们不改状态）；
 * - **没有 `Origin` 头就放行**：同源的 curl / 服务端调用不带该头，
 *   而它们本来就不是 CSRF 的攻击面（CSRF 靠的是浏览器自动带 Cookie）；
 * - **`Origin: null` 会被拒**：沙箱 iframe / `file://` 会发它，不在允许集合里；
 * - **不回显收到的 Origin**：那是攻击者可控的字符串，只回显我们自己的允许列表。
 */

import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { AppError, PlatformErrorCode } from '@signal/contracts';
import { parseEnv } from '@signal/config';

/** 注入 token。 */
export const ADMIN_ORIGIN_CONFIG = 'ADMIN_ORIGIN_CONFIG';

/** 不需要 Origin 校验的方法（它们不改状态）。 */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** 最小化的请求形状（避免为了类型 import Express 的 Request）。 */
type HttpRequestLike = {
  method?: string;
  headers?: Record<string, string | string[] | undefined>;
};

export type AdminOriginConfig = {
  allowedOrigins: ReadonlySet<string>;
};

/** 取 URL 的 origin（协议 + 主机 + 端口）；非法 URL → `null`。 */
function originOf(url: string | undefined): string | null {
  if (url === undefined || url === '') return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** 从 env 构造允许列表。 */
export function createAdminOriginConfig(
  env: { APP_BASE_URL: string; API_BASE_URL: string } = parseEnv(),
): AdminOriginConfig {
  const allowed = new Set<string>();
  for (const candidate of [env.APP_BASE_URL, env.API_BASE_URL]) {
    const origin = originOf(candidate);
    if (origin !== null) allowed.add(origin);
  }
  return { allowedOrigins: allowed };
}

function readHeader(request: HttpRequestLike, name: string): string | undefined {
  const value = request.headers?.[name];
  if (Array.isArray(value)) return value[0];
  return value;
}

@Injectable()
export class AdminOriginGuard implements CanActivate {
  private readonly allowed: ReadonlySet<string>;

  constructor(@Inject(ADMIN_ORIGIN_CONFIG) config: AdminOriginConfig) {
    this.allowed = config.allowedOrigins;
  }

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<HttpRequestLike>();
    const method = (request.method ?? 'GET').toUpperCase();
    if (SAFE_METHODS.has(method)) return true;

    const origin = readHeader(request, 'origin');
    if (origin === undefined || origin === '') return true;

    if (this.allowed.has(origin)) return true;

    throw new AppError({
      code: PlatformErrorCode.FORBIDDEN,
      httpStatus: 403,
      safeMessage: 'Cross-origin request rejected',
      // 不回显收到的 Origin —— 只回显自己的允许列表，方便排查部署配置。
      details: { allowedOrigins: [...this.allowed] },
    });
  }
}
