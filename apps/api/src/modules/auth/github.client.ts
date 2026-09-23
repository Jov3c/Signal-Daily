/**
 * GitHub OAuth 客户端（端口 + fetch 实现）。
 *
 * 端口化的理由：callback 的测试必须能在**不联网**的前提下覆盖
 * 「state 不匹配」「GitHub 返回错误」「邮箱未验证」等分支。
 *
 * 安全（`docs/14`）：
 *   - GitHub 的响应体**不得**进入日志或错误详情 —— 里面就有 access token。
 *   - 只把 HTTP 状态码放进 `cause`，不转发 body。
 *   - 明确超时，避免外部 API 挂起拖死请求。
 */

import { Inject, Injectable } from '@nestjs/common';
import { AppError, DomainErrorCode } from '@signal/contracts';
import { AUTH_CONFIG, type AuthConfig, type GithubOAuthConfig } from './auth.config';

/** 注入 token。 */
export const GITHUB_CLIENT = 'GITHUB_CLIENT';

/** 外部调用的超时（毫秒）。不是 env：`docs/20` 没有对应变量，且与采集超时无关。 */
export const GITHUB_REQUEST_TIMEOUT_MS = 10_000;

/** 归一化后的 GitHub 用户资料。 */
export type GithubProfile = {
  /** GitHub 用户 id（数字），字符串形式。 */
  providerAccountId: string;
  login: string;
  name: string | null;
  avatarUrl: string | null;
  /** 仅当存在「已验证的主邮箱」时才有值。 */
  email: string | null;
};

export interface GithubClient {
  /** 构造跳转到 GitHub 的授权地址。 */
  buildAuthorizeUrl(state: string): string;
  /** 用 code 换 access token。失败抛 `AUTH_OAUTH_EXCHANGE_FAILED`。 */
  exchangeCodeForToken(code: string): Promise<string>;
  /** 用 access token 读用户资料 + 主邮箱。失败抛 `AUTH_OAUTH_EXCHANGE_FAILED`。 */
  fetchProfile(accessToken: string): Promise<GithubProfile>;
}

/**
 * OAuth 交换失败（对上游而言是网关错误）。
 *
 * `details` 只放上游状态码：GitHub 的错误响应体里可能含凭据，一律不转发。
 */
export function oauthExchangeFailed(
  extras: { cause?: unknown; upstreamStatus?: number } = {},
): AppError {
  return new AppError({
    code: DomainErrorCode.AUTH_OAUTH_EXCHANGE_FAILED,
    httpStatus: 502,
    safeMessage: 'GitHub OAuth exchange failed',
    details: extras.upstreamStatus === undefined ? null : { upstreamStatus: extras.upstreamStatus },
    cause: extras.cause,
  });
}

@Injectable()
export class FetchGithubClient implements GithubClient {
  constructor(@Inject(AUTH_CONFIG) private readonly config: AuthConfig) {}

  buildAuthorizeUrl(state: string): string {
    const github = this.requireGithub();
    const url = new URL('https://github.com/login/oauth/authorize');
    url.searchParams.set('client_id', github.clientId);
    url.searchParams.set('redirect_uri', github.callbackUrl);
    // 只申请身份与邮箱：不需要 repo 等任何写权限。
    url.searchParams.set('scope', 'read:user user:email');
    url.searchParams.set('state', state);
    url.searchParams.set('allow_signup', 'true');
    return url.toString();
  }

  async exchangeCodeForToken(code: string): Promise<string> {
    const github = this.requireGithub();

    const response = await this.request('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        client_id: github.clientId,
        client_secret: github.clientSecret,
        code,
        redirect_uri: github.callbackUrl,
      }).toString(),
    });

    const payload = (await readJson(response)) as {
      access_token?: unknown;
      error?: unknown;
    };

    // ⚠ GitHub 在 code 非法时**返回 HTTP 200**，错误放在 body 的 `error` 字段，
    // 只看状态码会把失败当成功，随后拿着空 token 去读资料，错误更难定位。
    if (typeof payload.access_token !== 'string' || payload.access_token === '') {
      throw oauthExchangeFailed();
    }
    return payload.access_token;
  }

  async fetchProfile(accessToken: string): Promise<GithubProfile> {
    const headers = {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${accessToken}`,
      // GitHub API 强制要求 User-Agent。
      'user-agent': 'signal-app',
      'x-github-api-version': '2022-11-28',
    };

    const userResponse = await this.request('https://api.github.com/user', { headers });
    const user = (await readJson(userResponse)) as {
      id?: unknown;
      login?: unknown;
      name?: unknown;
      avatar_url?: unknown;
      email?: unknown;
    };

    if (typeof user.id !== 'number' || typeof user.login !== 'string') {
      throw oauthExchangeFailed();
    }

    const email = await this.resolveVerifiedEmail(headers, user.email);

    return {
      providerAccountId: String(user.id),
      login: user.login,
      name: typeof user.name === 'string' ? user.name : null,
      avatarUrl: typeof user.avatar_url === 'string' ? user.avatar_url : null,
      email,
    };
  }

  /**
   * 取「已验证的主邮箱」。
   *
   * `GET /user` 的 `email` 字段在用户把邮箱设为私有时为 null，且**不保证已验证**，
   * 所以一律以 `/user/emails` 的结果为准；拿不到就返回 null（调用方不允许用
   * 未验证邮箱绑定账号）。
   */
  private async resolveVerifiedEmail(
    headers: Record<string, string>,
    fallback: unknown,
  ): Promise<string | null> {
    try {
      const response = await this.request('https://api.github.com/user/emails', { headers });
      const emails = (await readJson(response)) as unknown;
      if (Array.isArray(emails)) {
        const verified = emails.filter(
          (item): item is { email: string; primary?: boolean; verified?: boolean } =>
            typeof item === 'object' &&
            item !== null &&
            typeof (item as { email?: unknown }).email === 'string' &&
            (item as { verified?: unknown }).verified === true,
        );
        const primary = verified.find((item) => item.primary === true);
        if (primary !== undefined) return primary.email;
        if (verified[0] !== undefined) return verified[0].email;
      }
    } catch {
      // 邮箱端点失败不应让整个登录失败 —— 只是拿不到邮箱而已。
    }

    return typeof fallback === 'string' && fallback !== '' ? fallback : null;
  }

  private async request(url: string, init: RequestInit): Promise<Response> {
    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw oauthExchangeFailed({ cause: error });
    }
    if (!response.ok) {
      // 只带状态码，绝不带 body。
      throw oauthExchangeFailed({ upstreamStatus: response.status });
    }
    return response;
  }

  private requireGithub(): GithubOAuthConfig {
    if (this.config.github === null) {
      throw new AppError({
        code: DomainErrorCode.AUTH_GITHUB_NOT_CONFIGURED,
        httpStatus: 503,
        safeMessage: 'GitHub sign-in is not configured',
      });
    }
    return this.config.github;
  }
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch (error) {
    throw oauthExchangeFailed({ cause: error });
  }
}
