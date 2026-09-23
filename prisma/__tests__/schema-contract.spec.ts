import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as contracts from '@signal/contracts';

/**
 * Prisma Schema 契约测试 —— **不需要数据库**。
 *
 * 守护三件事：
 *   1. schema 里不存在任何订阅表（规则 §13，V1 已彻底取消订阅模块）
 *   2. schema 的枚举与 @signal/contracts 逐字一致（docs/05 是唯一来源）
 *   3. docs/03 / docs/12 要求的关键索引与 FULLTEXT 确实存在
 */

const SCHEMA_PATH = fileURLToPath(new URL('../schema.prisma', import.meta.url));
const SCHEMA_SOURCE = readFileSync(SCHEMA_PATH, 'utf8');

/** 去掉注释，避免注释里的字样干扰断言。 */
const SCHEMA = SCHEMA_SOURCE.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

function parseEnums(source: string): Map<string, string[]> {
  const enums = new Map<string, string[]>();
  const re = /^enum\s+(\w+)\s*\{([^}]*)\}/gm;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    const name = match[1] as string;
    const values = (match[2] ?? '')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('@@'));
    enums.set(name, values);
  }
  return enums;
}

function parseModelBodies(source: string): Map<string, string> {
  const models = new Map<string, string>();
  const re = /^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    models.set(match[1] as string, match[2] ?? '');
  }
  return models;
}

const PRISMA_ENUMS = parseEnums(SCHEMA);
const PRISMA_MODELS = parseModelBodies(SCHEMA);

/* ------------------------------------------------------------------ */
/* 1. 订阅模块必须彻底不存在                                            */
/* ------------------------------------------------------------------ */

describe('V1 不存在任何订阅能力（规则 §13 / docs/03「已删除」）', () => {
  const FORBIDDEN = [
    'person_subscriptions',
    'topic_subscriptions',
    'source_subscriptions',
    'PersonSubscription',
    'TopicSubscription',
    'SourceSubscription',
    'Subscription',
  ];

  it.each(FORBIDDEN)('schema 中不出现 %s', (token) => {
    expect(SCHEMA).not.toContain(token);
  });

  it('没有任何以 subscription 命名的 model 或表映射', () => {
    for (const [name, body] of PRISMA_MODELS) {
      expect(name.toLowerCase()).not.toContain('subscription');
      expect(body.toLowerCase()).not.toContain('@@map("subscription');
    }
  });

  it('没有用户订阅关系字段（User 上不应出现 subscriptions 关联）', () => {
    const user = PRISMA_MODELS.get('User');
    expect(user).toBeDefined();
    expect(user).not.toMatch(/subscription/i);
  });
});

/* ------------------------------------------------------------------ */
/* 2. 枚举与 @signal/contracts 逐字一致                                */
/* ------------------------------------------------------------------ */

describe('Prisma 枚举与 @signal/contracts 一致（docs/05 是唯一来源）', () => {
  const SHARED_ENUM_NAMES = [
    'UserRole',
    'UserStatus',
    'UserTheme',
    'ArticleFontSize',
    'SourceType',
    'SourceKind',
    'SourceTier',
    'EvidenceType',
    'ContentType',
    'RawItemStatus',
    'ContentPipelineStatus',
    'EditorialReviewStatus',
    'DailyEditionStatus',
    'DailySectionType',
    'DailyDisplayStyle',
    'AiTaskType',
    'AiRunStatus',
    'JobRunStatus',
  ] as const;

  it.each(SHARED_ENUM_NAMES)('%s 在两边取值完全相同', (name) => {
    const prismaValues = PRISMA_ENUMS.get(name);
    expect(prismaValues, `Prisma schema 缺少枚举 ${name}`).toBeDefined();

    const contractEnum = (contracts as Record<string, unknown>)[name] as
      Record<string, string> | undefined;
    expect(contractEnum, `@signal/contracts 缺少枚举 ${name}`).toBeDefined();

    const contractValues = Object.values(contractEnum ?? {});
    expect([...(prismaValues ?? [])].sort()).toEqual([...contractValues].sort());
  });

  it('schema 中定义的枚举没有多余的（防止私加未登记枚举）', () => {
    const defined = [...PRISMA_ENUMS.keys()].sort();
    expect(defined).toEqual([...SHARED_ENUM_NAMES].sort());
  });
});

/* ------------------------------------------------------------------ */
/* 3. 表 / 模型完整性                                                   */
/* ------------------------------------------------------------------ */

describe('模型与表映射（docs/03）', () => {
  const EXPECTED_MODELS = [
    'User',
    'AuthAccount',
    'EmailOtpCode',
    'Session',
    'UserPreference',
    'Source',
    'Person',
    'Topic',
    'RawItem',
    'Event',
    'EventEvidence',
    'Content',
    'ContentTopic',
    'EventContent',
    'EditorialReview',
    'FeaturedItem',
    'DailyEdition',
    'DailySection',
    'DailyItem',
    'Bookmark',
    'ReadingProgress',
    'AiRun',
    'JobRun',
    'AdminNotification',
  ];

  it('包含全部 24 个模型', () => {
    expect([...PRISMA_MODELS.keys()].sort()).toEqual([...EXPECTED_MODELS].sort());
  });

  it('每个模型都映射到 snake_case 表名', () => {
    for (const [name, body] of PRISMA_MODELS) {
      expect(body, `${name} 缺少 @@map`).toMatch(/@@map\("/);
    }
  });

  it('event_contents 与 event_evidence 是两张独立的表（docs/03 明确不要合并）', () => {
    expect(PRISMA_MODELS.has('EventContent')).toBe(true);
    expect(PRISMA_MODELS.has('EventEvidence')).toBe(true);
    expect(PRISMA_MODELS.get('EventContent')).toContain('@@map("event_contents")');
    expect(PRISMA_MODELS.get('EventEvidence')).toContain('@@map("event_evidence")');
  });

  it('EventEvidence 上存在 (event_id, url_hash) 唯一约束', () => {
    const body = PRISMA_MODELS.get('EventEvidence');
    expect(body).toContain('urlHash');
    expect(body).toMatch(/@@unique\(\[eventId,\s*urlHash\]\)/);
  });

  it('Source 具备 type / kind / tier / official 四个维度', () => {
    const body = PRISMA_MODELS.get('Source') as string;
    expect(body).toMatch(/^\s*type\s+SourceType/m);
    expect(body).toMatch(/^\s*kind\s+SourceKind/m);
    expect(body).toMatch(/^\s*tier\s+SourceTier/m);
    expect(body).toMatch(/^\s*official\s+Boolean/m);
  });

  it('Content 同时保留 bodyOriginal 与 bodyTranslated（翻译不得覆盖原文）', () => {
    const body = PRISMA_MODELS.get('Content') as string;
    expect(body).toContain('bodyOriginal');
    expect(body).toContain('bodyTranslated');
    expect(body).toMatch(/body_original/);
    expect(body).toMatch(/body_translated/);
  });

  it('Bookmark 使用 (user_id, content_id) 复合主键', () => {
    expect(PRISMA_MODELS.get('Bookmark')).toMatch(/@@id\(\[userId,\s*contentId\]\)/);
  });

  it('ReadingProgress 使用 (user_id, resource_type, resource_id) 复合主键', () => {
    expect(PRISMA_MODELS.get('ReadingProgress')).toMatch(
      /@@id\(\[userId,\s*resourceType,\s*resourceId\]\)/,
    );
  });

  it('UserPreference 主键就是 user_id（1:1）', () => {
    const body = PRISMA_MODELS.get('UserPreference') as string;
    expect(body).toMatch(/userId\s+BigInt\s+@id/);
  });
});

/* ------------------------------------------------------------------ */
/* 4. 索引与 FULLTEXT（docs/03 / docs/12）                             */
/* ------------------------------------------------------------------ */

describe('关键索引（docs/03）', () => {
  it('sources 有 (enabled, nextFetchAt) 索引 —— 调度取 due source 用', () => {
    expect(PRISMA_MODELS.get('Source')).toContain('@@index([enabled, nextFetchAt])');
  });

  it('sources 有 (type, enabled) 与 (kind, tier, enabled) 索引', () => {
    const body = PRISMA_MODELS.get('Source') as string;
    expect(body).toContain('@@index([type, enabled])');
    expect(body).toContain('@@index([kind, tier, enabled])');
  });

  it('event_evidence 有 (eventId, isPrimary) 索引 —— 找 Primary Evidence 用', () => {
    expect(PRISMA_MODELS.get('EventEvidence')).toContain('@@index([eventId, isPrimary])');
  });

  it('event_evidence 有 (sourceId, publishedAt) 索引 —— 算独立来源数用', () => {
    expect(PRISMA_MODELS.get('EventEvidence')).toContain('@@index([sourceId, publishedAt])');
  });
});

describe('FULLTEXT（docs/12：title / summary / bodyTranslated）', () => {
  it('contents 上声明了覆盖三列的 @@fulltext', () => {
    const body = PRISMA_MODELS.get('Content') as string;
    expect(body).toMatch(/@@fulltext\(\[title,\s*summary,\s*bodyTranslated\]\)/);
  });

  it('初始 migration 里生成了对应的 FULLTEXT 索引', () => {
    const migration = readFileSync(
      fileURLToPath(new URL('../migrations/20260923160000_init/migration.sql', import.meta.url)),
      'utf8',
    );
    expect(migration).toContain('FULLTEXT INDEX');
    expect(migration).toMatch(/FULLTEXT INDEX[^\n]*`title`[^\n]*`summary`[^\n]*`body_translated`/);
  });
});

/* ------------------------------------------------------------------ */
/* 5. 主键与数据源                                                      */
/* ------------------------------------------------------------------ */

describe('主键与数据源（docs/02 / docs/20）', () => {
  const AUTOINCREMENT_MODELS = [
    'User',
    'Source',
    'Content',
    'Event',
    'EventEvidence',
    'RawItem',
    'Topic',
    'Person',
    'DailyEdition',
    'DailySection',
    'DailyItem',
    'FeaturedItem',
    'EditorialReview',
    'AiRun',
    'JobRun',
    'AdminNotification',
    'AuthAccount',
    'EmailOtpCode',
    'Session',
  ];

  it.each(AUTOINCREMENT_MODELS)('%s 使用 BIGINT UNSIGNED 自增主键', (name) => {
    const body = PRISMA_MODELS.get(name) as string;
    expect(body).toMatch(/@id\s+@default\(autoincrement\(\)\)\s+@db\.UnsignedBigInt/);
  });

  it('datasource 使用 env("DATABASE_URL")，provider 为 mysql', () => {
    expect(SCHEMA).toMatch(/provider\s*=\s*"mysql"/);
    expect(SCHEMA).toMatch(/url\s*=\s*env\("DATABASE_URL"\)/);
  });
});
