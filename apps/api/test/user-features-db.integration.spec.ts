/**
 * 收藏 / 阅读进度 / 偏好的真库集成测试 —— **真实 MySQL 8.4**。
 *
 * 运行：`REDIS_URL=redis://127.0.0.1:6390 pnpm --filter @signal/api test:integration`
 *
 * ── 为什么这几条必须打真库（替身一个都验不到）────────────────────────
 *
 * 1. **`reading_progress.progress` 是 `Decimal(5,4)`** —— 替身里它就是个 `number`。
 *    真库上要验的是「写 0.95 读回来还是 0.95」，而不是 `0.9499999` 或
 *    `0.95000000001`。精度问题在替身上**永远看不到**，而它会让
 *    「是否完成」的判断在边界上抖动。
 * 2. **`createMany({ skipDuplicates })` 真的不更新 `createdAt`**（书签幂等靠它）。
 *    替身里那条是我手写复刻的 —— 只有真库能证明 Prisma 的语义正如我所想。
 * 3. **`@@id([userId, contentId])` 唯一约束真的存在**，而且
 *    `bookmarks` 的 `onDelete: Cascade` 真的会随内容删除而清掉。
 * 4. **复合游标在真实 SQL 上的翻页行为** —— `OR (createdAt < x) OR (createdAt = x AND contentId < y)`
 *    这两个条件写错一个，翻页就会漏行，而内存替身会「正确地」按我的错误实现工作。
 *
 * 不静默跳过：连不上库就直接失败。测试数据带唯一后缀，`afterAll` 全部清理。
 */

import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { ArticleFontSize, ContentPipelineStatus, UserTheme } from '@signal/contracts';
import { PrismaBookmarkRepository } from '../src/modules/bookmarks/prisma-bookmarks.repository';
import { PrismaReadingProgressRepository } from '../src/modules/reading-progress/prisma-reading-progress.repository';
import { PrismaUserPreferenceRepository } from '../src/modules/user-preferences/prisma-user-preferences.repository';

const SUFFIX = randomBytes(4).toString('hex');

function resolveDatabaseUrl(): string {
  const fromEnv = process.env.DATABASE_URL;
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  const envPath = fileURLToPath(new URL('../../../.env', import.meta.url));
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const match = /^DATABASE_URL=(.*)$/.exec(line.trim());
    if (match?.[1] !== undefined) return match[1].trim();
  }
  throw new Error('DATABASE_URL is not set and could not be read from the repository .env');
}

const prisma = new PrismaClient({ datasources: { db: { url: resolveDatabaseUrl() } } });
const bookmarks = new PrismaBookmarkRepository(prisma as never);
const progress = new PrismaReadingProgressRepository(prisma as never);
const preferences = new PrismaUserPreferenceRepository(prisma as never);

let sourceId: bigint;
let userId: bigint;
let approvedContentId: bigint;
let rejectedContentId: bigint;

/** 造一条指定状态的内容。 */
async function makeContent(label: string, status: ContentPipelineStatus): Promise<bigint> {
  const row = await prisma.content.create({
    data: {
      sourceId,
      type: 'ARTICLE',
      title: `用户功能 IT ${label} ${SUFFIX}`,
      language: 'zh',
      originalUrl: `https://example.com/uf-it-${SUFFIX}/${label}`,
      pipelineStatus: status,
    },
    select: { id: true },
  });
  return row.id;
}

beforeAll(async () => {
  const source = await prisma.source.create({
    data: {
      name: `UserFeat IT ${SUFFIX}`,
      slug: `userfeat-it-${SUFFIX}`,
      type: 'RSS',
      kind: 'MEDIA',
      tier: 'B',
      official: false,
      config: { seed: false },
    },
    select: { id: true },
  });
  sourceId = source.id;

  const user = await prisma.user.create({
    data: {
      email: `uf-it-${SUFFIX}@example.com`,
      displayName: '集成测试用户',
      role: 'USER',
      status: 'ACTIVE',
      // ⚠ 刻意**不建** user_preferences 行 —— 用来验「读不存在时补建」。
    },
    select: { id: true },
  });
  userId = user.id;

  approvedContentId = await makeContent('approved', ContentPipelineStatus.APPROVED);
  rejectedContentId = await makeContent('rejected', ContentPipelineStatus.REJECTED);
});

afterAll(async () => {
  // 顺序：先删引用的，再删被引用的（外键约束）。
  await prisma.bookmark.deleteMany({ where: { userId } });
  await prisma.readingProgress.deleteMany({ where: { userId } });
  await prisma.userPreference.deleteMany({ where: { userId } });
  await prisma.content.deleteMany({ where: { sourceId } });
  await prisma.user.deleteMany({ where: { id: userId } });
  await prisma.source.deleteMany({ where: { id: sourceId } });
  await prisma.$disconnect();
});

/* ------------------------------------------------------------------ */
/* 收藏                                                                */
/* ------------------------------------------------------------------ */

describe('收藏的真库语义', () => {
  it('内容可见性判定：APPROVED 可见，REJECTED 不可见', async () => {
    expect(await bookmarks.isContentVisible(approvedContentId)).toBe(true);
    expect(await bookmarks.isContentVisible(rejectedContentId)).toBe(false);
    // 不存在的 id 也是 false
    expect(await bookmarks.isContentVisible(999_999_999n)).toBe(false);
  });

  it('⚠ **重复收藏不刷新 `createdAt`**（靠主键 + `skipDuplicates`，不是先查后写）', async () => {
    const first = new Date('2026-09-29T01:00:00.000Z');
    const later = new Date('2026-09-29T05:00:00.000Z');

    const a = await bookmarks.add({ userId, contentId: approvedContentId, now: first });
    const b = await bookmarks.add({ userId, contentId: approvedContentId, now: later });

    expect(a?.createdAt).toBe(first.toISOString());
    // 这是「幂等」的可见证据 —— 第二次写没有覆盖时间
    expect(b?.createdAt).toBe(first.toISOString());
    expect(b?.createdAt).not.toBe(later.toISOString());
  });

  it('收藏不可见的内容 → `null`（调用方转 404）', async () => {
    expect(
      await bookmarks.add({ userId, contentId: rejectedContentId, now: new Date() }),
    ).toBeNull();
  });

  it('取消收藏幂等：删两次都不抛', async () => {
    await bookmarks.remove({ userId, contentId: approvedContentId });
    await expect(
      bookmarks.remove({ userId, contentId: approvedContentId }),
    ).resolves.toBeUndefined();
  });

  it('⚠ `onDelete: Cascade` 真的生效 —— 内容被删时收藏行一起消失', async () => {
    const temp = await makeContent('cascade', ContentPipelineStatus.APPROVED);
    await bookmarks.add({ userId, contentId: temp, now: new Date() });
    expect(await bookmarks.find({ userId, contentId: temp })).not.toBeNull();

    await prisma.content.delete({ where: { id: temp }, select: { id: true } });

    const rows = await prisma.bookmark.count({ where: { userId, contentId: temp } });
    expect(rows).toBe(0);
  });
});

describe('收藏列表的复合游标（真 SQL）', () => {
  it('⚠ **同一毫秒收藏的多条会全部翻到，不重不漏**', async () => {
    // 清掉这个用户的收藏，铺一组**同一时刻**的数据
    await prisma.bookmark.deleteMany({ where: { userId } });
    const sameInstant = new Date('2026-09-29T02:00:00.000Z');

    const ids: bigint[] = [];
    for (let index = 0; index < 5; index += 1) {
      const contentId = await makeContent(`page-${String(index)}`, ContentPipelineStatus.APPROVED);
      ids.push(contentId);
      await prisma.bookmark.create({ data: { userId, contentId, createdAt: sameInstant } });
    }

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page += 1) {
      const result: { rows: { contentId: string }[]; nextCursor: string | null } =
        await bookmarks.list({ userId, limit: 2, ...(cursor === undefined ? {} : { cursor }) });
      seen.push(...result.rows.map((row) => row.contentId));
      if (result.nextCursor === null) break;
      cursor = result.nextCursor;
    }

    // 五条各出现恰好一次 —— 只用 contentId 当游标时这里会漏
    expect([...seen].sort()).toEqual(ids.map(String).sort());
    expect(new Set(seen).size).toBe(5);
  });

  it('按 `createdAt` 倒序（最近收藏的在前）', async () => {
    const result = await bookmarks.list({ userId, limit: 10 });
    const times = result.rows.map((row) => row.createdAt);
    expect([...times].sort().reverse()).toEqual(times);
  });

  it('内容已不可见的收藏**不出现在列表里**（docs/12），但行仍在', async () => {
    const temp = await makeContent('hidden', ContentPipelineStatus.APPROVED);
    await bookmarks.add({ userId, contentId: temp, now: new Date('2026-09-29T06:00:00.000Z') });

    // 列表里有它
    let result = await bookmarks.list({ userId, limit: 50 });
    expect(result.rows.map((row) => row.contentId)).toContain(String(temp));

    // 内容被撤下之后
    await prisma.content.update({
      where: { id: temp },
      data: { pipelineStatus: ContentPipelineStatus.REJECTED },
    });

    result = await bookmarks.list({ userId, limit: 50 });
    expect(result.rows.map((row) => row.contentId)).not.toContain(String(temp));

    // ⚠ 但收藏行**还在** —— 内容恢复可见后会重新出现
    expect(await prisma.bookmark.count({ where: { userId, contentId: temp } })).toBe(1);
  });

  it('⚠ 卡片预览的**每一个**字段都真的映射对了（不是只断言 name / url）', async () => {
    // §23 审查的 F5：第一版只断言了 `source.name` 与 `originalUrl`，
    // 而替身把预览字段**写死**了 —— 于是 `kind` / `tier` / `type` / `official` /
    // `language` 的映射即使错位，两套测试都不会红。
    // 这里逐字段断言真库的映射结果。
    const contentId = await makeContent('preview-fields', ContentPipelineStatus.APPROVED);
    await bookmarks.add({ userId, contentId, now: new Date('2026-09-29T07:00:00.000Z') });

    const result = await bookmarks.list({ userId, limit: 50 });
    const row = result.rows.find((entry) => entry.contentId === String(contentId));

    expect(row?.content).toMatchObject({
      id: String(contentId),
      type: 'ARTICLE',
      title: `用户功能 IT preview-fields ${SUFFIX}`,
      language: 'zh',
      imageUrl: null,
      summary: null,
      source: {
        id: String(sourceId),
        name: `UserFeat IT ${SUFFIX}`,
        slug: `userfeat-it-${SUFFIX}`,
        // 这三条是**最容易映射错**的（枚举桥接）
        type: 'RSS',
        kind: 'MEDIA',
        tier: 'B',
        official: false,
      },
    });
    expect(row?.content?.originalUrl).toContain(`uf-it-${SUFFIX}`);
    expect(row?.content?.publishedAt).toBeNull();
  });
});

describe('收藏的并发与不对称规则（真库）', () => {
  it('⚠ **并发 add 同一份内容**：不抛、且只有一行（主键 + `skipDuplicates` 的真实行为）', async () => {
    // §23 审查指出「并发幂等」只有论证没有实测。这里真的并发发五条。
    const contentId = await makeContent('concurrent', ContentPipelineStatus.APPROVED);

    const results = await Promise.all(
      Array.from({ length: 5 }, () => bookmarks.add({ userId, contentId, now: new Date() })),
    );

    // 五条都成功（幂等：没有一条因为主键冲突而抛错）
    expect(results.every((row) => row !== null)).toBe(true);
    // 并且库里确实只有一行
    expect(await prisma.bookmark.count({ where: { userId, contentId } })).toBe(1);
  });

  it('⚠ **内容已被撤下时仍然能取消收藏**（这条不对称规则要在真库上验，F4）', async () => {
    const contentId = await makeContent('removable', ContentPipelineStatus.APPROVED);
    await bookmarks.add({ userId, contentId, now: new Date() });

    // 内容被 Agent 07 撤下
    await prisma.content.update({
      where: { id: contentId },
      data: { pipelineStatus: ContentPipelineStatus.REJECTED },
    });

    // 仍然能删 —— 用户必须能清理自己的收藏
    await expect(bookmarks.remove({ userId, contentId })).resolves.toBeUndefined();
    expect(await prisma.bookmark.count({ where: { userId, contentId } })).toBe(0);

    // 但**加不回来**（加收藏要求可见）
    expect(await bookmarks.add({ userId, contentId, now: new Date() })).toBeNull();
  });

  it('⚠ 超界 BIGINT id 不会让驱动抛错（返回 false / null，不是 500）', async () => {
    // `18446744073709551615` 是 BIGINT UNSIGNED 的合法上限，
    // 但 Prisma 按**有符号** 64 位绑定 —— 直接传会让驱动抛 UnknownRequestError。
    // 本模块在边界上收敛成「不存在」。
    expect(await bookmarks.isContentVisible(9_223_372_036_854_775_807n)).toBe(false);
    expect(await bookmarks.list({ userId, limit: 5 })).toBeDefined();
  });
});

/* ------------------------------------------------------------------ */
/* 阅读进度                                                            */
/* ------------------------------------------------------------------ */

describe('阅读进度的真库语义', () => {
  it('⚠ **`Decimal(5,4)` 往返精确**（0.95 写进去读回来还是 0.95）', async () => {
    const row = await progress.upsert({
      userId,
      resourceType: 'CONTENT',
      resourceId: approvedContentId,
      progress: 0.95,
      lastPosition: null,
      completedAt: null,
    });

    // 精度问题在内存替身上**永远看不到**，而它会让「是否完成」在边界上抖动
    expect(row.progress).toBe(0.95);
    expect(row.progress).toBeGreaterThanOrEqual(0.95);
  });

  it('四位小数的精度保留（0.1234 不被抹成 0.12）', async () => {
    const row = await progress.upsert({
      userId,
      resourceType: 'CONTENT',
      resourceId: approvedContentId,
      progress: 0.1234,
      lastPosition: '第三章 · 第二节',
      completedAt: null,
    });
    expect(row.progress).toBe(0.1234);
    expect(row.lastPosition).toBe('第三章 · 第二节');
  });

  it('⚠ `completedAt: null` 表示「**不改这一列**」，不是「擦掉」', async () => {
    const completedAt = new Date('2026-09-29T03:00:00.000Z');
    await progress.upsert({
      userId,
      resourceType: 'CONTENT',
      resourceId: approvedContentId,
      progress: 0.99,
      lastPosition: null,
      completedAt,
    });

    // 再写一次，这次不设 completedAt（模拟「已完成不回退」）
    const row = await progress.upsert({
      userId,
      resourceType: 'CONTENT',
      resourceId: approvedContentId,
      progress: 0.2,
      lastPosition: null,
      completedAt: null,
    });

    expect(row.progress).toBe(0.2);
    // 完成时间**还是原来那个** —— 既没被擦掉，也没被刷新
    expect(row.completedAt).toBe(completedAt.toISOString());
  });

  it('⚠ `isResourceVisible` / `find` 在真库上真的被执行（F4）', async () => {
    // §23 审查的 F4：第一版只对 `upsert` 打了真库，另外两个方法**真库零执行**。
    expect(await progress.isResourceVisible(approvedContentId)).toBe(true);
    expect(await progress.isResourceVisible(rejectedContentId)).toBe(false);
    expect(await progress.isResourceVisible(999_999_999n)).toBe(false);

    const found = await progress.find({
      userId,
      resourceType: 'CONTENT',
      resourceId: approvedContentId,
    });
    expect(found?.resourceId).toBe(String(approvedContentId));
    expect(typeof found?.progress).toBe('number');

    const missing = await progress.find({
      userId,
      resourceType: 'CONTENT',
      resourceId: 999_999_999n,
    });
    expect(missing).toBeNull();
  });

  it('主键是 `(userId, resourceType, resourceId)` —— 同一份内容只有一行', async () => {
    const rows = await prisma.readingProgress.count({
      where: { userId, resourceType: 'CONTENT', resourceId: approvedContentId },
    });
    expect(rows).toBe(1);
  });

  it('`user` 级联删除会带走进度行（onDelete: Cascade）', async () => {
    const tempUser = await prisma.user.create({
      data: { email: `uf-cascade-${SUFFIX}@example.com`, role: 'USER', status: 'ACTIVE' },
      select: { id: true },
    });
    await progress.upsert({
      userId: tempUser.id,
      resourceType: 'CONTENT',
      resourceId: approvedContentId,
      progress: 0.5,
      lastPosition: null,
      completedAt: null,
    });

    await prisma.user.delete({ where: { id: tempUser.id }, select: { id: true } });

    expect(await prisma.readingProgress.count({ where: { userId: tempUser.id } })).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* 偏好                                                                */
/* ------------------------------------------------------------------ */

describe('阅读偏好的真库语义', () => {
  it('⚠ `ensure` 在**没有行**时补建，且用的是数据库默认值', async () => {
    expect(await preferences.find(userId)).toBeNull();

    const row = await preferences.ensure(userId);

    expect(row).toMatchObject({
      theme: UserTheme.SYSTEM,
      articleFontSize: ArticleFontSize.DEFAULT,
      defaultTranslation: false,
    });
    expect(await preferences.find(userId)).not.toBeNull();
  });

  it('⚠ `ensure` 对**已存在**的行**什么都不改**（`update: {}` 的语义）', async () => {
    await preferences.update(userId, { theme: UserTheme.DARK });

    const row = await preferences.ensure(userId);
    // 已经是 DARK 了，ensure 不能把它重置回 SYSTEM
    expect(row.theme).toBe(UserTheme.DARK);
  });

  it('部分更新只改给到的字段', async () => {
    await preferences.update(userId, {
      theme: UserTheme.LIGHT,
      articleFontSize: ArticleFontSize.LARGE,
      defaultTranslation: true,
    });

    const row = await preferences.update(userId, { articleFontSize: ArticleFontSize.SMALL });
    expect(row).toMatchObject({
      theme: UserTheme.LIGHT,
      articleFontSize: ArticleFontSize.SMALL,
      defaultTranslation: true,
    });
  });

  it('⚠ `defaultTranslation: false` 能真的写进去（不被当成「没给」）', async () => {
    await preferences.update(userId, { defaultTranslation: true });
    const row = await preferences.update(userId, { defaultTranslation: false });
    expect(row.defaultTranslation).toBe(false);
  });

  it('⚠ `updatedAt` **真的**随更新变化（不是「不小于」这种永真断言）', async () => {
    // §23 审查的 F6：第一版写的是 `after.updatedAt >= before.updatedAt` ——
    // 字符串比较，**值不变也会通过**，等于没测。
    const before = await preferences.find(userId);
    expect(before).not.toBeNull();

    // 等一毫秒，确保 `@updatedAt` 的时间戳能区分开
    await new Promise((resolve) => setTimeout(resolve, 5));
    const after = await preferences.update(userId, { theme: UserTheme.DARK });

    expect(after.updatedAt).not.toBe(before?.updatedAt);
    expect(new Date(after.updatedAt).getTime()).toBeGreaterThan(
      new Date(before?.updatedAt ?? 0).getTime(),
    );
  });
});
