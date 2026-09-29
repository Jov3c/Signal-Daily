/**
 * Pipeline（Normalize）的真库集成测试 —— **真实 MySQL 8.4**。
 *
 * 运行：`REDIS_URL=... pnpm --filter @signal/worker test:integration`
 *
 * ── 为什么这几条必须打真库 ──────────────────────────────────────────
 * 单元测试里仓储被内存替身挡掉了，于是下面这些**一个都验不到**：
 *
 * 1. **契约枚举 → Prisma 枚举的桥接**（`contract-enum.ts`）——
 *    编译期类型体操，`tsc` 通过不代表运行期 `INSERT` 成功；
 * 2. **`contents.raw_item_id` 的唯一约束真的存在**，且冲突时抛 P2002 ——
 *    替身里那条约束是我**手写复刻**的，只有真库能证明它确实在那儿；
 * 3. **`$transaction` 的原子性** —— 建 Content 失败时 RawItem 状态必须回滚；
 * 4. **`Char(5)` / `VarChar(700)` 等列宽**在真实 MySQL 上的行为；
 * 5. **BIGINT 上界**：超界 id 必须是干净的「不存在」，而不是驱动层异常。
 *
 * 不静默跳过：连不上库就直接失败（Agent 01 的同一原则）。
 * 测试数据带唯一后缀，`afterAll` 全部清理，不污染 Agent 01 的 seed 基线。
 */

import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { ContentPipelineStatus, ContentType, RawItemStatus, SourceType } from '@signal/contracts';
import { DomainErrorCode } from '@signal/contracts';
import { ContentService } from '../src/jobs/content/content.service';
import { PrismaContentRepository } from '../src/jobs/content/prisma-content.repository';
import { toBindableId } from '../src/jobs/content/bigint-id';
import { NoopContentEnqueuer } from '../src/jobs/content/content-enqueuer';
import { createLogger } from '@signal/logger';

const SUFFIX = randomBytes(4).toString('hex');
const SLUG = `content-it-source-${SUFFIX}`;

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
// `forClient` 是给「手上只有裸 PrismaClient」的场景用的适配器
//（`ContentPrismaService` 只是加了 Nest 生命周期包装，测试不需要）。
const repository = PrismaContentRepository.forClient(prisma);
const service = new ContentService(
  repository,
  createLogger({ service: 'worker', level: 'silent' }),
  // 本文件测的是**库层行为**，入队与时钟用最简实现 —— 队列语义
  // 由 `content-queue.integration.spec.ts` 在真 Redis 上单独验。
  new NoopContentEnqueuer(),
  { now: () => new Date() },
);

let sourceId: bigint;
/** 第二个来源 —— 用于「同一事件被不同媒体报道」的场景。 */
let secondSourceId: bigint;
/** 官方来源 —— 用于证据类型与 Primary 的用例。 */
let officialSourceId: bigint;

/** 造一条 RawItem，返回它的 id 字符串。 */
async function seedRawItem(
  overrides: Record<string, unknown> = {},
  onSourceId: bigint = sourceId,
): Promise<string> {
  const row = await prisma.rawItem.create({
    data: {
      sourceId: onSourceId,
      externalId: `ext-${randomBytes(4).toString('hex')}`,
      // ⚠ URL 必须**每条唯一**。第一版所有条目共用 `.../a`，
      // 于是「同 URL 只留一条证据」这条正确规则把第二条证据挡掉了 ——
      // 表现成「官方加入后事件只有 1 条证据」。
      // 证据的 `urlHash` 是从这个字段算的（`EventEvidence.urlHash`）。
      originalUrl: `https://example.com/${SUFFIX}/${randomBytes(8).toString('hex')}`,
      canonicalUrl: `https://example.com/${SUFFIX}/${randomBytes(8).toString('hex')}`,
      canonicalUrlHash: randomBytes(32).toString('hex'),
      titleRaw: 'Anthropic 发布新的评测报告',
      bodyRaw: '<p>报告指出推理成本在 2026 年下降了约 40%。</p>',
      payload: { feedFormat: 'rss2' },
      language: 'en',
      publishedAt: new Date('2026-09-29T02:00:00.000Z'),
      fetchedAt: new Date('2026-09-29T02:05:00.000Z'),
      contentHash: randomBytes(32).toString('hex'),
      status: 'FETCHED',
      ...overrides,
    },
    select: { id: true },
  });
  return String(row.id);
}

beforeAll(async () => {
  const source = await prisma.source.create({
    data: {
      name: `Content IT Source ${SUFFIX}`,
      slug: SLUG,
      type: SourceType.RSS,
      kind: 'MEDIA',
      tier: 'B',
      official: false,
      config: { seed: false, note: 'agent-05 integration test fixture' },
    },
    select: { id: true },
  });
  sourceId = source.id;

  const second = await prisma.source.create({
    data: {
      name: `Content IT Source B ${SUFFIX}`,
      slug: `${SLUG}-b`,
      type: SourceType.RSS,
      kind: 'MEDIA',
      tier: 'B',
      official: false,
      config: { seed: false, note: 'agent-05 integration test fixture (second source)' },
    },
    select: { id: true },
  });
  secondSourceId = second.id;
});

/**
 * **每条用例跑完就清干净**。
 *
 * ⚠ 这不是洁癖，是这一组测试能成立的前提：事件聚合是**按相似度**归属的，
 * 而它与近近似判重都在**同一个数据库**上跑。上一条用例留下的内容会成为
 * 下一条的相似候选 —— 于是「官方内容」并进了上一条建的事件、
 * 于是它变成 `OFFICIAL_CONFIRMATION` 而不是 `PRIMARY_SOURCE`、
 * 于是独立来源数把上一条的来源也算进去。
 *
 * 第一版靠「给正文加随机标记」来隔离，但标记必须长到能主导 shingle 集合
 * 才有效 —— 那是在跟相似度算法较劲，脆弱且难解释。
 * 直接清库才是可靠的隔离方式。
 */
afterEach(async () => {
  const sources = [sourceId, secondSourceId, officialSourceId].filter(
    (id): id is bigint => id !== undefined,
  );
  if (sources.length === 0) return;

  // 事件随内容级联（EventContent / EventEvidence 都挂在其下）。
  await prisma.event.deleteMany({
    where: { contents: { some: { sourceId: { in: sources } } } },
  });
  await prisma.content.deleteMany({ where: { sourceId: { in: sources } } });
  await prisma.rawItem.deleteMany({ where: { sourceId: { in: sources } } });
});

afterAll(async () => {
  // 逆着外键顺序清理，只删本测试造的数据。
  // 事件表：本测试建的都挂在被测内容上，按 eventId 清理（EventContent 级联）
  await prisma.event.deleteMany({ where: { contents: { some: { sourceId: { in: [sourceId, secondSourceId, officialSourceId] } } } } });
  await prisma.content.deleteMany({ where: { sourceId: { in: [sourceId, secondSourceId, officialSourceId] } } });
  await prisma.rawItem.deleteMany({ where: { sourceId: { in: [sourceId, secondSourceId, officialSourceId] } } });
  await prisma.source.deleteMany({ where: { id: { in: [sourceId, secondSourceId] } } });
  await prisma.$disconnect();
});

describe('findRawItemWithSource（真库 join + 枚举桥接）', () => {
  it('把 RawItem 与它的 Source 类型一起读出来', async () => {
    const rawItemId = await seedRawItem();

    const found = await repository.findRawItemWithSource(rawItemId);

    expect(found).not.toBeNull();
    expect(found!.sourceId).toBe(String(sourceId));
    // 契约枚举（不是 Prisma 枚举）—— 桥接的读取方向在真库上成立
    expect(found!.sourceType).toBe(SourceType.RSS);
    expect(found!.status).toBe(RawItemStatus.FETCHED);
    expect(found!.titleRaw).toContain('Anthropic');
  });

  it('不存在的 id 返回 null', async () => {
    await expect(repository.findRawItemWithSource('999999999')).resolves.toBeNull();
  });

  it('超界 id 返回 null 而不是抛驱动层异常（BIGINT 上界守卫）', async () => {
    // 18446744073709551615 是 BIGINT UNSIGNED 的合法上限，
    // 但 Prisma 按**有符号** 64 位绑定 —— 直接传会抛
    // PrismaClientUnknownRequestError。这里必须是干净的 null。
    await expect(
      repository.findRawItemWithSource('18446744073709551615'),
    ).resolves.toBeNull();
  });

  it('畸形 id 返回 null', async () => {
    for (const bad of ['', 'abc', '-1', '1.5', '1e3']) {
      await expect(repository.findRawItemWithSource(bad)).resolves.toBeNull();
    }
  });
});

describe('Normalize 端到端（真库写入）', () => {
  it('RawItem → Content，RawItem 状态推进到 NORMALIZED', async () => {
    const rawItemId = await seedRawItem();

    const outcome = await service.normalize(rawItemId);
    expect(outcome.status).toBe('NORMALIZED');

    const content = await prisma.content.findUniqueOrThrow({
      where: { rawItemId: BigInt(rawItemId) },
    });
    expect(content.title).toBe('Anthropic 发布新的评测报告');
    expect(content.bodyOriginal).toContain('推理成本');
    expect(content.pipelineStatus).toBe(ContentPipelineStatus.INGESTED);
    expect(content.type).toBe('ARTICLE');
    expect(content.language).toBe('en');

    const rawItem = await prisma.rawItem.findUniqueOrThrow({ where: { id: BigInt(rawItemId) } });
    expect(rawItem.status).toBe(RawItemStatus.NORMALIZED);
    expect(rawItem.failureCode).toBeNull();
  });

  it('**全链路的清洗也在真库上成立**：正文里没有 script / onclick', async () => {
    const rawItemId = await seedRawItem({
      bodyRaw: '<p onclick="alert(1)">正文</p><script>bad()</script>',
    });

    await service.normalize(rawItemId);

    const content = await prisma.content.findUniqueOrThrow({
      where: { rawItemId: BigInt(rawItemId) },
    });
    expect(content.bodyOriginal).toContain('正文');
    expect(content.bodyOriginal).not.toMatch(/script/i);
    expect(content.bodyOriginal).not.toMatch(/onclick/i);
  });

  it('中文与 emoji 在真库（utf8mb4）上往返无损', async () => {
    const rawItemId = await seedRawItem({
      titleRaw: '《信号》评测 🚀',
      bodyRaw: '<p>模型 🚀 能力 —— 真的。</p>',
    });

    await service.normalize(rawItemId);

    const content = await prisma.content.findUniqueOrThrow({
      where: { rawItemId: BigInt(rawItemId) },
    });
    expect(content.title).toBe('《信号》评测 🚀');
    expect(content.bodyOriginal).toContain('🚀');
  });

  it('又一次归一化同一条 RawItem：幂等命中，库里仍只有一行', async () => {
    const rawItemId = await seedRawItem();

    const first = await service.normalize(rawItemId);
    const second = await service.normalize(rawItemId);

    expect(await prisma.content.count({ where: { rawItemId: BigInt(rawItemId) } })).toBe(1);
    if (first.status !== 'NORMALIZED' || second.status !== 'NORMALIZED') {
      throw new Error('unreachable');
    }
    expect(second.alreadyExisted).toBe(true);
    expect(second.contentId).toBe(first.contentId);
  });
});

describe('唯一约束与并发（真库才验得到）', () => {
  it('`contents.raw_item_id` 的唯一约束真的存在：绕过 service 直写会被拒', async () => {
    const rawItemId = await seedRawItem();
    await service.normalize(rawItemId);

    const raw = await prisma.rawItem.findUniqueOrThrow({ where: { id: BigInt(rawItemId) } });
    await expect(
      prisma.content.create({
        data: {
          sourceId,
          rawItemId: BigInt(rawItemId),
          type: ContentType.ARTICLE,
          title: '第二条',
          language: 'en',
          originalUrl: raw.originalUrl,
          pipelineStatus: 'INGESTED',
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('并发归一化同一条 RawItem：**两个都成功**，库里仍只有一行', async () => {
    // 两条路径同时跑：一条走「先查再建」，一条必然撞上唯一约束。
    // 撞上的那条应当被识别为「别人已经建好了」而不是报错 ——
    // 「同一份事实只归一化一次」正是我们想要的语义。
    const rawItemId = await seedRawItem();

    const [a, b] = await Promise.all([
      service.normalize(rawItemId),
      service.normalize(rawItemId),
    ]);

    expect(a.status).toBe('NORMALIZED');
    expect(b.status).toBe('NORMALIZED');
    expect(await prisma.content.count({ where: { rawItemId: BigInt(rawItemId) } })).toBe(1);
  });
});

describe('事务原子性（真库回滚）', () => {
  it('Content 建失败时 RawItem 状态不被推进', async () => {
    // 造一个注定失败的写入：把 title 设成超过 VarChar(700) 的长度，
    // 让 `content.create` 抛错 —— 此时同事务里的 RawItem 更新必须一起回滚。
    const rawItemId = await seedRawItem();

    await expect(
      repository.createContentAndAdvance({
        sourceId: String(sourceId),
        rawItemId,
        type: ContentType.ARTICLE,
        title: '超'.repeat(20_000),
        bodyOriginal: null,
        language: 'en',
        originalUrl: 'https://example.com/x',
        imageUrl: null,
        publishedAt: null,
        pipelineStatus: ContentPipelineStatus.INGESTED,
      }),
    ).rejects.toThrow();

    const rawItem = await prisma.rawItem.findUniqueOrThrow({ where: { id: BigInt(rawItemId) } });
    // 关键：仍是 FETCHED → 调度器下一轮会重新捞起它（正确的可重试语义）
    expect(rawItem.status).toBe(RawItemStatus.FETCHED);
    expect(await prisma.content.count({ where: { rawItemId: BigInt(rawItemId) } })).toBe(0);
  });
});

describe('失败标记（真库）', () => {
  it('清洗后什么都没有 → RawItem 标 FAILED 且带 failureCode', async () => {
    const rawItemId = await seedRawItem({ titleRaw: null, bodyRaw: null });

    const outcome = await service.normalize(rawItemId);

    expect(outcome.status).toBe('FAILED');
    const rawItem = await prisma.rawItem.findUniqueOrThrow({ where: { id: BigInt(rawItemId) } });
    expect(rawItem.status).toBe(RawItemStatus.FAILED);
    expect(rawItem.failureCode).toBe(DomainErrorCode.CONTENT_EMPTY);
    expect(await prisma.content.count({ where: { rawItemId: BigInt(rawItemId) } })).toBe(0);
  });

  it('Normalize 成功时清掉上一次的 failureCode', async () => {
    const rawItemId = await seedRawItem({
      titleRaw: null,
      bodyRaw: null,
      failureCode: 'CONTENT_EMPTY',
      status: 'FAILED',
    });

    // 先失败一次
    await service.normalize(rawItemId);
    // 再把内容补上，重跑（模拟上游修订了正文）
    await prisma.rawItem.update({
      where: { id: BigInt(rawItemId) },
      data: { titleRaw: '补上的标题', bodyRaw: '<p>补上的正文</p>' },
    });
    const outcome = await service.normalize(rawItemId);

    expect(outcome.status).toBe('NORMALIZED');
    const rawItem = await prisma.rawItem.findUniqueOrThrow({ where: { id: BigInt(rawItemId) } });
    expect(rawItem.failureCode).toBeNull();
  });
});

describe('Exact Dedup（真库：走 `raw_items.content_hash` 索引）', () => {
  /** 同一个内容哈希，用来模拟「同一份内容从不同来源出现」。 */
  const sharedHash = randomBytes(32).toString('hex');

  it('跨来源的同一份内容：第二条被标 DUPLICATE，库里只有一条 Content', async () => {
    const firstId = await seedRawItem({ contentHash: sharedHash });
    const secondId = await seedRawItem({
      contentHash: sharedHash,
      externalId: `ext-dup-${randomBytes(4).toString('hex')}`,
    });

    const first = await service.normalize(firstId);
    const second = await service.normalize(secondId);

    expect(first.status).toBe('NORMALIZED');
    expect(second.status).toBe('DUPLICATE');
    if (second.status !== 'DUPLICATE') throw new Error('unreachable');
    expect(second.sameSource).toBe(true); // 两条都挂在本测试的同一个 Source 上

    // 关键：库里只有一条 Content —— 判重发生在落库**之前**
    const contents = await prisma.content.findMany({
      where: { rawItemId: { in: [BigInt(firstId), BigInt(secondId)] } },
      select: { id: true },
    });
    expect(contents).toHaveLength(1);

    const dupRaw = await prisma.rawItem.findUniqueOrThrow({ where: { id: BigInt(secondId) } });
    expect(dupRaw.status).toBe(RawItemStatus.DUPLICATE);
  });

  it('哈希不同 → 两条各自成为 Content', async () => {
    const a = await seedRawItem({ contentHash: randomBytes(32).toString('hex') });
    const b = await seedRawItem({ contentHash: randomBytes(32).toString('hex') });

    const [ra, rb] = await Promise.all([service.normalize(a), service.normalize(b)]);

    expect(ra.status).toBe('NORMALIZED');
    expect(rb.status).toBe('NORMALIZED');
  });

  it('没有 content_hash 的条目不会被判重（真库里 hash 列可空）', async () => {
    const a = await seedRawItem({ contentHash: null });
    const b = await seedRawItem({ contentHash: null });

    const [ra, rb] = await Promise.all([service.normalize(a), service.normalize(b)]);

    expect(ra.status).toBe('NORMALIZED');
    expect(rb.status).toBe('NORMALIZED');
  });
});

describe('Near Dedup 的候选查询（真库）', () => {
  /** 同一事件的两篇中文报道。 */
  const SAME_A = 'Anthropic 发布了新的模型能力评测报告，指出推理成本在 2026 年下降了约 40%。';
  const SAME_B = 'Anthropic 发布最新模型能力评测报告，报告指出推理成本在 2026 年下降约 40%。';

  it('候选查询能读回候选、并把 HTML 转成纯文本', async () => {
    const a = await seedRawItem({ titleRaw: '评测报告', bodyRaw: `<p>${SAME_A}</p>` });
    const b = await seedRawItem({ titleRaw: '评测报告', bodyRaw: `<p>${SAME_B}</p>` });

    const ra = await service.normalize(a);
    const rb = await service.normalize(b);
    if (ra.status !== 'NORMALIZED' || rb.status !== 'NORMALIZED') {
      throw new Error('unreachable');
    }

    const candidates = await repository.findSimilarityCandidates({
      since: new Date(Date.now() - 24 * 3600 * 1000),
      limit: 50,
      excludeContentId: rb.contentId,
    });

    const forA = candidates.find((c) => c.contentId === ra.contentId);
    expect(forA).toBeDefined();
    // ⚠ 关键：text 是**纯文本**，不含 `<p>` 标签 —— 转换发生在仓储边界
    expect(forA!.text).toContain('推理成本');
    expect(forA!.text).not.toContain('<p>');
  });

  it('端到端：真库上的近似判重能找到同一事件的另一篇报道', async () => {
    const a = await seedRawItem({ titleRaw: '评测报告', bodyRaw: `<p>${SAME_A}</p>` });
    // ⚠ 必须来自**另一个来源** —— 同一个 Source 上的相似内容是
    // 「同源重复发布」，会进 `sameSourceMatches`；而「同一事件被不同媒体报道」
    // 才是 `crossSourceMatches`，两者语义不同（见 similarity.ts）。
    const b = await seedRawItem(
      {
        titleRaw: '评测报告',
        bodyRaw: `<p>${SAME_B}</p>`,
        externalId: `ext-near-${randomBytes(4).toString('hex')}`,
      },
      secondSourceId,
    );

    const ra = await service.normalize(a);
    const rb = await service.normalize(b);
    if (ra.status !== 'NORMALIZED' || rb.status !== 'NORMALIZED') {
      throw new Error('unreachable');
    }

    const verdict = await service.findNearDuplicates(rb.contentId);

    expect(verdict).not.toBeNull();
    expect(verdict!.crossSourceMatches.map((m) => m.contentId)).toContain(ra.contentId);
    expect(verdict!.crossSourceMatches[0]!.score).toBeGreaterThanOrEqual(0.35);
  });

  it('runNearDedup 把 RawItem 推进到 READY_FOR_ANALYSIS', async () => {
    const a = await seedRawItem({ bodyRaw: `<p>${SAME_A}</p>` });

    const outcome = await service.normalize(a);
    if (outcome.status !== 'NORMALIZED') throw new Error('unreachable');

    const verdict = await service.runNearDedup(outcome.contentId);

    expect(verdict).not.toBeNull();
    const rawItem = await prisma.rawItem.findUniqueOrThrow({ where: { id: BigInt(a) } });
    expect(rawItem.status).toBe(RawItemStatus.READY_FOR_ANALYSIS);
  });

  it('候选查询**不跨出时间窗**', async () => {
    const a = await seedRawItem({ bodyRaw: `<p>${SAME_A}</p>` });
    const outcome = await service.normalize(a);
    if (outcome.status !== 'NORMALIZED') throw new Error('unreachable');

    const candidates = await repository.findSimilarityCandidates({
      // 窗口起点设在未来 → 一条都不该返回
      since: new Date(Date.now() + 24 * 3600 * 1000),
      limit: 50,
      excludeContentId: outcome.contentId,
    });

    expect(candidates).toHaveLength(0);
  });
});

describe('Event Cluster（真库：Event / EventContent / contents.event_id）', () => {
  /**
   * 见 Evidence Attach 那组的同名说明：**每个用例一个长随机标记**，
   * 用例内两篇共享标记（相似度高 → 会聚到一起），
   * 用例之间标记不同（相似度低 → 不会跨用例并进同一个事件）。
   */
  function scene(): { a: string; b: string } {
    const marker = randomBytes(24).toString('hex');
    return {
      a: `某公司在 2026 年发布技术报告，编号 ${marker}，指出推理成本下降约 40%。`,
      b: `某公司在 2026 年发布技术报告，编号 ${marker}，报告指出推理成本下降约 40%。`,
    };
  }

  it('同一事件的跨源报道被聚到同一个 Event', async () => {
    const { a, b } = scene();
    const rawA = await seedRawItem({ titleRaw: '技术报告', bodyRaw: `<p>${a}</p>` });
    const rawB = await seedRawItem(
      { titleRaw: '技术报告', bodyRaw: `<p>${b}</p>`, externalId: `ext-${randomBytes(6).toString('hex')}` },
      secondSourceId,
    );

    const ra = await service.normalize(rawA);
    const rb = await service.normalize(rawB);
    if (ra.status !== 'NORMALIZED' || rb.status !== 'NORMALIZED') throw new Error('unreachable');

    const first = await service.clusterContent(ra.contentId);
    const second = await service.clusterContent(rb.contentId);

    expect(first?.action).toBe('create');
    expect(second).toMatchObject({ action: 'join', eventId: first!.eventId });

    const members = await prisma.eventContent.findMany({
      where: { eventId: BigInt(first!.eventId) },
      select: { contentId: true },
    });
    expect(members).toHaveLength(2);

    const contentB = await prisma.content.findUniqueOrThrow({
      where: { id: BigInt(rb.contentId) },
      select: { eventId: true },
    });
    expect(String(contentB.eventId)).toBe(first!.eventId);
  });

  it('**幂等**：同一条内容聚合两次不会新建第二个 Event', async () => {
    const { a } = scene();
    const rawItemId = await seedRawItem({ bodyRaw: `<p>${a}</p>` });
    const ra = await service.normalize(rawItemId);
    if (ra.status !== 'NORMALIZED') throw new Error('unreachable');

    const first = await service.clusterContent(ra.contentId);
    const second = await service.clusterContent(ra.contentId);

    expect(second).toMatchObject({ action: 'join', eventId: first!.eventId, alreadyMember: true });

    const events = await prisma.event.findMany({
      where: { eventContents: { some: { contentId: BigInt(ra.contentId) } } },
      select: { id: true },
    });
    expect(events).toHaveLength(1);
  });

  it('`contents.event_id` 与 `EventContent` 保持一致（docs/03 要求业务代码自己维护）', async () => {
    const { a } = scene();
    const rawItemId = await seedRawItem({ bodyRaw: `<p>${a}</p>` });
    const ra = await service.normalize(rawItemId);
    if (ra.status !== 'NORMALIZED') throw new Error('unreachable');

    const outcome = await service.clusterContent(ra.contentId);

    const content = await prisma.content.findUniqueOrThrow({
      where: { id: BigInt(ra.contentId) },
      select: { eventId: true },
    });
    const viaRelation = await prisma.eventContent.findFirstOrThrow({
      where: { contentId: BigInt(ra.contentId) },
      select: { eventId: true },
    });
    expect(String(content.eventId)).toBe(String(viaRelation.eventId));
    expect(String(content.eventId)).toBe(outcome!.eventId);
  });
});


describe('Evidence Attach（真库：五类证据 + Primary 事务唯一）', () => {
  /**
   * 一次「场景」= 两篇**彼此相似**的报道。
   *
   * ⚠ 标记必须**每个用例一个**：
   * - 用例内两篇共享标记 → 相似度够高 → 会被聚到同一个事件（这是要测的）；
   * - 用例之间标记不同 → 不会跨用例并进同一个事件。
   *
   * 第一版所有用例共用同一段固定正文，于是后一条用例**并进了前一条建的事件**，
   * 官方内容因此变成 `OFFICIAL_CONFIRMATION`（事件里已有 Primary）、
   * 独立来源数把前面的来源也算了进来 —— 整组假失败。
   * 这一组测试跑在**同一个数据库**上，隔离必须自己保证。
   */
  function scene(): { a: string; b: string } {
    // ⚠ 标记必须**足够长**。第一版用了 6 字节（12 个字符），
    // 淹没在共享正文里 —— 两篇不同用例的相似度依然很高，
    // 于是后一条用例并进了前一条的事件，整组假失败。
    // 24 字节的随机串才能主导 shingle 集合，把跨用例相似度压到阈值以下。
    const marker = randomBytes(24).toString('hex');
    return {
      a: `某公司在 2026 年发布技术报告，编号 ${marker}，指出推理成本下降约 40%。`,
      b: `某公司在 2026 年发布技术报告，编号 ${marker}，报告指出推理成本下降约 40%。`,
    };
  }

  beforeAll(async () => {
    const official = await prisma.source.create({
      data: {
        name: `Content IT Official ${SUFFIX}`,
        slug: `${SLUG}-official`,
        type: 'RSS',
        kind: 'OFFICIAL',
        tier: 'S',
        official: true,
        config: { seed: false, note: 'agent-05 integration test fixture (official)' },
      },
      select: { id: true },
    });
    officialSourceId = official.id;
  });

  async function clusterOne(body: string, onSourceId: bigint): Promise<string> {
    const rawItemId = await seedRawItem({ titleRaw: '技术报告', bodyRaw: `<p>${body}</p>` }, onSourceId);
    const outcome = await service.normalize(rawItemId);
    if (outcome.status !== 'NORMALIZED') throw new Error('unreachable');
    const clustered = await service.clusterContent(outcome.contentId);
    if (clustered === null) throw new Error('unreachable');
    return clustered.eventId;
  }

  async function clusterAdditional(body: string, onSourceId: bigint, eventId: string): Promise<void> {
    const rawItemId = await seedRawItem(
      { titleRaw: '技术报告', bodyRaw: `<p>${body}</p>`, externalId: `ext-${randomBytes(6).toString('hex')}` },
      onSourceId,
    );
    const normalized = await service.normalize(rawItemId);
    if (normalized.status !== 'NORMALIZED') throw new Error('unreachable');
    const clustered = await service.clusterContent(normalized.contentId);
    expect(clustered?.eventId).toBe(eventId);
  }

  it('官方来源生成 PRIMARY_SOURCE，且**恰好一条 isPrimary**', async () => {
    const { a } = scene();
    const eventId = await clusterOne(a, officialSourceId);

    const evidence = await prisma.eventEvidence.findMany({
      where: { eventId: BigInt(eventId) },
      select: { evidenceType: true, isPrimary: true },
    });

    expect(evidence).toHaveLength(1);
    expect(evidence[0]!.evidenceType).toBe('PRIMARY_SOURCE');
    expect(evidence.filter((item) => item.isPrimary)).toHaveLength(1);
  });

  it('媒体来源生成 SUPPORTING_SOURCE，**不设 Primary**', async () => {
    const { a } = scene();
    const eventId = await clusterOne(a, secondSourceId);

    const evidence = await prisma.eventEvidence.findMany({
      where: { eventId: BigInt(eventId) },
      select: { evidenceType: true, isPrimary: true },
    });

    expect(evidence).toHaveLength(1);
    expect(evidence[0]!.evidenceType).toBe('SUPPORTING_SOURCE');
    // 媒体事件没有官方来源 → 不设 Primary（「有 Primary」是可信度断言）
    expect(evidence.filter((item) => item.isPrimary)).toHaveLength(0);
  });

  it('**官方随后加入时 Primary 切换过去，且始终只有一个**', async () => {
    const { a, b } = scene();
    const eventId = await clusterOne(a, secondSourceId); // 媒体先报
    await clusterAdditional(b, officialSourceId, eventId); // 官方随后发公告

    const evidence = await prisma.eventEvidence.findMany({
      where: { eventId: BigInt(eventId) },
      select: { evidenceType: true, isPrimary: true },
    });

    expect(evidence).toHaveLength(2);
    // 不变式：**任何时刻最多一个 Primary**（docs/03 明确 DB 层不强制、必须靠事务）
    expect(evidence.filter((item) => item.isPrimary)).toHaveLength(1);
    // 而它必须是官方那条
    expect(evidence.find((item) => item.isPrimary)!.evidenceType).toBe('PRIMARY_SOURCE');
  });

  it('**同 Source 的多条内容只算一个独立来源**（真库上按 source_id 去重）', async () => {
    const { a, b } = scene();
    const eventId = await clusterOne(a, secondSourceId);

    const rawItemId = await seedRawItem(
      {
        titleRaw: '技术报告',
        bodyRaw: `<p>${b}</p>`,
        externalId: `ext-${randomBytes(6).toString('hex')}`,
        originalUrl: `https://example.com/${SUFFIX}/same-source-${randomBytes(4).toString('hex')}`,
      },
      secondSourceId,
    );
    const normalized = await service.normalize(rawItemId);
    if (normalized.status !== 'NORMALIZED') throw new Error('unreachable');
    const clustered = await service.clusterContent(normalized.contentId);

    // 两条证据、但都来自同一个 Source → 独立来源数仍是 1
    expect(clustered?.eventId).toBe(eventId);
    expect(clustered?.evidence?.independentSourceCount).toBe(1);

    const rows = await prisma.eventEvidence.findMany({
      where: { eventId: BigInt(eventId) },
      select: { sourceId: true },
    });
    expect(new Set(rows.map((row) => String(row.sourceId))).size).toBe(1);
  });

  it('重复聚合不会重复插证据（真库唯一约束 + 幂等）', async () => {
    const { a } = scene();
    const rawItemId = await seedRawItem(
      { titleRaw: '技术报告', bodyRaw: `<p>${a}</p>` },
      officialSourceId,
    );
    const normalized = await service.normalize(rawItemId);
    if (normalized.status !== 'NORMALIZED') throw new Error('unreachable');

    const first = await service.clusterContent(normalized.contentId);
    await service.clusterContent(normalized.contentId);

    const count = await prisma.eventEvidence.count({ where: { eventId: BigInt(first!.eventId) } });
    expect(count).toBe(1);
  });
});


describe('AI 衔接 + Review Queue（真库）', () => {
  function scene(): string {
    const marker = randomBytes(24).toString('hex');
    return `某公司在 2026 年发布技术报告，编号 ${marker}，指出推理成本下降约 40%。`;
  }

  /** 造一条走到 ANALYZING 的内容。 */
  async function analyzedContent(marker: string): Promise<string> {
    const rawItemId = await seedRawItem({ titleRaw: '技术报告', bodyRaw: `<p>${marker}</p>` });
    const outcome = await service.normalize(rawItemId);
    if (outcome.status !== 'NORMALIZED') throw new Error('unreachable');
    await service.clusterContent(outcome.contentId);
    return outcome.contentId;
  }

  it('聚类后 pipelineStatus = ANALYZING', async () => {
    const contentId = await analyzedContent(scene());

    const content = await prisma.content.findUniqueOrThrow({
      where: { id: BigInt(contentId) },
      select: { pipelineStatus: true },
    });
    expect(content.pipelineStatus).toBe('ANALYZING');
  });

  it('AI 跑完后收尾：REVIEW_PENDING + EditorialReview(PENDING) + ContentTopic', async () => {
    const contentId = await analyzedContent(scene());
    const topic = await prisma.topic.findFirstOrThrow({ select: { id: true, slug: true } });

    // 模拟 Agent 06 的产物：一条 SUCCEEDED 的 AiRun + 写进 ai_analysis 的主题
    await prisma.aiRun.create({
      data: {
        contentId: BigInt(contentId),
        taskType: 'SCORE',
        provider: 'openai-compatible',
        model: 'gpt-4o-mini',
        promptVersion: 'v1',
        status: 'SUCCEEDED',
      },
    });
    await prisma.content.update({
      where: { id: BigInt(contentId) },
      data: { aiAnalysis: { score: { topics: [topic.slug] } } },
    });

    const finalized = await service.sweepForReview();
    expect(finalized).toBeGreaterThanOrEqual(1);

    const content = await prisma.content.findUniqueOrThrow({
      where: { id: BigInt(contentId) },
      select: { pipelineStatus: true, review: { select: { status: true } }, topics: true },
    });
    expect(content.pipelineStatus).toBe('REVIEW_PENDING');
    expect(content.review?.status).toBe('PENDING');
    expect(content.topics.map((t) => String(t.topicId))).toContain(String(topic.id));
  });

  it('AiRun 还在途时**不收尾**', async () => {
    const contentId = await analyzedContent(scene());
    await prisma.aiRun.create({
      data: {
        contentId: BigInt(contentId),
        taskType: 'SCORE',
        provider: 'openai-compatible',
        model: 'gpt-4o-mini',
        promptVersion: 'v1',
        status: 'RUNNING',
      },
    });

    await service.sweepForReview();

    const content = await prisma.content.findUniqueOrThrow({
      where: { id: BigInt(contentId) },
      select: { pipelineStatus: true },
    });
    expect(content.pipelineStatus).toBe('ANALYZING');
  });
});


describe('bigint-id 的边界（真库对照）', () => {
  it('toBindableId 的上界与 Prisma 的实际能力一致', () => {
    expect(toBindableId('9223372036854775807')).toBe(9_223_372_036_854_775_807n);
    expect(toBindableId('9223372036854775808')).toBeNull();
    expect(toBindableId('18446744073709551615')).toBeNull();
  });
});
