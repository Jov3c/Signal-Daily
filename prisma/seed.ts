/**
 * Signal — 开发环境 Seed
 *
 * Owner: Agent 01。对应 tasks/agent-01-database.md「Seed」一节。
 *
 * 内容：
 *   - 1 个 ADMIN 用户
 *   - 基础 Topic
 *   - 官方 RSS 示例 Source
 *   - 6 个 X_USER 白名单 Source（docs/00 推荐初始人物）
 *
 * 设计原则：
 *   - **幂等**：全部使用 upsert，可反复执行。
 *   - **不覆盖人工修改**：已存在的记录只补必要字段，不重置管理员的编辑。
 *   - seed 出来的 Source 都在 `config` 里带 `seed: true` 与 `seedNote`，
 *     方便识别哪些是示例数据（docs/00：上线前需再次人工核验账号）。
 *   - 不写入任何 Content / Event / Evidence —— 那些必须由真实采集产生。
 */

import {
  PrismaClient,
  SourceKind,
  SourceTier,
  SourceType,
  UserRole,
  UserStatus,
} from '@prisma/client';

const prisma = new PrismaClient();

/** 开发环境管理员邮箱；可用 SEED_ADMIN_EMAIL 覆盖。 */
const ADMIN_EMAIL = process.env.SEED_ADMIN_EMAIL ?? 'admin@signal.local';

const SEED_FLAG = { seed: true } as const;

const TOPICS = [
  { slug: 'ai-models', name: 'AI 模型', description: '基础模型、能力评测、训练与推理' },
  { slug: 'ai-products', name: 'AI 产品', description: 'AI 原生产品与功能更新' },
  { slug: 'ai-coding', name: 'AI Coding', description: '编码助手、Agent 工程与开发工具链' },
  { slug: 'agents', name: 'Agent', description: '智能体框架、工具调用与自主任务' },
  { slug: 'dev-ecosystem', name: '开发者生态', description: '开源项目、框架与社区动态' },
  { slug: 'big-tech', name: '科技公司', description: '主要科技公司的战略与组织动态' },
  { slug: 'infra', name: '基础设施', description: '算力、芯片、云与推理成本' },
  { slug: 'policy', name: '监管与政策', description: 'AI 治理、合规与行业规范' },
] as const;

/**
 * 官方一手源示例（docs/00：AI / 科技官方 Blog，type=RSS, kind=OFFICIAL, tier=S）。
 *
 * ⚠ 这些是 **演示数据**：feedUrl 必须由管理员在 Source Registry 中人工核验后再正式启用。
 * 每条都带 `seedNote` 标明这一点。
 */
const OFFICIAL_RSS_SOURCES = [
  {
    name: 'Anthropic News',
    slug: 'anthropic-news',
    baseUrl: 'https://www.anthropic.com/news',
    feedUrl: 'https://www.anthropic.com/news/rss.xml',
    language: 'en',
    priority: 95,
    trustScore: 9.5,
  },
  {
    name: 'OpenAI Blog',
    slug: 'openai-blog',
    baseUrl: 'https://openai.com/news',
    feedUrl: 'https://openai.com/news/rss.xml',
    language: 'en',
    priority: 95,
    trustScore: 9.5,
  },
] as const;

/**
 * X 动态白名单（规则 §12：X 动态 = 优质账号白名单，不是用户关注系统）。
 *
 * 人物取自 docs/00「推荐初始人物示例」，v1 预置。
 * 每条的 config 形状与 docs/04 的 Admin Source Registry 示例一致。
 */
const X_WHITELIST_SOURCES = [
  { name: 'Andrej Karpathy', handle: 'karpathy', priority: 90, trustScore: 9.0 },
  { name: 'Simon Willison', handle: 'simonw', priority: 88, trustScore: 9.0 },
  { name: 'François Chollet', handle: 'fchollet', priority: 85, trustScore: 8.5 },
  { name: 'Fei-Fei Li', handle: 'drfeifei', priority: 82, trustScore: 8.5 },
  { name: 'Andrew Ng', handle: 'AndrewYNg', priority: 82, trustScore: 8.5 },
  { name: 'Guillermo Rauch', handle: 'rauchg', priority: 80, trustScore: 8.0 },
] as const;

const SEED_NOTE =
  'seed/demo 数据：账号与 feed URL 需在上线前人工核验，可直接在 Source Registry 修改或停用';

async function seedAdmin(): Promise<void> {
  const admin = await prisma.user.upsert({
    where: { email: ADMIN_EMAIL },
    update: {}, // 已存在则不覆盖管理员自己的设置
    create: {
      email: ADMIN_EMAIL,
      displayName: 'Signal Admin',
      role: UserRole.ADMIN,
      status: UserStatus.ACTIVE,
    },
  });

  // 管理员默认偏好（主题跟随系统、默认字号）
  await prisma.userPreference.upsert({
    where: { userId: admin.id },
    update: {},
    create: { userId: admin.id },
  });

  console.log(`  ✓ ADMIN 用户: ${admin.email} (id=${admin.id})`);
}

async function seedTopics(): Promise<void> {
  for (const topic of TOPICS) {
    await prisma.topic.upsert({
      where: { slug: topic.slug },
      // update 留空：**只补缺失的记录，绝不覆盖管理员的编辑**。
      // （早期版本在这里回写 name/description，会把管理员改过的名称/简介静默打回原值。）
      update: {},
      create: topic,
    });
  }
  console.log(`  ✓ Topic: ${TOPICS.length} 个`);
}

async function seedOfficialSources(): Promise<void> {
  for (const source of OFFICIAL_RSS_SOURCES) {
    const data = {
      name: source.name,
      slug: source.slug,
      type: SourceType.RSS,
      kind: SourceKind.OFFICIAL,
      tier: SourceTier.S,
      official: true,
      baseUrl: source.baseUrl,
      feedUrl: source.feedUrl,
      language: source.language,
      priority: source.priority,
      trustScore: source.trustScore,
      fetchIntervalSeconds: 1800,
      config: { ...SEED_FLAG, seedNote: SEED_NOTE },
    };
    await prisma.source.upsert({
      where: { slug: source.slug },
      // update 留空：已存在的 Source 不覆盖（管理员可能改过 name/kind/tier/official）。
      update: {},
      create: data,
    });
  }
  console.log(`  ✓ 官方 RSS Source: ${OFFICIAL_RSS_SOURCES.length} 个（tier=S, official=true）`);
}

async function seedXWhitelist(): Promise<void> {
  for (const person of X_WHITELIST_SOURCES) {
    const slug = `x-${person.handle.toLowerCase()}`;
    const data = {
      name: person.name,
      slug,
      type: SourceType.X_USER,
      kind: SourceKind.PERSON,
      tier: SourceTier.A,
      official: false,
      baseUrl: `https://x.com/${person.handle}`,
      externalId: person.handle,
      language: 'en',
      priority: person.priority,
      trustScore: person.trustScore,
      fetchIntervalSeconds: 900,
      config: {
        handle: person.handle,
        includeQuotes: true,
        includeReplies: false,
        ...SEED_FLAG,
        seedNote: SEED_NOTE,
      },
    };
    await prisma.source.upsert({
      where: { slug },
      // update 留空：已存在的白名单账号不覆盖（管理员可能已改 tier/kind/停用）。
      update: {},
      create: data,
    });
  }
  console.log(`  ✓ X 白名单 Source: ${X_WHITELIST_SOURCES.length} 个（type=X_USER, kind=PERSON）`);
}

async function main(): Promise<void> {
  console.log('Signal seed 开始…');
  await seedAdmin();
  await seedTopics();
  await seedOfficialSources();
  await seedXWhitelist();
  console.log('Signal seed 完成。');
}

main()
  .catch((error: unknown) => {
    console.error('Signal seed 失败:', error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
