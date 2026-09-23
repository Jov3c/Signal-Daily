/**
 * Prisma 枚举 ↔ `@signal/contracts` 枚举的桥接。
 *
 * 问题：Prisma 为每个 enum 生成自己的 TS 枚举类型，`@signal/contracts` 也有一套。
 * 两套**值完全相同**（有测试守卫保证），但在 TypeScript 里是两个互不兼容的
 * nominal 类型，直接赋值必然报 TS2322。
 *
 * 解决：在仓储边界做一次**运行期校验**的收敛，而不是 `as` 硬转。
 * 这样「库里出现了契约里没有的值」会在边界立刻炸掉，
 * 而不是带着一个非法的 role 一路走到授权判断里。
 *
 * **下游 Agent（05 / 07 / 08 / 09 / 10）请复用本函数，不要各写一个 `as`。**
 */

import type { UserRole, UserStatus } from '@signal/contracts';
import { USER_ROLES, USER_STATUSES } from '@signal/contracts';

/**
 * 把 Prisma 的枚举值收敛为契约枚举值。
 *
 * @param allowed 契约侧的运行期取值数组（如 `USER_ROLES`）
 * @param value   Prisma 返回的值
 * @param label   出错信息里的人类可读名（如 `'UserRole'`）
 */
export function toContractEnum<T extends string>(
  allowed: readonly T[],
  value: string,
  label: string,
): T {
  if ((allowed as readonly string[]).includes(value)) return value as T;
  throw new Error(`Unexpected ${label} value from database: ${value}`);
}

export function toUserRole(value: string): UserRole {
  return toContractEnum(USER_ROLES, value, 'UserRole');
}

export function toUserStatus(value: string): UserStatus {
  return toContractEnum(USER_STATUSES, value, 'UserStatus');
}
