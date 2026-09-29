/**
 * 三组用户能力路由的守卫，外加**全项目「没有订阅」的静态守卫**。
 *
 * ── 这里验什么、不验什么 ────────────────────────────────────────────
 * `AuthGuard` 的**行为**（401、撤权即时生效、token 提取顺序）由 Agent 02 的
 * `auth-guards.spec.ts` 在真 HTTP 上覆盖。本模块只是**应用**它，
 * 所以这里验的是：
 *
 * 1. **它确实被应用了** —— 读控制器元数据，而不是靠「我写了 @UseGuards」；
 * 2. **路由精确等于 `docs/04` 的 User 段** —— 多一条、少一条都要红；
 * 3. **整个项目里没有任何订阅路由 / 订阅表名**（规则 §13）。
 *
 * 第 3 条是任务书点名的必测项。Agent 02 已经有一条「源码里不出现
 * subscription 字样」的守卫，但它只扫 `apps/api/src` —— 本文件把范围
 * 扩到**全仓库**（worker / packages / web 都扫），并且**按路由与表名**判，
 * 比纯文本匹配更接近「不能有订阅能力」这件事的实质。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { BookmarkController } from '../src/modules/bookmarks/controller';
import { ReadingProgressController } from '../src/modules/reading-progress/controller';
import { UserPreferenceController } from '../src/modules/user-preferences/controller';
import { AuthGuard } from '../src/common/guards';

type Controller = new (...args: never[]) => unknown;

/** 「方法 + 路径」清单（按声明顺序）。 */
function routesOf(controller: Controller): string[] {
  const prototype = controller.prototype as Record<string, unknown>;
  const basePath = Reflect.getMetadata(PATH_METADATA, controller) as string | undefined;
  const routes: string[] = [];

  for (const name of Object.getOwnPropertyNames(prototype)) {
    if (name === 'constructor') continue;
    const handler = prototype[name] as object;
    const path = Reflect.getMetadata(PATH_METADATA, handler) as string | undefined;
    const method = Reflect.getMetadata(METHOD_METADATA, handler) as number | undefined;
    if (path === undefined || method === undefined) continue;

    const httpMethod = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'ALL', 'OPTIONS', 'HEAD'][method];
    routes.push(`${httpMethod} /${basePath ?? ''}${path === '/' ? '' : `/${path}`}`);
  }
  return routes;
}

function guardsOf(controller: Controller): unknown[] {
  return (Reflect.getMetadata(GUARDS_METADATA, controller) as unknown[] | undefined) ?? [];
}

/* ------------------------------------------------------------------ */
/* 路由表与守卫                                                        */
/* ------------------------------------------------------------------ */

describe('路由精确等于 docs/04 的 User 段', () => {
  it('收藏三条', () => {
    expect([...routesOf(BookmarkController)].sort()).toEqual([
      'DELETE /bookmarks/:contentId',
      'GET /bookmarks',
      'POST /bookmarks/:contentId',
    ]);
  });

  it('阅读进度一条（只有 PUT —— 读进度由内容详情带回，不做独立接口）', () => {
    expect(routesOf(ReadingProgressController)).toEqual(['PUT /reading-progress']);
  });

  it('偏好两条', () => {
    expect([...routesOf(UserPreferenceController)].sort()).toEqual([
      'GET /me/preferences',
      'PUT /me/preferences',
    ]);
  });

  it('三组能力合起来就是 docs/04 的 User 段（一条不多、一条不少）', () => {
    const all = [
      ...routesOf(BookmarkController),
      ...routesOf(ReadingProgressController),
      ...routesOf(UserPreferenceController),
    ].sort();

    expect(all).toEqual([
      'DELETE /bookmarks/:contentId',
      'GET /bookmarks',
      'GET /me/preferences',
      'POST /bookmarks/:contentId',
      'PUT /me/preferences',
      'PUT /reading-progress',
    ]);
  });
});

describe('鉴权：匿名必须被拒（docs/11：这些是登录用户的能力）', () => {
  it('三个控制器都套了 `AuthGuard`（控制器层，不是方法层）', () => {
    for (const controller of [
      BookmarkController,
      ReadingProgressController,
      UserPreferenceController,
    ]) {
      expect(guardsOf(controller), controller.name).toContain(AuthGuard);
    }
  });

  it('守卫在**控制器**上而不是逐方法 —— 后者漏一个方法就是一个洞', () => {
    // `@UseGuards` 挂在类上时元数据在类上；挂在方法上时在方法上。
    // 这条断言的是「类上有」，因此新增方法天然被覆盖。
    for (const controller of [
      BookmarkController,
      ReadingProgressController,
      UserPreferenceController,
    ]) {
      expect(Reflect.getMetadata(GUARDS_METADATA, controller), controller.name).toBeDefined();
    }
  });
});

/* ------------------------------------------------------------------ */
/* 全项目：没有订阅                                                    */
/* ------------------------------------------------------------------ */

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

/** 要扫描的源码目录（**全仓库**，不只是 apps/api）。 */
const SCAN_DIRS = [
  'apps/api/src',
  'apps/worker/src',
  'apps/web/app',
  'packages/contracts/src',
  'packages/config/src',
  'packages/logger/src',
  'packages/source-core/src',
];

function walk(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full));
      continue;
    }
    if (/\.(ts|tsx|mts)$/.test(entry)) out.push(full);
  }
  return out;
}

/** 规则 §13 明确禁止的表名。 */
const FORBIDDEN_TABLES = ['person_subscriptions', 'topic_subscriptions', 'source_subscriptions'];

/** `source_subscriptions` → `sourceSubscription`（Prisma 客户端的属性名）。 */
function camelOf(table: string): string {
  return table.replace(/_(\w)/g, (_match, char: string) => char.toUpperCase());
}

/**
 * 一张被禁的表**真正违规**的三种形态。
 *
 * ⚠ 刻意不是「字符串出现过」：schema 顶部就有一行
 * 「V1 不存在任何订阅表（person/topic/source_subscriptions 一律禁止）」——
 * 按字符串匹配会把这句**禁令**当成**违规**（第一版就是这么错的）。
 * 假阳性比漏判更危险：它会让下一个人直接把这条守卫删掉。
 */
function forbiddenTablePatterns(table: string): RegExp[] {
  return [
    // 1. Prisma 模型定义：`model source_subscriptions {`
    new RegExp(`model\\s+${table}\\b`),
    // 2. 显式表名映射：`@@map("source_subscriptions")`
    new RegExp(`@@map\\(\\s*["'\`]${table}["'\`]`),
    // 3. 客户端读写：`prisma.sourceSubscription.findMany()`
    new RegExp(`\\.${camelOf(table)}\\b`),
  ];
}

describe('⚠ 全项目：不存在任何订阅能力（规则 §13）', () => {
  it('没有任何 `@Controller` 声明订阅路由', () => {
    const offenders: string[] = [];
    // 用**字符串拼接**构造被禁词：这个文件本身就在扫描范围之外的 test/ 目录，
    // 但拼接能让守卫在将来被移到 src/ 时也不会自己命中自己。
    const word = ['sub', 'scription'].join('');

    for (const dir of SCAN_DIRS) {
      for (const file of walk(join(REPO_ROOT, dir))) {
        const code = readFileSync(file, 'utf8');
        for (const match of code.matchAll(/@Controller\(\s*['"`]([^'"`]*)['"`]/g)) {
          if (new RegExp(word, 'i').test(match[1] as string)) {
            offenders.push(`${file.replace(REPO_ROOT, '')}: @Controller('${match[1] as string}')`);
          }
        }
      }
    }

    expect(offenders, '规则 §13 禁止任何订阅路由').toEqual([]);
  });

  it('三张被禁的表**没有被定义，也没有被读写**', () => {
    // ⚠ 判据要精确到「实际定义 / 实际使用」，**不是**「字符串出现过」。
    // 第一版写成 `code.includes(table)` 时，它立刻报了
    // `prisma/schema.prisma: source_subscriptions` —— 而那其实是
    // schema 顶部的一行**禁止性注释**：
    //
    //     //   - V1 不存在任何订阅表（person/topic/source_subscriptions 一律禁止）。
    //
    // 也就是说，一句「不许建这三张表」的声明被守卫当成了「建了这三张表」。
    // 这类**假阳性**会让守卫被绕过（下一个人直接把这条测试删掉），
    // 所以它必须只抓真正违规的三种形态：
    //
    //   1. Prisma 模型定义   `model source_subscriptions {`
    //   2. 显式表名映射      `@@map("source_subscriptions")`
    //   3. 客户端读写        `prisma.sourceSubscription` / `tx.personSubscription`
    //
    // 第 3 条用 **camelCase**（Prisma 的客户端属性名）：模型叫
    // `source_subscriptions`，而代码里访问它时是 `sourceSubscription`。
    const offenders: string[] = [];
    const files = [
      ...SCAN_DIRS.flatMap((dir) => walk(join(REPO_ROOT, dir))),
      join(REPO_ROOT, 'prisma/schema.prisma'),
    ];

    for (const file of files) {
      let code: string;
      try {
        code = readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      for (const table of FORBIDDEN_TABLES) {
        for (const pattern of forbiddenTablePatterns(table)) {
          if (pattern.test(code)) {
            offenders.push(`${file.replace(REPO_ROOT, '')}: ${table} (${pattern.source})`);
          }
        }
      }
    }

    expect(offenders, '规则 §13 禁止这三张表被定义或读写').toEqual([]);
  });

  it('**有牙齿**：合成样本必须被命中（否则上面两条是空跑）', () => {
    const word = ['sub', 'scription'].join('');
    const pattern = /@Controller\(\s*['"`]([^'"`]*)['"`]/g;

    const synthetic = `@Controller('${word}s')`;
    const hits = [...synthetic.matchAll(pattern)].filter((match) =>
      new RegExp(word, 'i').test(match[1] as string),
    );
    expect(hits).toHaveLength(1);

    // 反向：正常的路由不该被命中
    const normal = [...`@Controller('bookmarks')`.matchAll(pattern)].filter((match) =>
      new RegExp(word, 'i').test(match[1] as string),
    );
    expect(normal).toHaveLength(0);

    // 表名检查也要有牙齿：三种真正违规的形态都要命中，
    // 而那句「一律禁止」的**注释不能**命中。
    const table = FORBIDDEN_TABLES[0] as string;
    const camel = camelOf(table);
    const [modelPattern, mapPattern, clientPattern] = forbiddenTablePatterns(table);

    expect(modelPattern?.test(`model ${table} {`)).toBe(true);
    expect(mapPattern?.test(`@@map("${table}")`)).toBe(true);
    expect(clientPattern?.test(`await prisma.${camel}.findMany()`)).toBe(true);

    // 反向：禁止性注释不该被命中（第一版正是错在这里）
    expect(modelPattern?.test(`// V1 不存在任何订阅表（${table} 一律禁止）`)).toBe(false);
    expect(clientPattern?.test('await prisma.content.findMany()')).toBe(false);
  });

  it('扫描范围真的覆盖到了源码（目录改名/移动会让这条红）', () => {
    const total = SCAN_DIRS.flatMap((dir) => walk(join(REPO_ROOT, dir))).length;
    expect(total, '应当扫到大量源码文件').toBeGreaterThan(50);
  });
});
