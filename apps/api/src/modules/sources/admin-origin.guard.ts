/**
 * AdminOriginGuard —— 对 `/admin/*` 的**变更类请求**做 Origin 校验。
 *
 * 归属：Agent 03 落地（`docs/14`：「敏感 Admin mutation 进行 Origin check + CSRF token」）。
 * Agent 02 的 HANDOFF 明确把 `/admin/*` 的这块留给 03 / 07 / 12。
 *
 * ── 为什么是「带了 Origin 就必须匹配」，而不是「必须带 Origin」────────
 * 非浏览器客户端（curl、运维脚本、CI 探针）**不会**带 `Origin` 头。
 * 强制要求它会把运维通道一起打死。而 CSRF 的前提是**浏览器**发起的跨站请求 ——
 * 浏览器对 POST/PATCH 一定会带 `Origin`。所以：
 *
 *   带了 Origin  → 必须匹配允许的源，否则 403
 *   没带 Origin  → 放行（不可能是浏览器 CSRF）
 *
 * ── 与 SameSite=Lax 的关系 ─────────────────────────────────────────
 * 会话 Cookie 是 `SameSite=Lax`，它已经挡住了**跨站**表单 POST（不带 Cookie）。
 * 但 Lax 不挡「同站不同子域」：`evil.signal.example.com` 与
 * `signal.example.com` 属于同一 registrable domain，仍会带上 Cookie。
 * 一个被攻陷的子域足以发起 CSRF —— 这正是 `docs/14` 要求 Origin check 的原因。
 *
 * ── 已记录的残余风险 ─────────────────────────────────────────────
 * 本守卫只做 Origin check，**没有** CSRF token。见 HANDOFF 的 Known Limitations
 * 与 `CONTRACT_CHANGE_REQUEST-agent-03.md` 第 7 项：
 * CSRF 是横切关注点，更适合放在公共层一次覆盖 03 / 07 / 12。
 */

import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { AppError, PlatformErrorCode } from '@signal/contracts';
import { readHeader, type HttpRequestLike } from '../../common/http';
import { SOURCE_CONFIG, type SourceConfig } from './source.config';

/** 不修改状态的方法不需要 Origin 校验。 */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** 取一个 URL 的 origin（`scheme://host[:port]`），非法输入返回 null。 */
export function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

@Injectable()
export class AdminOriginGuard implements CanActivate {
  private readonly allowed: ReadonlySet<string>;

  // ⚠ 显式 @Inject：不要依赖 emitDecoratorMetadata（见 di-wiring.spec.ts）。
  constructor(@Inject(SOURCE_CONFIG) config: SourceConfig) {
    const allowed = new Set<string>();
    for (const candidate of [config.appBaseUrl, config.apiBaseUrl]) {
      const origin = originOf(candidate);
      if (origin !== null) allowed.add(origin);
    }
    this.allowed = allowed;
  }

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<HttpRequestLike>();
    const method = (req.method ?? 'GET').toUpperCase();
    if (SAFE_METHODS.has(method)) return true;

    // 注意：这里读的是**原始请求头**，不做任何猜测。
    const origin = readHeader(req, 'origin');
    if (origin === undefined || origin === '') return true;

    // `Origin: null`（沙箱 iframe / file:// / 某些跨源重定向）不在允许集合里，
    // 因此会被拒绝 —— 这是刻意的。
    if (this.allowed.has(origin)) return true;

    throw new AppError({
      code: PlatformErrorCode.FORBIDDEN,
      httpStatus: 403,
      safeMessage: 'Cross-origin request rejected',
      // 不回显收到的 Origin：那会把攻击者可控的字符串送进日志与响应。
      // 只回显我们自己的允许列表，方便排查部署配置。
      details: { allowedOrigins: [...this.allowed] },
    });
  }
}
