/**
 * `UserRepository` 的 Prisma 实现。
 */

import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { toBigIntId, toIdString } from '../../common/prisma/bigint-id';
import { toUserRole, toUserStatus } from '../../common/prisma/prisma-enums';
import type { CreateUserInput, UserRecord, UserRepository } from './user.repository';

/** Prisma 行 → 领域记录。BIGINT 转 string，枚举收敛到契约枚举。 */
function toUserRecord(row: {
  id: bigint;
  email: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  role: string;
  status: string;
  createdAt: Date;
}): UserRecord {
  return {
    id: toIdString(row.id),
    email: row.email,
    displayName: row.displayName,
    avatarUrl: row.avatarUrl,
    role: toUserRole(row.role),
    status: toUserStatus(row.status),
    createdAt: row.createdAt,
  };
}

@Injectable()
export class PrismaUserRepository implements UserRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async findAuthUserById(
    id: string,
  ): Promise<{ id: string; role: UserRecord['role']; status: UserRecord['status'] } | null> {
    const bigIntId = toBigIntId(id);
    if (bigIntId === null) return null;

    const row = await this.prisma.user.findUnique({
      where: { id: bigIntId },
      select: { id: true, role: true, status: true },
    });
    if (row === null) return null;

    return {
      id: toIdString(row.id),
      role: toUserRole(row.role),
      status: toUserStatus(row.status),
    };
  }

  async findById(id: string): Promise<UserRecord | null> {
    const bigIntId = toBigIntId(id);
    if (bigIntId === null) return null;

    const row = await this.prisma.user.findUnique({ where: { id: bigIntId } });
    return row === null ? null : toUserRecord(row);
  }

  async findByEmail(email: string): Promise<UserRecord | null> {
    const row = await this.prisma.user.findUnique({ where: { email } });
    return row === null ? null : toUserRecord(row);
  }

  async findOrCreateByEmail(email: string): Promise<UserRecord> {
    const existing = await this.findByEmail(email);
    if (existing !== null) return existing;

    try {
      return await this.createWithPreference({ email, displayName: null, avatarUrl: null });
    } catch (error) {
      // 并发创建：唯一约束挡住了后来者，重读即可。
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const raced = await this.findByEmail(email);
        if (raced !== null) return raced;
      }
      throw error;
    }
  }

  async createWithPreference(input: CreateUserInput): Promise<UserRecord> {
    // 事务：users 与 user_preferences 必须同时存在，否则前端读偏好会缺行。
    const row = await this.prisma.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: {
          email: input.email,
          displayName: input.displayName,
          avatarUrl: input.avatarUrl,
        },
      });
      await tx.userPreference.create({ data: { userId: created.id } });
      return created;
    });

    return toUserRecord(row);
  }
}
