/**
 * 用户仓储 —— `users` 表的唯一读写入口。
 *
 * 归属：Agent 02（`tasks/agent-02-auth.md` 允许 `apps/api/src/modules/users/**`）。
 *
 * 为什么要接口 + 实现分离：
 *   Auth 的单元测试必须能在**没有 MySQL** 的机器上跑（`pnpm test` 的既有前提，
 *   见 Agent 01 HANDOFF Known Limitations 第 6 条）。业务服务只依赖
 *   `UserRepository` 接口，测试注入内存假实现即可。
 */

import type { UserRole, UserStatus } from '@signal/contracts';

/** 注入 token。 */
export const USER_REPOSITORY = 'USER_REPOSITORY';

/** 用户档案（BIGINT 已转 string）。 */
export type UserRecord = {
  id: string;
  email: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  role: UserRole;
  status: UserStatus;
  createdAt: Date;
};

/** 创建用户时的输入。 */
export type CreateUserInput = {
  email: string | null;
  displayName: string | null;
  avatarUrl: string | null;
};

export interface UserRepository {
  /** 认证用最小投影（AuthGuard 调用）。 */
  findAuthUserById(id: string): Promise<{ id: string; role: UserRole; status: UserStatus } | null>;

  findById(id: string): Promise<UserRecord | null>;

  findByEmail(email: string): Promise<UserRecord | null>;

  /**
   * 按邮箱找用户，不存在就建（含默认 `UserPreference`）。
   *
   * 必须是**原子**的：OTP 校验通过后并发两次提交同一个码、或用户连点两下，
   * 会同时走到「建用户」。靠 `users.email` 的唯一约束 + 冲突后重读来收敛，
   * 而不是由调用方「先查后写」—— 那样必然产生 P2002，把请求变成 500。
   */
  findOrCreateByEmail(email: string): Promise<UserRecord>;

  /**
   * 建用户，**同时建默认 UserPreference**（Agent 01 HANDOFF 明确要求）。
   * 两步必须在同一事务里，否则会留下没有偏好的用户。
   */
  createWithPreference(input: CreateUserInput): Promise<UserRecord>;
}
