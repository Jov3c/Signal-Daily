import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PrismaClient, SourceKind, SourceTier, SourceType } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * 数据库集成测试 —— **需要真实 MySQL 8**。
 *
 * 运行：pnpm test:db
 * 前置：pnpm db:migrate（建表）
 *
 * 这些用例不静默跳过：连不上库就直接失败，避免「看着是绿的其实没验」。
 * 对应 tasks/agent-01-database.md 的「测试」一节。
 */

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** 如果没有显式设置 DATABASE_URL，就从仓库根的 .env 读取。 */
function loadDotEnv(): void {
  const envPath = fileURLToPath(new URL('../../.env', import.meta.url));
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    const key = match[1] as string;
    const value = (match[2] ?? '').replace(/^["']|["']$/g, '');
    if (!process.env[key]) process.env[key] = value;
  }
}

loadDotEnv();

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error(
    'DATABASE_URL 未设置。请在仓库根创建 .env（参考 .env.example），或先 export DATABASE_URL。',
  );
}

const prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });

/** 测试数据的识别前缀，便于清理。 */
const TAG = 'itest01';

let seq = 0;
/** 生成全局唯一后缀，避免同一测试内多次建同名 slug/email 撞唯一约束。 */
const uniq = (): string => `${TAG}-${Date.now()}-${seq++}`;

/** 期望存在的表（docs/03）。 */
const EXPECTED_TABLES = [
  'users',
  'auth_accounts',
  'email_otp_codes',
  'sessions',
  'user_preferences',
  'sources',
  'people',
  'topics',
  'raw_items',
  'events',
  'event_evidence',
  'contents',
  'content_topics',
  'event_contents',
  'editorial_reviews',
  'featured_items',
  'daily_editions',
  'daily_sections',
  'daily_items',
  'bookmarks',
  'reading_progress',
  'ai_runs',
  'job_runs',
  'admin_notifications',
];

async function listTables(): Promise<string[]> {
  const rows = await prisma.$queryRaw<{ TABLE_NAME: string }[]>`
    SELECT TABLE_NAME FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'
  `;
  return rows.map((row) => row.TABLE_NAME);
}

async function cleanup(): Promise<void> {
  // 顺序：先删子表再删父表（外键约束）
  await prisma.eventEvidence.deleteMany({ where: { url: { contains: TAG } } });
  await prisma.content.deleteMany({ where: { originalUrl: { contains: TAG } } });
  await prisma.event.deleteMany({ where: { canonicalTitle: { contains: TAG } } });
  await prisma.source.deleteMany({ where: { slug: { contains: TAG } } });
  await prisma.user.deleteMany({ where: { email: { contains: TAG } } });
}

beforeAll(async () => {
  try {
    const tables = await listTables();
    if (!tables.includes('sources')) {
      throw new Error('sources 表不存在');
    }
  } catch (error) {
    throw new Error(
      `无法连接数据库或 schema 未建立。请确认 MySQL 可用，并先执行 pnpm db:migrate。\n` +
        `DATABASE_URL = ${DATABASE_URL}`,
      { cause: error },
    );
  }
  await cleanup();
});

afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

/* ------------------------------------------------------------------ */

describe('迁移结果（空库 migrate 后）', () => {
  it('docs/03 的 24 张表全部存在', async () => {
    const tables = await listTables();
    for (const table of EXPECTED_TABLES) {
      expect(tables, `缺少表 ${table}`).toContain(table);
    }
  });

  it('数据库里不存在任何订阅表（规则 §13）', async () => {
    const tables = await listTables();
    const offenders = tables.filter((t) => t.toLowerCase().includes('subscription'));
    expect(offenders).toEqual([]);
  });

  it('contents 上存在 FULLTEXT 索引', async () => {
    const rows = await prisma.$queryRaw<{ INDEX_NAME: string; INDEX_TYPE: string }[]>`
      SELECT INDEX_NAME, INDEX_TYPE FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'contents' AND INDEX_TYPE = 'FULLTEXT'
    `;
    expect(rows.length).toBeGreaterThan(0);
  });

  it('contents FULLTEXT 覆盖 title / summary / body_translated 三列', async () => {
    const rows = await prisma.$queryRaw<{ COLUMN_NAME: string }[]>`
      SELECT DISTINCT COLUMN_NAME FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'contents' AND INDEX_TYPE = 'FULLTEXT'
    `;
    const columns = rows.map((r) => r.COLUMN_NAME).sort();
    expect(columns).toEqual(['body_translated', 'summary', 'title']);
  });
});

/* ------------------------------------------------------------------ */

describe('Seed 幂等', () => {
  const runSeed = (): void => {
    execFileSync(process.execPath, ['prisma/dist/seed.js'], {
      cwd: ROOT,
      env: { ...process.env, DATABASE_URL },
      stdio: 'pipe',
    });
  };

  it('seed 产物存在（需先 pnpm build）', () => {
    expect(existsSync(`${ROOT}prisma/dist/seed.js`)).toBe(true);
  });

  it('连续执行两次，数据量不翻倍', async () => {
    runSeed();
    const first = {
      admins: await prisma.user.count({ where: { role: 'ADMIN' } }),
      topics: await prisma.topic.count(),
      xSources: await prisma.source.count({ where: { type: SourceType.X_USER } }),
      rssSources: await prisma.source.count({ where: { type: SourceType.RSS } }),
    };

    runSeed();
    const second = {
      admins: await prisma.user.count({ where: { role: 'ADMIN' } }),
      topics: await prisma.topic.count(),
      xSources: await prisma.source.count({ where: { type: SourceType.X_USER } }),
      rssSources: await prisma.source.count({ where: { type: SourceType.RSS } }),
    };

    expect(second).toEqual(first);
    expect(first.admins).toBeGreaterThanOrEqual(1);
    expect(first.topics).toBeGreaterThanOrEqual(8);
    expect(first.xSources).toBeGreaterThanOrEqual(3);
    expect(first.xSources).toBeLessThanOrEqual(6);
    expect(first.rssSources).toBeGreaterThanOrEqual(1);
  });

  it('seed 出的 X 白名单是 type=X_USER 且带 seed 标记', async () => {
    const sources = await prisma.source.findMany({
      where: { type: SourceType.X_USER, slug: { startsWith: 'x-' } },
      take: 3,
    });
    expect(sources.length).toBeGreaterThan(0);
    for (const source of sources) {
      expect(source.kind).toBe(SourceKind.PERSON);
      expect(source.official).toBe(false);
      expect(source.config).toMatchObject({ seed: true });
    }
  });

  it('不覆盖管理员对已存在记录的编辑（回归守卫）', async () => {
    // 早期版本在 upsert 的 update 分支里回写 name/kind/tier/official，
    // 会把管理员在后台改过的内容静默打回 seed 值
    // （实测 14 项可编辑字段里有 7 项被回滚）。
    // 现在所有 upsert 的 update 都是空对象：只补缺失，绝不动已有记录。
    const topic = await prisma.topic.findFirstOrThrow({ where: { slug: 'ai-models' } });
    const source = await prisma.source.findFirstOrThrow({ where: { slug: 'x-karpathy' } });

    const original = {
      topicName: topic.name,
      topicDescription: topic.description,
      sourceName: source.name,
      sourceKind: source.kind,
      sourceTier: source.tier,
      sourceOfficial: source.official,
    };

    const EDITED = {
      topicName: '管理员改过的名字',
      topicDescription: '管理员改过的简介',
      sourceName: '管理员改过的来源名',
    };

    try {
      await prisma.topic.update({
        where: { id: topic.id },
        data: { name: EDITED.topicName, description: EDITED.topicDescription },
      });
      await prisma.source.update({
        where: { id: source.id },
        data: {
          name: EDITED.sourceName,
          kind: SourceKind.MEDIA,
          tier: SourceTier.C,
          official: true,
        },
      });

      runSeed();

      const afterTopic = await prisma.topic.findUniqueOrThrow({ where: { id: topic.id } });
      const afterSource = await prisma.source.findUniqueOrThrow({ where: { id: source.id } });

      expect(afterTopic.name).toBe(EDITED.topicName);
      expect(afterTopic.description).toBe(EDITED.topicDescription);
      expect(afterSource.name).toBe(EDITED.sourceName);
      expect(afterSource.kind).toBe(SourceKind.MEDIA);
      expect(afterSource.tier).toBe(SourceTier.C);
      expect(afterSource.official).toBe(true);
    } finally {
      await prisma.topic.update({
        where: { id: topic.id },
        data: { name: original.topicName, description: original.topicDescription },
      });
      await prisma.source.update({
        where: { id: source.id },
        data: {
          name: original.sourceName,
          kind: original.sourceKind,
          tier: original.sourceTier,
          official: original.sourceOfficial,
        },
      });
    }
  });
});

/* ------------------------------------------------------------------ */

describe('Source 枚举落库（tier / kind / type）', () => {
  it('四个维度可正确往返', async () => {
    const source = await prisma.source.create({
      data: {
        name: `${TAG} Source`,
        slug: `${TAG}-source`,
        type: SourceType.RSS,
        kind: SourceKind.OFFICIAL,
        tier: SourceTier.S,
        official: true,
        baseUrl: 'https://example.com',
        feedUrl: 'https://example.com/feed.xml',
      },
    });

    const found = await prisma.source.findUniqueOrThrow({ where: { id: source.id } });
    expect(found.type).toBe(SourceType.RSS);
    expect(found.kind).toBe(SourceKind.OFFICIAL);
    expect(found.tier).toBe(SourceTier.S);
    expect(found.official).toBe(true);
    // 默认值来自 docs/03
    expect(found.priority).toBe(50);
    expect(Number(found.trustScore)).toBe(7.0);
    expect(found.fetchIntervalSeconds).toBe(1800);
    expect(found.enabled).toBe(true);
  });

  it('slug 唯一约束生效', async () => {
    await expect(
      prisma.source.create({
        data: {
          name: `${TAG} dup`,
          slug: `${TAG}-source`, // 与上一个相同
          type: SourceType.RSS,
          kind: SourceKind.MEDIA,
        },
      }),
    ).rejects.toThrow();
  });

  it('priority 是 TINYINT：超出范围应失败', async () => {
    await expect(
      prisma.source.create({
        data: {
          name: `${TAG} overflow`,
          slug: `${TAG}-overflow`,
          type: SourceType.RSS,
          kind: SourceKind.MEDIA,
          priority: 999,
        },
      }),
    ).rejects.toThrow();
  });
});

/* ------------------------------------------------------------------ */

describe('Event / EventEvidence', () => {
  async function createEventWithSource(): Promise<{ eventId: bigint; sourceId: bigint }> {
    const source = await prisma.source.create({
      data: {
        name: `${TAG} ev source`,
        slug: uniq(),
        type: SourceType.RSS,
        kind: SourceKind.MEDIA,
      },
    });
    const event = await prisma.event.create({
      data: {
        canonicalTitle: `${TAG} 事件`,
        status: 'OPEN',
        firstSeenAt: new Date(),
        lastSeenAt: new Date(),
      },
    });
    return { eventId: event.id, sourceId: source.id };
  }

  it('(event_id, url_hash) 唯一：同事件同 URL 不能重复加证据', async () => {
    const { eventId, sourceId } = await createEventWithSource();
    const url = `https://example.com/${TAG}/a`;
    const urlHash = 'a'.repeat(64);

    await prisma.eventEvidence.create({
      data: { eventId, sourceId, evidenceType: 'PRIMARY_SOURCE', url, urlHash },
    });

    await expect(
      prisma.eventEvidence.create({
        data: { eventId, sourceId, evidenceType: 'SUPPORTING_SOURCE', url, urlHash },
      }),
    ).rejects.toThrow();
  });

  it('同一 URL 可以出现在不同事件下（唯一约束是按事件隔离的）', async () => {
    const first = await createEventWithSource();
    const second = await createEventWithSource();
    const url = `https://example.com/${TAG}/shared`;
    const urlHash = 'b'.repeat(64);

    await prisma.eventEvidence.create({
      data: {
        eventId: first.eventId,
        sourceId: first.sourceId,
        evidenceType: 'PRIMARY_SOURCE',
        url,
        urlHash,
      },
    });
    await prisma.eventEvidence.create({
      data: {
        eventId: second.eventId,
        sourceId: second.sourceId,
        evidenceType: 'PRIMARY_SOURCE',
        url,
        urlHash,
      },
    });

    const count = await prisma.eventEvidence.count({ where: { urlHash } });
    expect(count).toBe(2);
  });

  it('业务事务保证「一个 Event 最多一个 Primary Evidence」', async () => {
    const { eventId, sourceId } = await createEventWithSource();

    const a = await prisma.eventEvidence.create({
      data: {
        eventId,
        sourceId,
        evidenceType: 'SUPPORTING_SOURCE',
        url: `https://example.com/${TAG}/p-a`,
        urlHash: 'c'.repeat(64),
      },
    });
    const b = await prisma.eventEvidence.create({
      data: {
        eventId,
        sourceId,
        evidenceType: 'SUPPORTING_SOURCE',
        url: `https://example.com/${TAG}/p-b`,
        urlHash: 'd'.repeat(64),
      },
    });

    // 正确的业务写法：在事务里先清掉旧的 primary，再设置新的
    const setPrimary = async (evidenceId: bigint): Promise<void> => {
      await prisma.$transaction([
        prisma.eventEvidence.updateMany({
          where: { eventId, isPrimary: true, NOT: { id: evidenceId } },
          data: { isPrimary: false },
        }),
        prisma.eventEvidence.update({ where: { id: evidenceId }, data: { isPrimary: true } }),
      ]);
    };

    await setPrimary(a.id);
    expect(await prisma.eventEvidence.count({ where: { eventId, isPrimary: true } })).toBe(1);

    await setPrimary(b.id);
    const primaries = await prisma.eventEvidence.findMany({ where: { eventId, isPrimary: true } });
    expect(primaries).toHaveLength(1);
    expect(primaries[0]?.id).toBe(b.id);
  });

  it('注意：DB 层没有强制该不变量，必须由业务事务保证', async () => {
    // 这条用例是「文档即测试」：说明为什么 Agent 05/07 必须用事务切换 primary。
    const { eventId, sourceId } = await createEventWithSource();
    await prisma.eventEvidence.create({
      data: {
        eventId,
        sourceId,
        evidenceType: 'PRIMARY_SOURCE',
        url: `https://e.com/${TAG}/n1`,
        urlHash: 'e'.repeat(64),
        isPrimary: true,
      },
    });
    await prisma.eventEvidence.create({
      data: {
        eventId,
        sourceId,
        evidenceType: 'PRIMARY_SOURCE',
        url: `https://e.com/${TAG}/n2`,
        urlHash: 'f'.repeat(64),
        isPrimary: true,
      },
    });

    const count = await prisma.eventEvidence.count({ where: { eventId, isPrimary: true } });
    expect(count).toBe(2); // 直接写库可以绕过；所以必须靠业务事务
  });

  it('内容删除时证据的 content_id 置空而不是级联删除（onDelete: SetNull）', async () => {
    const { eventId, sourceId } = await createEventWithSource();
    const content = await prisma.content.create({
      data: {
        sourceId,
        type: 'ARTICLE',
        title: `${TAG} 内容`,
        language: 'zh',
        originalUrl: `https://example.com/${TAG}/content-for-evidence`,
        pipelineStatus: 'INGESTED',
      },
    });
    const evidence = await prisma.eventEvidence.create({
      data: {
        eventId,
        sourceId,
        contentId: content.id,
        evidenceType: 'PRIMARY_SOURCE',
        url: `https://example.com/${TAG}/ev-setnull`,
        urlHash: '1'.repeat(64),
      },
    });

    await prisma.content.delete({ where: { id: content.id } });

    const after = await prisma.eventEvidence.findUniqueOrThrow({ where: { id: evidence.id } });
    expect(after.contentId).toBeNull();
  });
});

/* ------------------------------------------------------------------ */

describe('用户能力：Bookmark / ReadingProgress / UserPreference', () => {
  async function createUser(): Promise<bigint> {
    const user = await prisma.user.create({
      data: { email: `${uniq()}@example.com`, role: 'USER' },
    });
    return user.id;
  }

  async function createContent(sourceId: bigint, suffix: string): Promise<bigint> {
    const content = await prisma.content.create({
      data: {
        sourceId,
        type: 'ARTICLE',
        title: `${TAG} ${suffix}`,
        language: 'zh',
        originalUrl: `https://example.com/${TAG}/${suffix}`,
        pipelineStatus: 'INGESTED',
      },
    });
    return content.id;
  }

  async function createSource(): Promise<bigint> {
    const source = await prisma.source.create({
      data: {
        name: `${TAG} u source`,
        slug: uniq(),
        type: SourceType.RSS,
        kind: SourceKind.MEDIA,
      },
    });
    return source.id;
  }

  it('Bookmark 复合主键幂等：同一用户重复收藏同一内容会冲突', async () => {
    const userId = await createUser();
    const sourceId = await createSource();
    const contentId = await createContent(sourceId, 'bm');

    await prisma.bookmark.create({ data: { userId, contentId } });
    await expect(prisma.bookmark.create({ data: { userId, contentId } })).rejects.toThrow();

    // 幂等写法的正解是 upsert
    await prisma.bookmark.upsert({
      where: { userId_contentId: { userId, contentId } },
      update: {},
      create: { userId, contentId },
    });
    expect(await prisma.bookmark.count({ where: { userId } })).toBe(1);
  });

  it('删除内容时 Bookmark 级联删除', async () => {
    const userId = await createUser();
    const sourceId = await createSource();
    const contentId = await createContent(sourceId, 'bm-cascade');

    await prisma.bookmark.create({ data: { userId, contentId } });
    await prisma.content.delete({ where: { id: contentId } });

    expect(await prisma.bookmark.count({ where: { userId } })).toBe(0);
  });

  it('删除用户时 Bookmark 与 ReadingProgress 级联删除', async () => {
    const userId = await createUser();
    const sourceId = await createSource();
    const contentId = await createContent(sourceId, 'cascade-user');

    await prisma.bookmark.create({ data: { userId, contentId } });
    await prisma.readingProgress.create({
      data: { userId, resourceType: 'CONTENT', resourceId: contentId, progress: 0.5 },
    });

    await prisma.user.delete({ where: { id: userId } });

    expect(await prisma.bookmark.count({ where: { userId } })).toBe(0);
    expect(await prisma.readingProgress.count({ where: { userId } })).toBe(0);
  });

  it('ReadingProgress 复合主键 (user, resourceType, resourceId) 幂等', async () => {
    const userId = await createUser();
    const sourceId = await createSource();
    const contentId = await createContent(sourceId, 'rp');

    await prisma.readingProgress.create({
      data: { userId, resourceType: 'CONTENT', resourceId: contentId, progress: 0.25 },
    });
    await expect(
      prisma.readingProgress.create({
        data: { userId, resourceType: 'CONTENT', resourceId: contentId, progress: 0.9 },
      }),
    ).rejects.toThrow();

    const updated = await prisma.readingProgress.upsert({
      where: {
        userId_resourceType_resourceId: { userId, resourceType: 'CONTENT', resourceId: contentId },
      },
      update: { progress: 0.9 },
      create: { userId, resourceType: 'CONTENT', resourceId: contentId, progress: 0.9 },
    });
    expect(Number(updated.progress)).toBeCloseTo(0.9, 4);
  });

  it('UserPreference 与 User 是 1:1，主键就是 user_id', async () => {
    const userId = await createUser();

    const created = await prisma.userPreference.create({ data: { userId } });
    expect(created.theme).toBe('SYSTEM');
    expect(created.articleFontSize).toBe('DEFAULT');
    expect(created.defaultTranslation).toBe(false);

    // 再插一次会因主键冲突失败
    await expect(prisma.userPreference.create({ data: { userId } })).rejects.toThrow();

    // 正解是 upsert
    const upserted = await prisma.userPreference.upsert({
      where: { userId },
      update: { theme: 'DARK' },
      create: { userId, theme: 'DARK' },
    });
    expect(upserted.theme).toBe('DARK');
  });
});

/* ------------------------------------------------------------------ */

describe('FULLTEXT 对中文真实可用（docs/12）', () => {
  // ⚠ 回归守卫：探针**必须用中文**。
  //
  // 初始迁移建的 FULLTEXT 用 MySQL 默认 parser，中文没有空格，
  // 「基础模型的能力评测」整句会变成一个 token —— AGAINST('模型') 恒返回 0 行。
  // 早期版本的这条用例用纯 ASCII 探针（signalprobeunique）测试，
  // 只证明了拉丁文可用，对中文给出的是**虚假保证**。
  // 修复后（migration 20260923170000_fulltext_ngram）中文子串可正常命中。

  async function createSourceForFulltext(): Promise<bigint> {
    const source = await prisma.source.create({
      data: {
        name: `${TAG} ft source`,
        slug: uniq(),
        type: SourceType.RSS,
        kind: SourceKind.MEDIA,
      },
    });
    return source.id;
  }

  async function matchAgainst(term: string): Promise<Set<string>> {
    const rows = await prisma.$queryRaw<{ id: bigint }[]>`
      SELECT id FROM contents
      WHERE MATCH(title, summary, body_translated) AGAINST (${term} IN NATURAL LANGUAGE MODE)
    `;
    return new Set(rows.map((r) => r.id.toString()));
  }

  it('中文词能命中 title', async () => {
    const sourceId = await createSourceForFulltext();
    const content = await prisma.content.create({
      data: {
        sourceId,
        type: 'ARTICLE',
        title: '模型能力评测',
        language: 'zh',
        originalUrl: `https://example.com/${TAG}/ft-cn-title`,
        pipelineStatus: 'INGESTED',
      },
    });

    expect(await matchAgainst('模型')).toContain(content.id.toString());
  });

  it('中文词能命中 body_translated（Signal 正文是中文译文）', async () => {
    const sourceId = await createSourceForFulltext();
    const content = await prisma.content.create({
      data: {
        sourceId,
        type: 'ARTICLE',
        title: `${TAG} 无关标题`,
        bodyTranslated: '这篇译文讨论推理成本与部署',
        language: 'zh',
        originalUrl: `https://example.com/${TAG}/ft-cn-body`,
        pipelineStatus: 'INGESTED',
      },
    });

    expect(await matchAgainst('推理成本')).toContain(content.id.toString());
  });

  it('中文词能命中 summary', async () => {
    const sourceId = await createSourceForFulltext();
    const content = await prisma.content.create({
      data: {
        sourceId,
        type: 'ARTICLE',
        title: `${TAG} 无关标题`,
        summary: '关于开发者生态的摘要',
        language: 'zh',
        originalUrl: `https://example.com/${TAG}/ft-cn-summary`,
        pipelineStatus: 'INGESTED',
      },
    });

    expect(await matchAgainst('开发者生态')).toContain(content.id.toString());
  });

  it('英文检索在 ngram parser 下仍然可用', async () => {
    const sourceId = await createSourceForFulltext();
    const content = await prisma.content.create({
      data: {
        sourceId,
        type: 'ARTICLE',
        title: 'signalprobeunique latin probe',
        language: 'en',
        originalUrl: `https://example.com/${TAG}/ft-en`,
        pipelineStatus: 'INGESTED',
      },
    });

    expect(await matchAgainst('signalprobeunique')).toContain(content.id.toString());
  });
});

/* ------------------------------------------------------------------ */

describe('数值精度（docs/03）', () => {
  it('六维分数 DECIMAL(4,1) 与 final_score DECIMAL(5,2) 保精度', async () => {
    const source = await prisma.source.create({
      data: {
        name: `${TAG} num source`,
        slug: `${TAG}-num-source`,
        type: SourceType.RSS,
        kind: SourceKind.MEDIA,
        trustScore: 8.7,
      },
    });

    const content = await prisma.content.create({
      data: {
        sourceId: source.id,
        type: 'ARTICLE',
        title: `${TAG} numeric`,
        language: 'zh',
        originalUrl: `https://example.com/${TAG}/num`,
        pipelineStatus: 'INGESTED',
        importanceScore: 9.5,
        finalScore: 87.25,
      },
    });

    const found = await prisma.content.findUniqueOrThrow({ where: { id: content.id } });
    expect(Number(found.importanceScore)).toBeCloseTo(9.5, 1);
    expect(Number(found.finalScore)).toBeCloseTo(87.25, 2);

    const src = await prisma.source.findUniqueOrThrow({ where: { id: source.id } });
    expect(Number(src.trustScore)).toBeCloseTo(8.7, 1);
  });
});
