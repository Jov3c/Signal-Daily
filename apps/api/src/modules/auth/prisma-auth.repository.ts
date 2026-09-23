/**
 * `AuthRepository` 的 Prisma 实现。
 *
 * 所有涉及「先改状态、再判结果」的写入都走 `updateMany` + 影响行数，
 * 而不是「先查后写」—— 后者在并发下必然出错。
 */

import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { toBigIntId } from '../../common/prisma/bigint-id';
import { toUserRole, toUserStatus } from '../../common/prisma/prisma-enums';
import type { AuthenticatedSession } from '../../common/guards/ports';
import {
  type AuthAccountRecord,
  type AuthRepository,
  type CreateOtpInput,
  type CreateSessionInput,
  type OtpRecord,
  type SessionRecord,
} from './repository';

/** 唯一约束冲突（并发插入）。 */
function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

@Injectable()
export class PrismaAuthRepository implements AuthRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async replaceActiveOtp(input: CreateOtpInput, now: Date): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.emailOtpCode.updateMany({
        where: { email: input.email, consumedAt: null },
        // 用「置为已消费」而不是删除：保留短期审计痕迹，也让重放能被识别。
        data: { consumedAt: now },
      });
      await tx.emailOtpCode.create({
        data: {
          email: input.email,
          codeHash: input.codeHash,
          expiresAt: input.expiresAt,
          requestIpHash: input.requestIpHash,
        },
      });
    });
  }

  async findLatestUnconsumedOtp(email: string): Promise<OtpRecord | null> {
    const row = await this.prisma.emailOtpCode.findFirst({
      where: { email, consumedAt: null },
      orderBy: { id: 'desc' },
      select: { id: true, codeHash: true, expiresAt: true },
    });
    return row === null
      ? null
      : { id: String(row.id), codeHash: row.codeHash, expiresAt: row.expiresAt };
  }

  async findRecentlyConsumedOtp(email: string, since: Date): Promise<OtpRecord | null> {
    const row = await this.prisma.emailOtpCode.findFirst({
      where: { email, consumedAt: { not: null, gte: since } },
      orderBy: { id: 'desc' },
      select: { id: true, codeHash: true, expiresAt: true },
    });
    return row === null
      ? null
      : { id: String(row.id), codeHash: row.codeHash, expiresAt: row.expiresAt };
  }

  async consumeOtp(id: string, consumedAt: Date): Promise<boolean> {
    const bigIntId = toBigIntId(id);
    if (bigIntId === null) return false;

    // 条件更新：只有 still-unconsumed 的行会被改动。
    const result = await this.prisma.emailOtpCode.updateMany({
      where: { id: bigIntId, consumedAt: null },
      data: { consumedAt },
    });
    return result.count === 1;
  }

  async createSession(input: CreateSessionInput): Promise<{ id: string }> {
    const userId = toBigIntId(input.userId);
    if (userId === null) throw new Error('createSession: userId 不是合法的 BIGINT');

    const row = await this.prisma.session.create({
      data: {
        userId,
        refreshTokenHash: input.refreshTokenHash,
        expiresAt: input.expiresAt,
        userAgentHash: input.userAgentHash,
        ipHash: input.ipHash,
      },
      select: { id: true },
    });
    return { id: String(row.id) };
  }

  async findSessionByRefreshHash(refreshTokenHash: string): Promise<SessionRecord | null> {
    const row = await this.prisma.session.findUnique({
      where: { refreshTokenHash },
      select: { id: true, userId: true, expiresAt: true, revokedAt: true },
    });
    return row === null
      ? null
      : {
          id: String(row.id),
          userId: String(row.userId),
          expiresAt: row.expiresAt,
          revokedAt: row.revokedAt,
        };
  }

  async findAuthenticatedSession(sessionId: string): Promise<AuthenticatedSession | null> {
    const bigIntId = toBigIntId(sessionId);
    if (bigIntId === null) return null;

    // 一条查询同时拿会话有效性与用户当前角色 / 状态（join，不是两次往返）。
    const row = await this.prisma.session.findFirst({
      where: { id: bigIntId, revokedAt: null },
      select: {
        id: true,
        user: { select: { id: true, role: true, status: true } },
      },
    });
    if (row === null) return null;

    return {
      sessionId: String(row.id),
      userId: String(row.user.id),
      role: toUserRole(row.user.role),
      status: toUserStatus(row.user.status),
    };
  }

  async revokeSession(sessionId: string, revokedAt: Date): Promise<boolean> {
    const bigIntId = toBigIntId(sessionId);
    if (bigIntId === null) return false;

    const result = await this.prisma.session.updateMany({
      where: { id: bigIntId, revokedAt: null },
      data: { revokedAt },
    });
    return result.count === 1;
  }

  async revokeAllSessionsForUser(userId: string, revokedAt: Date): Promise<number> {
    const bigIntUserId = toBigIntId(userId);
    if (bigIntUserId === null) return 0;

    const result = await this.prisma.session.updateMany({
      where: { userId: bigIntUserId, revokedAt: null },
      data: { revokedAt },
    });
    return result.count;
  }

  async findAuthAccount(
    provider: string,
    providerAccountId: string,
  ): Promise<AuthAccountRecord | null> {
    const row = await this.prisma.authAccount.findUnique({
      where: { provider_providerAccountId: { provider, providerAccountId } },
      select: { id: true, userId: true },
    });
    return row === null ? null : { id: String(row.id), userId: String(row.userId) };
  }

  async linkAuthAccount(input: {
    userId: string;
    provider: string;
    providerAccountId: string;
  }): Promise<AuthAccountRecord | null> {
    const userId = toBigIntId(input.userId);
    if (userId === null) return null;

    try {
      const row = await this.prisma.authAccount.create({
        data: {
          userId,
          provider: input.provider,
          providerAccountId: input.providerAccountId,
        },
        select: { id: true, userId: true },
      });
      return { id: String(row.id), userId: String(row.userId) };
    } catch (error) {
      // 并发绑定同一账号：不是错误，交给调用方重新读取。
      if (isUniqueViolation(error)) return null;
      throw error;
    }
  }
}
