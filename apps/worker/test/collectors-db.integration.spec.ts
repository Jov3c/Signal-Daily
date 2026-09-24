/**
 * Collector 集成测试 —— **真实 MySQL**。
 *
 * 运行：`pnpm --filter @signal/worker test:integration`（需先 `pnpm db:migrate`）
 *
 * ── 只有真库才能验的几件事 ──────────────────────────────────────────
 *   1. 「到期」这条 SQL **真的**会把 `next_fetch_at IS NULL` 的行取出来
 *      —— Agent 01 的 seed 建的 8 个来源全都是 NULL，少这一条它们永远不被采集；
 *   2. 「停用后不再到期」由真 SQL 保证，而不是由我写的替身 if 保证；
 *   3. `next_fetch_at` 的 UTC 语义：字段存的是 UTC，任何拿本机 `NOW()`
 *      （`time_zone = SYSTEM = Asia/Shanghai`）比的做法都会差 8 小时 ——
 *      这里直接在真库上核对读回来的时刻；
 *   4. BIGINT 主键的**上界**：超过 `2^63-1` 的值会让 Prisma 抛
 *      `PrismaClientUnknownRequestError`（Agent 03 的 CCR 第 8 项实测），
 *      本模块的 `toBindableId()` 必须把它收敛成「不存在」；
 *   5. `raw_items` 上**没有**唯一约束 —— 幂等靠「先查后写」+ 锁。
 *      这条要显式验，因为「以为有唯一约束」会导致设计上的错误假设。
 *
 * ── 数据卫生（Agent 03 HANDOFF §7 的教训）──────────────────────────
 * 本文件**只碰自己创建的**数据：所有 slug 带随机前缀，用例结束在 `finally`
 * 里删掉自己建的 rawItem 与 source。
 * **不 PATCH 任何 seed 出来的行** —— Agent 03 曾经改过 `x-karpathy` 的
 * `priority` 且没还原，而 Agent 01 的 seed 刻意不覆盖已有记录，
 * 于是那一行**永久**偏离了 seed 定义，后面所有 Agent 看到的都不是真实基线。
 *
 * 连不上库就直接失败，绝不静默跳过。
 */

import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RawItemStatus, SourceKind, SourceTier, SourceType } from '@signal/contracts';
import { PrismaService } from '../src/jobs/collectors/prisma.service';
import { PrismaCollectorSourceRepository } from '../src/jobs/collectors/prisma-source.repository';
import { PrismaRawItemRepository } from '../src/jobs/collectors/prisma-raw-item.repository';
import { MAX_BINDABLE_ID, toBindableId } from '../src/jobs/collectors/bigint-id';
import { sha256Hex } from '../src/jobs/collectors/hashing';
import type { NewRawItem } from '../src/jobs/collectors/ports';

/* ------------------------------------------------------------------ */
/* 环境                                                                */
/* ------------------------------------------------------------------ */

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

/** 载入仓库根 `.env`，但**不覆盖**已经显式设置的环境变量。 */
function loadDotEnv(): void {
  let content: string;
  try {
    content = readFileSync(`${REPO_ROOT}/.env`, 'utf8');
  } catch {
    return;
  }
  for (const line of content.split('\n')) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match === null) continue;
    const [, key, value] = match as unknown as [string, string, string];
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadDotEnv();

if (process.env.DATABASE_URL === undefined) {
  throw new Error(
    'DATABASE_URL 未设置。请在仓库根创建 .env（参考 .env.example），或先 export DATABASE_URL。',
  );
}

/** 本次运行创建的 slug 前缀：用它做清理，绝不误删别人的数据。 */
const PREFIX = `it-agent04-${randomBytes(4).toString('hex')}`;

let prisma: PrismaService;
let sources: PrismaCollectorSourceRepository;
let rawItems: PrismaRawItemRepository;
/** 本文件创建过的 source id（string），用于收尾清理。 */
const createdSourceIds: string[] = [];

/** 建一个只属于本文件的 Source。 */
async function createTestSource(options: {
  slug: string;
  enabled?: boolean;
  nextFetchAt?: Date | null;
  fetchIntervalSeconds?: number;
  type?: SourceType;
  config?: Record<string, unknown> | null;
}): Promise<string> {
  const row = await prisma.source.create({
    data: {
      name: `Agent04 IT ${options.slug}`,
      slug: `${PREFIX}-${options.slug}`,
      type: options.type ?? SourceType.RSS,
      kind: SourceKind.MEDIA,
      tier: SourceTier.C,
      official: false,
      feedUrl: 'https://example.com/feed.xml',
      priority: 50,
      trustScore: 7.0,
      fetchIntervalSeconds: options.fetchIntervalSeconds ?? 1800,
      enabled: options.enabled ?? true,
      nextFetchAt: options.nextFetchAt === undefined ? null : options.nextFetchAt,
      config: options.config === undefined ? { maxItems: 50 } : options.config,
    },
    select: { id: true },
  });
  const id = String(row.id);
  createdSourceIds.push(id);
  return id;
}

function newRawItem(sourceId: string, overrides: Partial<NewRawItem> = {}): NewRawItem {
  const canonicalUrl =
    overrides.canonicalUrl ?? `https://example.com/${randomBytes(6).toString('hex')}`;
  return {
    sourceId,
    externalId: overrides.externalId ?? null,
    originalUrl: canonicalUrl,
    canonicalUrl,
    canonicalUrlHash: sha256Hex(canonicalUrl),
    titleRaw: '中文标题：模型评测',
    bodyRaw: '中文正文，含 emoji 🔬 与引号「」。',
    payload: { feedFormat: 'rss' },
    language: 'zh',
    publishedAt: new Date('2026-09-24T01:00:00.000Z'),
    fetchedAt: new Date('2026-09-24T02:00:00.000Z'),
    contentHash: sha256Hex('中文标题：模型评测\n中文正文'),
    status: RawItemStatus.FETCHED,
    ...overrides,
  };
}

beforeAll(async () => {
  prisma = new PrismaService();
  sources = new PrismaCollectorSourceRepository(prisma);
  rawItems = new PrismaRawItemRepository(prisma);
  // 连不上库就直接失败（不静默跳过）。
  await prisma.$queryRaw`SELECT 1`;
});

afterAll(async () => {
  // 清理纪律：只删自己创建的。删 rawItem 在前（外键），再删 source。
  if (createdSourceIds.length > 0) {
    const ids = createdSourceIds.map((id) => BigInt(id));
    await prisma.rawItem.deleteMany({ where: { sourceId: { in: ids } } });
    await prisma.source.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.$disconnect();
});

/* ================================================================== */
/* 到期查询                                                            */
/* ================================================================== */

describe('findDueSources —— 真 SQL 上的到期规则', () => {
  it('**`nextFetchAt` 为 NULL 的来源算到期**（否则 Agent 01 的 seed 永远不被采集）', async () => {
    const id = await createTestSource({ slug: 'due-null', nextFetchAt: null });

    const due = await sources.findDueSources(new Date(), 500);
    expect(due.map((source) => source.id)).toContain(id);
  });

  it('未来的 `nextFetchAt` 不算到期', async () => {
    const id = await createTestSource({
      slug: 'due-future',
      nextFetchAt: new Date(Date.now() + 3_600_000),
    });

    const due = await sources.findDueSources(new Date(), 500);
    expect(due.map((source) => source.id)).not.toContain(id);
  });

  it('过去的 `nextFetchAt` 算到期', async () => {
    const id = await createTestSource({
      slug: 'due-past',
      nextFetchAt: new Date(Date.now() - 60_000),
    });

    const due = await sources.findDueSources(new Date(), 500);
    expect(due.map((source) => source.id)).toContain(id);
  });

  it('**停用的来源不到期**（docs/06：停用后停止产生新抓取任务）', async () => {
    const id = await createTestSource({ slug: 'due-disabled', enabled: false, nextFetchAt: null });

    const due = await sources.findDueSources(new Date(), 500);
    expect(due.map((source) => source.id)).not.toContain(id);
  });

  it('`take` 生效（单轮调度不会把队列灌满）', async () => {
    await createTestSource({ slug: 'limit-a', nextFetchAt: null });
    await createTestSource({ slug: 'limit-b', nextFetchAt: null });

    const due = await sources.findDueSources(new Date(), 1);
    expect(due).toHaveLength(1);
  });

  it('**读回来的 `nextFetchAt` 是 UTC 时刻**（用本机 NOW() 比会差 8 小时）', async () => {
    // 本机 MySQL 的 time_zone = SYSTEM = Asia/Shanghai，而这一列存 UTC。
    // 这里写死一个 UTC 时刻，读回来必须逐毫秒相等。
    const at = new Date('2026-09-24T01:55:05.129Z');
    const id = await createTestSource({ slug: 'utc-check', nextFetchAt: at });

    const source = await sources.findById(id);
    expect(source).not.toBeNull();

    const row = await prisma.source.findUniqueOrThrow({
      where: { id: BigInt(id) },
      select: { nextFetchAt: true },
    });
    expect(row.nextFetchAt?.toISOString()).toBe(at.toISOString());
  });
});

/* ================================================================== */
/* 读模型                                                              */
/* ================================================================== */

describe('findById —— 真库上的读模型', () => {
  it('id 是 **string**（BIGINT → string），枚举是契约枚举，config 是普通对象', async () => {
    const id = await createTestSource({
      slug: 'read-model',
      type: SourceType.X_USER,
      config: { handle: 'karpathy', includeQuotes: true, includeReplies: false },
    });

    const source = await sources.findById(id);

    expect(source).not.toBeNull();
    expect(typeof source!.id).toBe('string');
    expect(source!.id).toBe(id);
    expect(source!.type).toBe(SourceType.X_USER);
    expect(source!.config).toEqual({
      handle: 'karpathy',
      includeQuotes: true,
      includeReplies: false,
    });
    // ⚠ 采集侧的读模型里**没有** kind / tier / official ——
    // 见 ports.ts 文件头：那些字段不允许进 RawItem payload。
    expect(Object.keys(source!)).not.toContain('tier');
    expect(Object.keys(source!)).not.toContain('kind');
    expect(Object.keys(source!)).not.toContain('official');
  });

  it('`config` 为 NULL 时读成 null（不是 {}）—— 适配器据此走兜底值', async () => {
    const id = await createTestSource({ slug: 'null-config', config: null });
    expect((await sources.findById(id))!.config).toBeNull();
  });

  it('不存在的 id → null', async () => {
    expect(await sources.findById('999999999')).toBeNull();
  });

  it('**畸形 id → null（不是抛错）** —— 队列载荷可能被手工改过', async () => {
    expect(await sources.findById('abc')).toBeNull();
    expect(await sources.findById('')).toBeNull();
    expect(await sources.findById('-1')).toBeNull();
  });

  it('**超出 Int64 上界的 id → null（不是 500）**', async () => {
    // Agent 03 的独立审查实测：Prisma 把 JS bigint 按**有符号** 64 位绑定，
    // 连合法的无符号上限 18446744073709551615 都会抛
    // `PrismaClientUnknownRequestError`。本模块在边界收口。
    expect(MAX_BINDABLE_ID).toBe(9_223_372_036_854_775_807n);
    expect(toBindableId('18446744073709551615')).toBeNull();
    expect(toBindableId('9223372036854775808')).toBeNull();
    expect(toBindableId('9223372036854775807')).toBe(9_223_372_036_854_775_807n);

    expect(await sources.findById('18446744073709551615')).toBeNull();
    expect(await sources.findById('99999999999999999999')).toBeNull();
  });
});

/* ================================================================== */
/* 状态推进                                                            */
/* ================================================================== */

describe('recordFetchOutcome —— 真库上的状态推进', () => {
  it('成功：推进 last_fetched_at / next_fetch_at / last_success_at，清空 last_error_code', async () => {
    const id = await createTestSource({ slug: 'outcome-ok' });
    const at = new Date('2026-09-24T02:00:00.000Z');
    const nextFetchAt = new Date('2026-09-24T02:30:00.000Z');

    // 先造一个错误状态，确认它会被清掉。
    await prisma.source.update({
      where: { id: BigInt(id) },
      data: { lastErrorCode: 'SOURCE_FETCH_FAILED' },
    });

    await sources.recordFetchOutcome(id, { at, nextFetchAt, errorCode: null });

    const row = await prisma.source.findUniqueOrThrow({
      where: { id: BigInt(id) },
      select: { lastFetchedAt: true, nextFetchAt: true, lastSuccessAt: true, lastErrorCode: true },
    });
    expect(row.lastFetchedAt?.toISOString()).toBe(at.toISOString());
    expect(row.nextFetchAt?.toISOString()).toBe(nextFetchAt.toISOString());
    expect(row.lastSuccessAt?.toISOString()).toBe(at.toISOString());
    expect(row.lastErrorCode).toBeNull();
  });

  it('失败：记 last_error_at / last_error_code，但**同样推进** next_fetch_at', async () => {
    const id = await createTestSource({ slug: 'outcome-fail' });
    const at = new Date('2026-09-24T02:00:00.000Z');
    const nextFetchAt = new Date('2026-09-24T02:30:00.000Z');

    await sources.recordFetchOutcome(id, {
      at,
      nextFetchAt,
      errorCode: 'SOURCE_FETCH_CREDENTIALS_MISSING',
    });

    const row = await prisma.source.findUniqueOrThrow({
      where: { id: BigInt(id) },
      select: { lastErrorAt: true, lastErrorCode: true, nextFetchAt: true, lastSuccessAt: true },
    });
    expect(row.lastErrorAt?.toISOString()).toBe(at.toISOString());
    expect(row.lastErrorCode).toBe('SOURCE_FETCH_CREDENTIALS_MISSING');
    // 关键：失败也必须推进 —— 否则一个一直失败的来源会被每一轮反复取出来。
    expect(row.nextFetchAt?.toISOString()).toBe(nextFetchAt.toISOString());
    expect(row.lastSuccessAt).toBeNull();
  });

  it('推进之后该来源不再到期（下一轮调度不会立刻再抓）', async () => {
    const id = await createTestSource({ slug: 'outcome-advance' });
    const at = new Date();
    await sources.recordFetchOutcome(id, {
      at,
      nextFetchAt: new Date(at.getTime() + 3_600_000),
      errorCode: null,
    });

    const due = await sources.findDueSources(new Date(), 500);
    expect(due.map((source) => source.id)).not.toContain(id);
  });
});

/* ================================================================== */
/* RawItem 幂等                                                        */
/* ================================================================== */

describe('RawItem 幂等 —— 真库上的「先查后写」', () => {
  it('写入后 `findExistingKeys` 能查到 externalId 与 canonicalUrlHash', async () => {
    const sourceId = await createTestSource({ slug: 'idem-keys' });
    const item = newRawItem(sourceId, { externalId: 'ext-1' });
    await rawItems.insertMany([item]);

    const existing = await rawItems.findExistingKeys({
      sourceId,
      externalIds: ['ext-1', 'ext-missing'],
      canonicalUrlHashes: [item.canonicalUrlHash, sha256Hex('nope')],
    });

    expect(existing.externalIds.has('ext-1')).toBe(true);
    expect(existing.externalIds.has('ext-missing')).toBe(false);
    expect(existing.canonicalUrlHashes.has(item.canonicalUrlHash)).toBe(true);
  });

  it('**`raw_items` 上没有唯一约束**（所以幂等只能靠先查后写 + 锁）', async () => {
    // 这条要显式验：以为有唯一约束会导致设计上的错误假设
    // （例如「重复插入会抛 P2002，兜底一下就行」）。
    const sourceId = await createTestSource({ slug: 'idem-nounique' });
    const item = newRawItem(sourceId, { externalId: 'dup' });

    await rawItems.insertMany([item]);
    // 第二次直接插入**会成功** —— 真库不拦。拦住它的是服务层的先查后写。
    await expect(rawItems.insertMany([item])).resolves.toBe(1);

    const count = await prisma.rawItem.count({
      where: { sourceId: BigInt(sourceId), externalId: 'dup' },
    });
    expect(count).toBe(2);
  });

  it('中文与 emoji 往返无损（utf8mb4）', async () => {
    const sourceId = await createTestSource({ slug: 'idem-utf8' });
    const item = newRawItem(sourceId, {
      titleRaw: '模型评测：推理成本 🔬「引号」',
      bodyRaw: '正文含全角标点，以及 emoji 🚀 与日文かな。',
    });
    await rawItems.insertMany([item]);

    const row = await prisma.rawItem.findFirstOrThrow({
      where: { sourceId: BigInt(sourceId) },
      select: { titleRaw: true, bodyRaw: true },
    });
    expect(row.titleRaw).toBe('模型评测：推理成本 🔬「引号」');
    expect(row.bodyRaw).toContain('かな');
  });

  it('哈希列落库后是 64 位小写十六进制（Char(64) 的约定）', async () => {
    const sourceId = await createTestSource({ slug: 'idem-hash' });
    await rawItems.insertMany([newRawItem(sourceId)]);

    const row = await prisma.rawItem.findFirstOrThrow({
      where: { sourceId: BigInt(sourceId) },
      select: { canonicalUrlHash: true, contentHash: true, status: true },
    });
    expect(row.canonicalUrlHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.status).toBe(RawItemStatus.FETCHED);
  });

  it('`publishedAt` 为 null 时也能写入（没有日期的 feed 条目）', async () => {
    const sourceId = await createTestSource({ slug: 'idem-nodate' });
    await rawItems.insertMany([newRawItem(sourceId, { publishedAt: null })]);

    const count = await prisma.rawItem.count({
      where: { sourceId: BigInt(sourceId), publishedAt: null },
    });
    expect(count).toBe(1);
  });

  it('空数组不触发任何写操作', async () => {
    await expect(rawItems.insertMany([])).resolves.toBe(0);
  });
});

/* ================================================================== */
/* Cursor                                                              */
/* ================================================================== */

describe('latestCursor —— 从已落库的事实推导增量游标', () => {
  it('没有历史时两个字段都是 null（第一次采集全量）', async () => {
    const sourceId = await createTestSource({ slug: 'cursor-empty' });
    expect(await sources.latestCursor(sourceId)).toEqual({
      sincePublishedAt: null,
      sinceExternalId: null,
    });
  });

  it('取到最新的 `publishedAt`，以及**数值最大**的 externalId', async () => {
    // ⚠ `sinceExternalId` 只服务上游支持**真正增量语义**的适配器，
    // 目前只有 X 的 `since_id`（雪花 id、单调递增），所以取**数值最大**的那个，
    // 而不是「最近写入那一行」的值 —— 两者在窗口顺序 ≠ id 顺序时不一致
    // （HN 曾经因此永久漏采：见 hacker-news.adapter.ts 的注释）。
    const sourceId = await createTestSource({ slug: 'cursor-values' });
    await rawItems.insertMany([
      newRawItem(sourceId, {
        externalId: '100',
        publishedAt: new Date('2026-09-20T00:00:00.000Z'),
      }),
      newRawItem(sourceId, {
        externalId: '98',
        publishedAt: new Date('2026-09-23T00:00:00.000Z'),
      }),
    ]);

    const cursor = await sources.latestCursor(sourceId);
    expect(cursor.sincePublishedAt?.toISOString()).toBe('2026-09-23T00:00:00.000Z');
    // 最大的是 100，尽管最后写入的是 98。
    expect(cursor.sinceExternalId).toBe('100');
  });

  it('非数字的 externalId（RSS 的 guid）不进游标 —— 它没有「大小」语义', async () => {
    const sourceId = await createTestSource({ slug: 'cursor-guid' });
    await rawItems.insertMany([
      newRawItem(sourceId, { externalId: 'tag:example.com,2026:post-1' }),
      newRawItem(sourceId, { externalId: 'not-a-number' }),
    ]);

    const cursor = await sources.latestCursor(sourceId);
    expect(cursor.sinceExternalId).toBeNull();
  });

  it('**离谱的未来发布时间不进游标**（时区写错的源会让游标把后续内容全挡住）', async () => {
    const sourceId = await createTestSource({ slug: 'cursor-future' });
    await rawItems.insertMany([
      newRawItem(sourceId, {
        externalId: 'sane',
        publishedAt: new Date('2026-09-23T00:00:00.000Z'),
      }),
      newRawItem(sourceId, {
        externalId: 'insane',
        // 源站时区写错，把发布时间写到了明年。
        publishedAt: new Date('2027-09-23T00:00:00.000Z'),
      }),
    ]);

    const cursor = await sources.latestCursor(sourceId);
    expect(cursor.sincePublishedAt?.toISOString()).toBe('2026-09-23T00:00:00.000Z');
  });

  it('游标只覆盖**本来源**的行（不同来源不互相影响）', async () => {
    const a = await createTestSource({ slug: 'cursor-a' });
    const b = await createTestSource({ slug: 'cursor-b' });
    await rawItems.insertMany([
      newRawItem(a, { externalId: '11', publishedAt: new Date('2026-09-22T00:00:00.000Z') }),
      newRawItem(b, { externalId: '22', publishedAt: new Date('2026-09-24T00:00:00.000Z') }),
    ]);

    expect((await sources.latestCursor(a)).sinceExternalId).toBe('11');
    expect((await sources.latestCursor(b)).sinceExternalId).toBe('22');
  });
});

/* ================================================================== */
/* 与 seed 共存                                                        */
/* ================================================================== */

describe('与 Agent 01 的 seed 数据共存', () => {
  it('seed 出的来源在真库里对自己的读模型可用（config 可能是稀疏的）', async () => {
    const seeded = await prisma.source.findFirst({
      where: { slug: 'x-karpathy' },
      select: { id: true },
    });
    // seed 存在时才验（不存在不算失败 —— 那是 Agent 01 的数据）。
    if (seeded === null) return;

    const source = await sources.findById(String(seeded.id));
    expect(source).not.toBeNull();
    expect(source!.type).toBe(SourceType.X_USER);
    // seed 的 config 形状是 `{seed: true, seedNote: '...'}`，可能没有 handle。
    // 适配器对它走 externalId 兜底 —— 这里只确认读模型不崩。
    expect(typeof source!.slug).toBe('string');
  });
});
