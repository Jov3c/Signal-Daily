/**
 * Worker 侧 DI 守卫 —— **补 `ai` 与 `content` 这两个当时没有守卫的模块**。
 *
 * ── 为什么会有这个文件 ──────────────────────────────────────────────
 * 仓库里本来有 5 份 DI 守卫，但**全是按模块划范围的**：
 *
 * ```text
 * apps/api/test/di-wiring.spec.ts
 * apps/api/test/publishing-di-wiring.spec.ts
 * apps/api/test/user-features-di-wiring.spec.ts
 * apps/worker/test/collectors-di-wiring.spec.ts
 * apps/worker/test/publishing-di-wiring.spec.ts
 * ```
 *
 * **`jobs/ai` 与 `jobs/content` 不在其中任何一份里。** 于是 2026-10-01 实测到：
 *
 * ```text
 *   {"level":"error","message":"PERMANENT: Cannot read properties of undefined
 *                               (reading 'aiRun')"}
 * ```
 *
 * `ai/prisma-ai-run.repository.ts` 里 `PrismaAiRepository.this.prisma` 是
 * `undefined` —— 类上没有 `@Injectable()`，参数是
 * `constructor(private readonly prisma: PrismaClient)` 且 `PrismaClient` 是
 * `import type` 进来的（运行期被整句擦除）。AI 每一步都炸，而且 BullMQ 判成
 * **PERMANENT（不可重试）**：AI 评分 / 翻译**完全不可用**，即使配了 API key
 * （炸在解析依赖这一层，还没走到调用模型）。
 *
 * ⚠ **最值得记的一点**：`collectors-di-wiring.spec.ts` 的注释里当年明确写过
 * 这段代码「`compile()` 能通过 —— 也就是说那不是缺陷」。那个结论是**错的**：
 * `compile()` 只建依赖图，不实例化 provider，而这类 bug 只在实例化时现形。
 * 用一个覆盖不到目标的检查去宣布目标没问题，得到的是假阴性。
 *（那段注释已就地更正。）
 *
 * ── ⚠ 判据：只盯「Nest 会替我们实例化」的类 ──────────────────────────
 * 前几份守卫用的是「扫这个模块下所有类的构造参数」。**那个判据在本模块会误报**，
 * 实测踩到两类：
 *
 * ```text
 * 1. Nest **模块类**（AiWorkerModule / ContentPipelineModule）
 *    —— 它们有 @Module() 装饰器，元数据正常发射，依赖由 Nest 注入，本来就不需要 @Inject。
 * 2. 在 useFactory 里**手工 new 出来**的类（BullContentEnqueuer）
 *    —— Nest 从不解析它的构造参数，写不写 @Inject 都一样。
 * ```
 *
 * 所以这里换成**精确判据**：只有被 `useClass` 注册的类，Nest 才会去解析它的
 * 构造参数元数据 —— **那才是会炸的那一类**。误报会被排掉，真问题一个不漏。
 *
 * ── 为什么是两份分开的文件而不是把 collectors 那份扩大范围 ────────────
 * 这个仓库的约定是 per-module 自带一份。真正缺的不是范围，是
 * 「**新模块必须自带一份**」。
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const WORKER_SRC = fileURLToPath(new URL('../src', import.meta.url));
/** 本文件负责的两个模块 —— 与那些已有守卫的文件**不重叠**。 */
const COVERED = ['jobs/ai', 'jobs/content'].map((part) => join(WORKER_SRC, part));

/* ------------------------------------------------------------------ */
/* 辅助                                                                */
/* ------------------------------------------------------------------ */

function collectFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      collectFiles(full, found);
    } else if (/\.ts$/.test(entry.name)) {
      found.push(full);
    }
  }
  return found;
}

/** 去掉块注释与行注释，避免注释里的示例代码造成误报。 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

/** 按顶层逗号切分 —— 泛型里的逗号（`Map<string, number>`）不算分隔。 */
function splitTopLevel(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of list) {
    if (char === '(' || char === '<' || char === '{' || char === '[') depth += 1;
    if (char === ')' || char === '>' || char === '}' || char === ']') depth -= 1;
    if (char === ',' && depth === 0) {
      out.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  if (current.trim() !== '') out.push(current);
  return out.filter((part) => part.trim() !== '');
}

/**
 * 取 `class <name>` 之后那个 `constructor(...)` 的顶层参数。
 * 找不到该类或它没有构造函数时返回 `null`（用来区分「没有」与「空参数」）。
 */
function constructorParamsOf(source: string, className: string): string[] | null {
  const classAt = source.search(new RegExp(`\\bclass\\s+${className}\\b`));
  if (classAt === -1) return null;
  const start = source.indexOf('constructor(', classAt);
  if (start === -1) return null;

  let depth = 0;
  let index = start + 'constructor'.length;
  for (; index < source.length; index += 1) {
    if (source[index] === '(') depth += 1;
    else if (source[index] === ')') {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  return splitTopLevel(source.slice(start + 'constructor('.length, index));
}

/** 类 / 接口形态的类型名（首字母大写）。 */
const CLASS_LIKE = /^[A-Z][A-Za-z0-9_]*$/;

type Source = { path: string; code: string; original: string };

function moduleSources(moduleDir: string): Source[] {
  return collectFiles(moduleDir).map((path) => {
    const original = readFileSync(path, 'utf8');
    return {
      path: path.replace(WORKER_SRC, 'src').replace(/\\/g, '/'),
      code: stripComments(original),
      original,
    };
  });
}

const FILES = COVERED.flatMap((dir) => moduleSources(dir));

/**
 * ⚠ **判据的核心**：Nest 只对 `useClass` 注册的类解析构造参数元数据。
 * 所以只挑这些类来查 —— 这是「会炸的那一类」的精确定义。
 */
function useClassNames(): string[] {
  const names = new Set<string>();
  for (const file of FILES) {
    for (const match of file.code.matchAll(/useClass:\s*([A-Z][A-Za-z0-9_]*)/g)) {
      if (match[1] !== undefined) names.add(match[1]);
    }
  }
  return [...names].sort();
}

/* ------------------------------------------------------------------ */

describe('ai / content：useClass 注册的类必须显式声明 @Inject', () => {
  it('扫描到了源码（防止空跑 —— 目录被挪走时这条会先红）', () => {
    expect(FILES.length).toBeGreaterThan(30);
  });

  it('确实扫到了 useClass 注册（防止判据本身空转）', () => {
    // 数量掉到 0 通常意味着 `useClass:` 被换成了别的写法，而这条守卫会静默失效。
    expect(useClassNames().length).toBeGreaterThan(3);
  });

  it('每个 useClass 类的「类类型」构造参数都带 @Inject(...)', () => {
    const offenders: string[] = [];

    for (const name of useClassNames()) {
      for (const file of FILES) {
        const params = constructorParamsOf(file.code, name);
        if (params === null) continue;

        for (const parameter of params) {
          if (parameter.includes('@Inject(')) continue;
          const colon = parameter.lastIndexOf(':');
          if (colon === -1) continue;
          const type = parameter
            .slice(colon + 1)
            .replace(/^\s*(private|public|protected|readonly|\s)+/g, '')
            .replace(/\s*=[\s\S]*$/, '')
            .trim();
          if (!CLASS_LIKE.test(type)) continue;
          offenders.push(`${file.path} [${name}]: ${parameter.replace(/\s+/g, ' ').trim()}`);
        }
        break; // 一个类只在一个文件里定义
      }
    }

    expect(
      offenders,
      '被 `useClass` 注册的类，其构造参数必须写显式 `@Inject(...)`：' +
        '这类类由 Nest 实例化并按 `design:paramtypes` 解析依赖，而 ' +
        '`import type` / 缺 `@Injectable()` 会让元数据退化 → 运行期该字段是 ' +
        '`undefined`。**这类 bug 在单测与 compile() 里都看不见，只在实例化时炸** —— ' +
        '`ai/prisma-ai-run.repository.ts` 就是这么让 AI 完全不可用的。',
    ).toEqual([]);
  });

  /**
   * ⚠ **点名断言这次事故的现场。**
   *
   * 上面那条是通用判据；这一条是**回归墓碑** —— 直接盯着那两个类，
   * 将来谁把 `@Inject` 去掉（或被 `consistent-type-imports` 顺手改成
   * `import type`），这里一定红。`ai` 那个是 2026-10-01 真实炸过的。
   */
  it('三个 Prisma 仓储都显式 @Inject 了各自的 PrismaService', () => {
    const targets: { file: string; token: string }[] = [
      { file: 'src/jobs/ai/prisma-ai-run.repository.ts', token: 'WorkerPrismaService' },
      { file: 'src/jobs/ai/prisma-job-run.repository.ts', token: 'WorkerPrismaService' },
      { file: 'src/jobs/content/prisma-content.repository.ts', token: 'ContentPrismaService' },
    ];

    for (const { file, token } of targets) {
      // ⚠ 用**去注释**的 `code`，不是 `original`：那几条反面断言
      //（「不应再有裸的 `: PrismaClient` 构造参数」）会被**注释里引用的旧写法**
      // 匹配到 —— 而修 bug 时把旧写法抄进注释说明「原来错在哪」正是本仓库的习惯。
      // 第一次写这条时就踩了：注释里的示例让守卫自己报红。
      const source = FILES.find((entry) => entry.path === file)?.code ?? '';
      expect(source, `${file} 没被扫到 —— 路径可能变了`).not.toBe('');
      expect(source, `${file} 应当显式 @Inject(${token})`).toContain(`@Inject(${token})`);
      // 反面：不能还留着裸的 `: PrismaClient` 形参。
      expect(source, `${file} 不应再有裸的 PrismaClient 构造参数`).not.toMatch(
        /constructor\([^)]*:\s*PrismaClient\s*\)/,
      );
    }
  });
});
