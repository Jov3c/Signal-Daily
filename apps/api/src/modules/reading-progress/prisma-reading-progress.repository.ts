/**
 * `ReadingProgressRepository` 的 Prisma 实现。
 *
 * ⚠ 只写 `reading_progress`，对 `contents` 只**读**。
 */

import { Inject, Injectable } from '@nestjs/common';
import { ContentPipelineStatus } from '@signal/contracts';
import { PrismaService } from '../../common/prisma/prisma.service';
import type {
  ReadingProgressRepository,
  ReadingProgressRow,
  UpsertProgressInput,
} from './repository';
import type { ReadingResourceType } from './resource-type';

const SELECT = {
  resourceType: true,
  resourceId: true,
  progress: true,
  lastPosition: true,
  completedAt: true,
  updatedAt: true,
} as const;

type PrismaRow = {
  resourceType: string;
  resourceId: bigint;
  progress: unknown;
  lastPosition: string | null;
  completedAt: Date | null;
  updatedAt: Date;
};

@Injectable()
export class PrismaReadingProgressRepository implements ReadingProgressRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async isResourceVisible(resourceId: bigint): Promise<boolean> {
    const row = await this.prisma.content.findFirst({
      where: { id: resourceId, pipelineStatus: ContentPipelineStatus.APPROVED },
      select: { id: true },
    });
    return row !== null;
  }

  async find(input: {
    userId: bigint;
    resourceType: ReadingResourceType;
    resourceId: bigint;
  }): Promise<ReadingProgressRow | null> {
    const row = await this.prisma.readingProgress.findUnique({
      where: {
        userId_resourceType_resourceId: {
          userId: input.userId,
          resourceType: input.resourceType,
          resourceId: input.resourceId,
        },
      },
      select: SELECT,
    });
    return row === null ? null : toRow(row as PrismaRow);
  }

  async upsert(input: UpsertProgressInput): Promise<ReadingProgressRow> {
    const key = {
      userId: input.userId,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
    };

    const row = await this.prisma.readingProgress.upsert({
      where: { userId_resourceType_resourceId: key },
      create: {
        ...key,
        progress: input.progress,
        lastPosition: input.lastPosition,
        ...(input.completedAt === null ? {} : { completedAt: input.completedAt }),
      },
      update: {
        progress: input.progress,
        lastPosition: input.lastPosition,
        // ⚠ **只在服务层说要设的时候**写 `completedAt`。
        // 传 `null` 会把已有的完成时间**擦掉** —— 那不是「不更新」，
        // 而是「撤销完成」。服务层已经判定过「已完成的不回退」，所以这里
        // 不传这个键（Prisma 的 `undefined` 语义就是「不改这一列」）。
        ...(input.completedAt === null ? {} : { completedAt: input.completedAt }),
      },
      select: SELECT,
    });
    return toRow(row as PrismaRow);
  }
}

/** Prisma 行 → 端口形状。 */
function toRow(row: PrismaRow): ReadingProgressRow {
  return {
    resourceType: row.resourceType as ReadingResourceType,
    resourceId: String(row.resourceId),
    // `Decimal(5,4)` 在 Prisma 里是 `Prisma.Decimal` —— 它自带 `toNumber`，
    // 但 `Number(...)` 对 Decimal 会走 `toString`，对 0.9500 得到 0.95。
    // 这里显式走 `Number(String(...))` 以免依赖 Prisma 的内部形状。
    progress: Number(String(row.progress)),
    lastPosition: row.lastPosition,
    completedAt: row.completedAt === null ? null : row.completedAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
