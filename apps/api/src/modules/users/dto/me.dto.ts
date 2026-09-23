/**
 * `GET /me` 的响应 DTO。
 *
 * ⚠ 按 `docs/18` 的规则，跨 app 的 DTO 应放 `packages/contracts`；但该包是
 * Agent 00 的冻结区，Agent 02 不得就地新增类型。因此这里先落在模块内，
 * 并已提交 `handoffs/CONTRACT_CHANGE_REQUEST-agent-02.md` 请求后续提升，
 * 供 Agent 09 / 12 / 13 共享。
 *
 * 不含任何凭据：没有 token、没有 OTP、没有 provider access token。
 */

import type { UserRole } from '@signal/contracts';
import type { UserRecord } from '../user.repository';

export type MeDto = {
  /** BIGINT → string（docs/02）。 */
  id: string;
  email: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  role: UserRole;
  createdAt: string;
};

/** 领域记录 → 对外 DTO。时间统一 ISO 8601 UTC（docs/04）。 */
export function toMeDto(user: UserRecord): MeDto {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
    role: user.role,
    createdAt: user.createdAt.toISOString(),
  };
}
