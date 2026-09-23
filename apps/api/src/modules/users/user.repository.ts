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

/**
 * 与 `prisma/schema.prisma` 的列宽一致。
 *
 * 存在的理由：`displayName` / `avatarUrl` 的值来自**外部**（GitHub 资料），
 * 长度不受我们控制。超过列宽会抛 Prisma P2000，冒泡成 500 ——
 * 独立审查实测：GitHub 昵称超过 120 字符时，该用户**永久无法用 GitHub 登录**
 * （每次回调都 500）。在仓储边界截断是最后一道防线。
 *
 * 注意：`email` **不截断**（截断后的地址可能属于另一个人），
 * 由调用方判断「太长的邮箱直接丢弃」。
 */
export const USER_FIELD_LIMITS = {
  displayName: 120,
  avatarUrl: 1024,
} as const;

/** 按列宽截断可选的展示型字段。 */
export function clampToColumn(value: string | null, maxLength: number): string | null {
  if (value === null) return null;
  return value.length <= maxLength ? value : value.slice(0, maxLength);
}

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
   *
   * @param defaults 只在**新建**时使用的展示字段（GitHub 的昵称 / 头像）。
   *   已存在的用户**绝不覆盖** —— 用户可能已经改过自己的资料。
   *   缺了它，首次 GitHub 登录建出来的用户会丢掉昵称与头像。
   */
  findOrCreateByEmail(
    email: string,
    defaults?: { displayName?: string | null; avatarUrl?: string | null },
  ): Promise<UserRecord>;

  /**
   * 建用户，**同时建默认 UserPreference**（Agent 01 HANDOFF 明确要求）。
   * 两步必须在同一事务里，否则会留下没有偏好的用户。
   */
  createWithPreference(input: CreateUserInput): Promise<UserRecord>;
}
