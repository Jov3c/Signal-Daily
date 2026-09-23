/**
 * Access Token 的签发与校验（HS256 JWT，`docs/11`：15 分钟）。
 *
 * 安全要点：
 *   - **显式锁定 `algorithms: ['HS256']`**。不写这一项，`jsonwebtoken` 会接受算法
 *     与密钥协商产生的混淆（经典 `alg: none` / RS256→HS256 攻击面）。
 *   - 校验 `iss` / `aud`：防止别的服务的 token 在本服务被当成合法凭据。
 *   - 载荷里**只放** sub / sid / role。不放邮箱、不放姓名 —— JWT 是 base64 而非加密，
 *     任何拿到 token 的人都能读。
 */

import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import jwt from 'jsonwebtoken';
import { AppError, PlatformErrorCode, UserRole } from '@signal/contracts';
import type { AccessTokenClaims, AccessTokenVerifier } from '../../common/guards/ports';
import { ACCESS_TOKEN_TTL_SECONDS } from './auth.constants';
import { AUTH_CONFIG, type AuthConfig } from './auth.config';

/** JWT 签发方与受众（固定值，不来自 env —— `docs/20` 没有这两个变量）。 */
export const ACCESS_TOKEN_ISSUER = 'signal';
export const ACCESS_TOKEN_AUDIENCE = 'signal-api';

/** 注入 token。 */
export const ACCESS_TOKEN_SERVICE = 'ACCESS_TOKEN_SERVICE';

@Injectable()
export class AccessTokenService implements AccessTokenVerifier {
  constructor(@Inject(AUTH_CONFIG) private readonly config: AuthConfig) {}

  /** 签发 access token。`sub` 与 `sid` 都是 BIGINT 的字符串形式。 */
  signAccessToken(params: { userId: string; sessionId: string; role: UserRole }): string {
    return jwt.sign({ sid: params.sessionId, role: params.role }, this.config.accessTokenSecret, {
      algorithm: 'HS256',
      subject: params.userId,
      issuer: ACCESS_TOKEN_ISSUER,
      audience: ACCESS_TOKEN_AUDIENCE,
      expiresIn: ACCESS_TOKEN_TTL_SECONDS,
      jwtid: randomUUID(),
      noTimestamp: false,
    });
  }

  /**
   * 校验并解码。任何异常都收敛为 `UNAUTHORIZED`，
   * 且**不把底层原因**（签名错 / 过期 / 格式错）回给客户端。
   */
  verifyAccessToken(token: string): AccessTokenClaims {
    let decoded: unknown;
    try {
      decoded = jwt.verify(token, this.config.accessTokenSecret, {
        algorithms: ['HS256'],
        issuer: ACCESS_TOKEN_ISSUER,
        audience: ACCESS_TOKEN_AUDIENCE,
        clockTolerance: 0,
      });
    } catch {
      throw unauthorized();
    }

    return toClaims(decoded);
  }
}

function unauthorized(): AppError {
  return new AppError({
    code: PlatformErrorCode.UNAUTHORIZED,
    httpStatus: 401,
    safeMessage: 'Authentication required',
  });
}

/**
 * 把 JWT 载荷收敛成 `AccessTokenClaims`。
 *
 * 这里做**结构校验**而不是直接 cast：token 是外部输入，
 * 一个 `role: "ADMIN"` 之外的任意字符串都不该进入授权判断。
 */
function toClaims(decoded: unknown): AccessTokenClaims {
  if (typeof decoded !== 'object' || decoded === null) throw unauthorized();

  const payload = decoded as Record<string, unknown>;
  const sub = payload.sub;
  const sid = payload.sid;
  const role = payload.role;

  if (typeof sub !== 'string' || !/^\d{1,20}$/.test(sub)) throw unauthorized();
  if (typeof sid !== 'string' || sid === '') throw unauthorized();
  if (role !== UserRole.USER && role !== UserRole.ADMIN) throw unauthorized();

  return { userId: sub, sessionId: sid, role };
}
