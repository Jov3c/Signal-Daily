/**
 * AuthController —— `docs/04` 的 Auth 段 + `GET /me`。
 *
 * 路径与契约逐字对应（全局前缀 `/api/v1` 由 `bootstrap.ts` 设置）：
 *   POST /auth/email/request-code
 *   POST /auth/email/verify
 *   GET  /auth/github
 *   GET  /auth/github/callback
 *   POST /auth/refresh
 *   POST /auth/logout
 *   GET  /me
 *
 * 本文件**只做 HTTP 适配**：取 Cookie/头、调用服务、写 `Set-Cookie`、
 * 套 `{data}` 封套。所有业务判断都在 `AuthService` 里。
 *
 * 刻意没有的端点（`docs/00` / `docs/13` / 任务禁止项）：
 * 任何改角色的接口、`/subscriptions/*`。
 */

import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { envelope, validationError, type ApiEnvelope } from '@signal/contracts';
import { AuthGuard, extractAccessToken, unauthorizedError } from '../../common/guards/auth.guard';
import { CurrentUser } from '../../common/guards/current-user.decorator';
import { countCookie, readCookie } from '../../common/http/cookies';
import type { AuthUser, HttpRequestLike, HttpResponseLike } from '../../common/http/http-types';
import { readHeader } from '../../common/http/http-types';
import { UsersService } from '../users/users.service';
import type { MeDto } from '../users/dto/me.dto';
import {
  buildClearedOAuthStateCookie,
  buildClearedSessionCookies,
  buildOAuthStateCookie,
} from './auth-cookies';
import { AuthService } from './auth.service';
import { AUTH_CONFIG, type AuthConfig } from './auth.config';
import {
  OAUTH_STATE_COOKIE,
  OAUTH_STATE_TTL_SECONDS,
  REFRESH_TOKEN_COOKIE,
} from './auth.constants';
import {
  parseGithubCallbackQuery,
  parseRequestCodeBody,
  readProviderError,
  parseVerifyCodeBody,
  type AuthSessionResponse,
  type LogoutResponse,
  type RequestCodeResponse,
} from './dto/auth.dto';

/** 可写 Cookie / 重定向的最小响应形状（express 的 `res` 结构上满足）。 */
type CookieResponse = HttpResponseLike & {
  statusCode: number;
  end(body?: string): unknown;
};

type AuthRequest = HttpRequestLike & {
  /** express 提供的 socket 地址兜底。 */
  ip?: string;
  socket?: { remoteAddress?: string };
};

@Controller()
export class AuthController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(UsersService) private readonly users: UsersService,
    @Inject(AUTH_CONFIG) private readonly config: AuthConfig,
  ) {}

  /* ---------------------------------------------------------------- */
  /* Email OTP                                                         */
  /* ---------------------------------------------------------------- */

  @Post('auth/email/request-code')
  @HttpCode(200)
  async requestCode(
    @Body() body: unknown,
    @Req() req: AuthRequest,
  ): Promise<ApiEnvelope<RequestCodeResponse>> {
    const parsed = parseRequestCodeBody(body);
    if (!parsed.ok) throw validationError('Invalid request body', { fields: parsed.errors });

    const result = await this.auth.requestEmailCode(parsed.value.email, requestContext(req));
    return envelope(result);
  }

  @Post('auth/email/verify')
  @HttpCode(200)
  async verifyCode(
    @Body() body: unknown,
    @Req() req: AuthRequest,
    @Res({ passthrough: true }) res: CookieResponse,
  ): Promise<ApiEnvelope<AuthSessionResponse>> {
    const parsed = parseVerifyCodeBody(body);
    if (!parsed.ok) throw validationError('Invalid request body', { fields: parsed.errors });

    const result = await this.auth.verifyEmailCode(
      parsed.value.email,
      parsed.value.code,
      requestContext(req),
    );
    res.setHeader('set-cookie', result.cookies);
    return envelope(result.response);
  }

  /* ---------------------------------------------------------------- */
  /* GitHub OAuth                                                      */
  /* ---------------------------------------------------------------- */

  /**
   * 发起 GitHub 登录：写 state Cookie 后 302 到 GitHub。
   *
   * 未配置 GitHub 时 `startGithubLogin()` 抛 503，异常过滤器会把它写成 JSON
   * —— 也就是说这条路由**要么 302，要么 JSON 错误**，不会出现空响应。
   */
  @Get('auth/github')
  startGithub(@Res() res: CookieResponse): void {
    const { authorizeUrl, state } = this.auth.startGithubLogin();
    res.setHeader('set-cookie', buildOAuthStateCookie(state, this.config, OAUTH_STATE_TTL_SECONDS));
    redirect(res, authorizeUrl);
  }

  /**
   * GitHub 回调。
   *
   * 无论成功失败都**先清掉 state Cookie**，避免同一个 state 被复用。
   * 失败时抛出 AppError（由全局过滤器套封套成 JSON），成功时 302 回站点。
   *
   * 这里用 **非 passthrough** 的 `@Res()`：响应完全由本方法（`redirect`）或
   * 异常过滤器写出，不让 Nest 再覆写状态码。所有分支都会 `end` 或 `throw`。
   */
  @Get('auth/github/callback')
  async githubCallback(
    @Query() query: unknown,
    @Req() req: AuthRequest,
    @Res() res: CookieResponse,
  ): Promise<void> {
    const cookieHeader = readHeader(req, 'cookie');
    // 同名 Cookie 必须恰好一个：多个时无法判断哪个是本次授权留下的，直接拒绝。
    const cookieState =
      countCookie(cookieHeader, OAUTH_STATE_COOKIE) === 1
        ? readCookie(cookieHeader, OAUTH_STATE_COOKIE)
        : undefined;

    const clearState = buildClearedOAuthStateCookie(this.config);

    // ① 先看 GitHub 是否直接回了错误（例如用户点了「取消」）。
    //    ⚠ 这个分支必须排在 code/state 校验**之前**：取消授权时 GitHub 只回
    //    `error=access_denied`，不会带 code，先校验就会把「取消」变成 400。
    if (readProviderError(query) !== null) {
      res.setHeader('set-cookie', clearState);
      redirect(res, this.config.appBaseUrl);
      return;
    }

    // ② 正常回调：code 与 state 缺一不可。
    const parsed = parseGithubCallbackQuery(query);
    if (!parsed.ok) {
      res.setHeader('set-cookie', clearState);
      throw validationError('Invalid OAuth callback', { fields: parsed.errors });
    }

    try {
      const result = await this.auth.completeGithubLogin({
        code: parsed.value.code,
        state: parsed.value.state,
        cookieState,
        context: requestContext(req),
      });
      res.setHeader('set-cookie', [...result.cookies, clearState]);
      redirect(res, result.redirectUrl);
    } catch (error) {
      res.setHeader('set-cookie', clearState);
      throw error;
    }
  }

  /* ---------------------------------------------------------------- */
  /* Session                                                           */
  /* ---------------------------------------------------------------- */

  @Post('auth/refresh')
  @HttpCode(200)
  async refresh(
    @Req() req: AuthRequest,
    @Res({ passthrough: true }) res: CookieResponse,
  ): Promise<ApiEnvelope<AuthSessionResponse>> {
    const refreshToken = readCookie(readHeader(req, 'cookie'), REFRESH_TOKEN_COOKIE);
    const result = await this.auth.refresh(refreshToken, requestContext(req));
    res.setHeader('set-cookie', result.cookies);
    return envelope(result.response);
  }

  @Post('auth/logout')
  @HttpCode(200)
  async logout(
    @Req() req: AuthRequest,
    @Res({ passthrough: true }) res: CookieResponse,
  ): Promise<ApiEnvelope<LogoutResponse>> {
    const refreshToken = readCookie(readHeader(req, 'cookie'), REFRESH_TOKEN_COOKIE);
    // 只带 access token（例如原生的非浏览器客户端只用 Authorization 头）时，
    // 也必须能登出 —— 否则「登出返回 200 但会话还在」，是静默失效。
    const accessToken = extractAccessToken(req);

    // 刻意不用 AuthGuard：access token 只有 15 分钟，过期后就登不出去了。
    // 会话由 refresh token 或 access token 定位，都拿不到就当已经登出（幂等）。
    await this.auth.logout({ refreshToken, accessToken });

    res.setHeader('set-cookie', buildClearedSessionCookies(this.config));
    return envelope({ loggedOut: true });
  }

  /* ---------------------------------------------------------------- */
  /* Me                                                                */
  /* ---------------------------------------------------------------- */

  @Get('me')
  @UseGuards(AuthGuard)
  async me(@CurrentUser() user: AuthUser | undefined): Promise<ApiEnvelope<MeDto>> {
    // 有 AuthGuard 时 user 必然存在；这里仍显式判空，避免守卫被误移除后静默返回 null。
    if (user === undefined) throw unauthorizedError();
    return envelope(await this.users.getMe(user.id));
  }
}

/**
 * 取客户端 IP。
 *
 * ⚠ 取 **XFF 的最后一段**，而不是第一段。
 *
 * 独立审查实测：取第一段时，客户端只要伪造 `X-Forwarded-For: 1.2.3.4`
 * 就能让 per-IP 限流完全失效（30 次请求 30 次放行）。因为第一段是**客户端自己写的**。
 *
 * 最后一段的语义是「**最后一跳代理直接看到的对端地址**」：
 *   - nginx 默认 `$proxy_add_x_forwarded_for`（追加）→ 末段 = nginx 看到的真实客户端 IP；
 *     客户端就算在前面塞垃圾，也只影响前面的段。
 *   - nginx 写成 `$remote_addr`（覆盖）→ 只有一段，末段即真实 IP。
 * 两种配置下都不可由客户端伪造，因此无需依赖 nginx 的具体写法。
 *
 * 仍需 Agent 11/14 保证 API **不经 nginx 直接对公网暴露**；若直连，
 * `req.socket.remoteAddress` 才是可信来源（此时 XFF 由客户端自填，不可信）。
 * 已记入 HANDOFF 的阻塞要求。
 *
 * 即便 IP 维度被绕过，per-email 维度仍然有效，验证码爆破窗口依旧受限。
 */
function clientIp(req: AuthRequest): string | undefined {
  const forwarded = readHeader(req, 'x-forwarded-for');
  if (forwarded !== undefined) {
    const hops = forwarded
      .split(',')
      .map((hop) => hop.trim())
      .filter((hop) => hop !== '');
    const last = hops.at(-1);
    if (last !== undefined) return last;
  }
  return req.ip ?? req.socket?.remoteAddress;
}

function requestContext(req: AuthRequest): {
  ip: string | undefined;
  userAgent: string | undefined;
} {
  return { ip: clientIp(req), userAgent: readHeader(req, 'user-agent') };
}

/** 302 重定向（不引入 express 类型）。 */
function redirect(res: CookieResponse, location: string): void {
  res.statusCode = 302;
  res.setHeader('location', location);
  res.end();
}
