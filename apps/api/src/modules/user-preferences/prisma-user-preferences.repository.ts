/**
 * `UserPreferenceRepository` 的 Prisma 实现。
 *
 * ⚠ 只读写 `user_preferences`。**不碰 `users`**（Agent 02 的）。
 */

import { Inject, Injectable } from '@nestjs/common';
import type { ArticleFontSize, UserTheme } from '@signal/contracts';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { PreferencePatch, PreferenceRow, UserPreferenceRepository } from './repository';

const SELECT = {
  theme: true,
  articleFontSize: true,
  defaultTranslation: true,
  updatedAt: true,
} as const;

type PrismaRow = {
  theme: string;
  articleFontSize: string;
  defaultTranslation: boolean;
  updatedAt: Date;
};

@Injectable()
export class PrismaUserPreferenceRepository implements UserPreferenceRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async find(userId: bigint): Promise<PreferenceRow | null> {
    const row = await this.prisma.userPreference.findUnique({
      where: { userId },
      select: SELECT,
    });
    return row === null ? null : toRow(row as PrismaRow);
  }

  async ensure(userId: bigint): Promise<PreferenceRow> {
    // `upsert` 的 `update: {}` 是「已存在就什么都不改」——
    // 它比「先 find 再 create」少一次往返，也**没有并发窗口**
    //（后者在两条并发请求下会有一条抛 P2002 变成 500）。
    const row = await this.prisma.userPreference.upsert({
      where: { userId },
      create: { userId },
      update: {},
      select: SELECT,
    });
    return toRow(row as PrismaRow);
  }

  async update(userId: bigint, patch: PreferencePatch): Promise<PreferenceRow> {
    const row = await this.prisma.userPreference.update({
      where: { userId },
      data: {
        // `undefined` = 不改（Prisma 的语义），这与 dto 的「没给这个键」一致。
        // ⚠ 不要写成 `?? existing` —— 那会多读一次，且把 `undefined` 与 `false`
        // 的区别吃掉（`defaultTranslation: false` 是**合法的显式值**）。
        ...(patch.theme === undefined ? {} : { theme: patch.theme }),
        ...(patch.articleFontSize === undefined ? {} : { articleFontSize: patch.articleFontSize }),
        ...(patch.defaultTranslation === undefined
          ? {}
          : { defaultTranslation: patch.defaultTranslation }),
      },
      select: SELECT,
    });
    return toRow(row as PrismaRow);
  }
}

/** Prisma 行 → 端口形状。 */
function toRow(row: PrismaRow): PreferenceRow {
  return {
    theme: row.theme as UserTheme,
    articleFontSize: row.articleFontSize as ArticleFontSize,
    defaultTranslation: row.defaultTranslation,
    updatedAt: row.updatedAt.toISOString(),
  };
}
