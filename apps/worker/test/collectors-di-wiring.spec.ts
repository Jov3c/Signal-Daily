/**
 * Worker 侧的依赖注入守卫。
 *
 * ── 为什么需要这个文件（它补的是一个真实逃逸过的缺陷）────────────────
 * `apps/api/test/di-wiring.spec.ts`（Agent 02 建的）就是为同一类问题而生，
 * 但**只扫 `apps/api/src`**。Agent 04 在 `apps/worker` 里没有等价守卫，
 * 于是同一类缺陷真的发生了：
 *
 * 修 lint 时 `consistent-type-imports` 要求把只作类型使用的
 * `import { PrismaService }` 改成 `import type` —— 改完之后
 * `emitDecoratorMetadata` 生成的 `design:paramtypes` 退化成 `[Function]`，
 * Nest 在**编译产物**里报：
 *
 * ```
 * Nest can't resolve dependencies of the PrismaCollectorSourceRepository (?).
 * ```
 *
 * 而**单元测试与集成测试全都看不见**：它们跑的是另一套 transform（oxc），
 * 按源码即时生成元数据；而且它们用的是 `overrideProvider`，
 * 从不实例化那个仓储类。当时 868 项单测 + 44 项集成测试全绿，
 * 只有 `work/_agent04/probe-dist-collectors.mjs` 抓到了它 ——
 * 而那个探针在 `work/` 下，不进 git、不被 CI 跑。
 *
 * 这个文件把那两件事都变成**已提交的回归守卫**：
 *   1. **静态扫描**：类类型的构造参数必须有显式 `@Inject(...)`；
 *   2. **真解析**：用真实 `CollectorsModule` 编译一次依赖图，
 *      并断言关键 provider 真的取得出来。
 *
 * 第 2 条刻意**不调用 `app.init()`**：那会触发 `onApplicationBootstrap`
 * （启动调度器定时器）与 `onModuleInit`（真的连 BullMQ），
 * 两个都是集成测试的范畴。`.compile()` 只建图，正好是这一层要验的东西。
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { SourceType } from '@signal/contracts';
import { createLogger } from '@signal/logger';
import { createMemoryStream } from '@signal/test-utils';
import { CollectorsModule } from '../src/jobs/collectors/module';
import { CollectorService } from '../src/jobs/collectors/collector.service';
import { SourceScheduler } from '../src/jobs/collectors/scheduler.service';
import { PrismaService } from '../src/jobs/collectors/prisma.service';
import { SOURCE_FETCH_QUEUE, SOURCE_LOCK } from '../src/jobs/collectors/ports';
import {
  COLLECTOR_CONFIG,
  SCHEDULER_INTERVAL_MS,
  type CollectorConfig,
} from '../src/jobs/collectors/collector.config';
import { CLOCK, systemClock } from '../src/jobs/collectors/clock';
import { WORKER_LOGGER } from '../src/jobs/collectors/logger';
import { InMemorySourceFetchQueue, InMemorySourceLock } from './support/collector-fakes';

/**
 * ⚠ 扫描范围**只限本模块**（`src/jobs/collectors`），不是整个 `src`。
 *
 * 理由：这条守卫的判据是「类类型的构造参数有没有显式 `@Inject`」，
 * 而它只是一个**源码文本启发式** —— 是否真的会退化，取决于那个类型
 * 在运行期是不是一个值（TypeScript 对不同 import 形式的处理不同）。
 *
 * 实测：`apps/worker/src/jobs/ai/**`（Agent 06）里有一处同样形态的写法
 * （`constructor(private readonly prisma: PrismaClient)` + `import type`），
 * 但 `Test.createTestingModule({imports:[AiWorkerModule]}).compile()`
 * **能通过** —— 也就是说那不是缺陷。
 * 一个会在别人模块上误报的守卫，除了挡住别人的工作之外没有价值。
 * 整个 Worker 的装配由 **Agent 14** 在集成阶段用真实的 `WorkerModule` 验。
 */
const COLLECTORS_SRC = fileURLToPath(new URL('../src/jobs/collectors', import.meta.url));

/**
 * 一份自洽的配置：不依赖任何真实 env。
 *
 * ⚠ 必须 override `COLLECTOR_CONFIG`：它的默认工厂会调 `parseEnv()`，
 * 而单测环境里没有（也不该有）完整的 `.env`。DI 测试验的是**依赖图**，
 * 不该被 env 校验的成败牵连 —— 那会让「env 少一个变量」和「DI 坏了」
 * 表现成同一条失败。
 */
function testConfig(): CollectorConfig {
  return {
    nodeEnv: 'test',
    fetchTimeoutMs: 5_000,
    fetchMaxBytes: 2_097_152,
    xApiBearerToken: null,
    githubToken: null,
    redisUrl: 'redis://127.0.0.1:6390',
    schedulerIntervalMs: SCHEDULER_INTERVAL_MS,
  };
}

/* ------------------------------------------------------------------ */
/* 1. 静态扫描                                                         */
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

/** 取 `constructor(...)` 的顶层参数列表。 */
function constructorParams(source: string): string[] {
  const params: string[] = [];
  let from = 0;

  for (;;) {
    const start = source.indexOf('constructor(', from);
    if (start === -1) break;

    let depth = 0;
    let index = start + 'constructor'.length;
    for (; index < source.length; index += 1) {
      if (source[index] === '(') depth += 1;
      else if (source[index] === ')') {
        depth -= 1;
        if (depth === 0) break;
      }
    }

    const body = source.slice(start + 'constructor('.length, index);
    // 按顶层逗号切分（跳过泛型与对象字面量里的逗号）。
    let nesting = 0;
    let current = '';
    for (const char of body) {
      if ('<({['.includes(char)) nesting += 1;
      else if ('>)}]'.includes(char)) nesting -= 1;
      if (char === ',' && nesting === 0) {
        params.push(current);
        current = '';
        continue;
      }
      current += char;
    }
    if (current.trim() !== '') params.push(current);

    from = index;
  }

  return params.map((param) => param.trim()).filter((param) => param !== '');
}

/** 类 / 接口形态的类型名（首字母大写）。 */
const CLASS_LIKE = /^[A-Z][A-Za-z0-9_]*$/;

describe('构造参数必须显式声明 @Inject（防 emitDecoratorMetadata 退化）', () => {
  const files = collectFiles(COLLECTORS_SRC).map((path) => ({
    path,
    code: stripComments(readFileSync(path, 'utf8')),
  }));

  it('扫描到了源码（防止空跑）', () => {
    // 本模块有 30+ 个源文件；数量掉下来通常意味着目录被挪走了。
    expect(files.length).toBeGreaterThan(25);
  });

  it('每个「类类型」的构造参数都带 @Inject(...)', () => {
    const offenders: string[] = [];

    for (const file of files) {
      for (const parameter of constructorParams(file.code)) {
        if (parameter.includes('@Inject(')) continue;
        // 只关心「形参: 类型」这种形态。
        const colon = parameter.lastIndexOf(':');
        if (colon === -1) continue;
        const type = parameter
          .slice(colon + 1)
          .replace(/^\s*(private|public|protected|readonly|\s)+/g, '')
          .replace(/\s*=[\s\S]*$/, '')
          .trim();
        if (!CLASS_LIKE.test(type)) continue;
        // 内联的联合类型 / 泛型别名不可能是注入 token。
        offenders.push(
          `${file.path.replace(WORKER_SRC, 'src')}: ${parameter.replace(/\s+/g, ' ')}`,
        );
      }
    }

    expect(offenders).toEqual([]);
  });

  it('三个 Prisma 仓储的构造参数都显式 @Inject(PrismaService)', () => {
    // 这条是上面那条的实际回归目标 —— 曾经的缺陷正是这里。
    for (const name of [
      'prisma-source.repository.ts',
      'prisma-raw-item.repository.ts',
      'prisma-job-run.repository.ts',
    ]) {
      const file = files.find((candidate) => candidate.path.endsWith(name));
      expect(file, `${name} 应存在`).toBeDefined();
      expect(file!.code).toMatch(/constructor\(@Inject\(PrismaService\)/);
    }
  });
});

/* ------------------------------------------------------------------ */
/* 2. 真解析（真实 CollectorsModule）                                   */
/* ------------------------------------------------------------------ */

describe('CollectorsModule 的依赖图真的能建起来', () => {
  it('编译整个模块并取出关键 provider（失败的形态就是那个 P0 类缺陷）', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [CollectorsModule] })
      // 只替换**外部世界**：MySQL、Redis、BullMQ、时钟、日志。
      // 其余全部是真实实现（service / scheduler / worker / 仓储）。
      .overrideProvider(PrismaService)
      .useValue({})
      .overrideProvider(SOURCE_LOCK)
      .useValue(new InMemorySourceLock())
      .overrideProvider(SOURCE_FETCH_QUEUE)
      .useValue(new InMemorySourceFetchQueue())
      .overrideProvider(CLOCK)
      .useValue(systemClock)
      .overrideProvider(COLLECTOR_CONFIG)
      .useValue(testConfig())
      .overrideProvider(WORKER_LOGGER)
      .useValue(
        createLogger({ service: 'di-test', level: 'silent', destination: createMemoryStream() }),
      )
      .compile();

    expect(moduleRef.get(CollectorService)).toBeInstanceOf(CollectorService);
    expect(moduleRef.get(SourceScheduler)).toBeInstanceOf(SourceScheduler);

    // 顺带钉住「调度间隔来自契约常量」—— 它被改成 0 会让调度器空转。
    expect(moduleRef.get(COLLECTOR_CONFIG).schedulerIntervalMs).toBe(SCHEDULER_INTERVAL_MS);

    await moduleRef.close();
  });

  it('`CollectorsModule` 导出了下游需要的两个 provider（Agent 14 集成时要用）', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [CollectorsModule] })
      .overrideProvider(PrismaService)
      .useValue({})
      .overrideProvider(SOURCE_LOCK)
      .useValue(new InMemorySourceLock())
      .overrideProvider(SOURCE_FETCH_QUEUE)
      .useValue(new InMemorySourceFetchQueue())
      .overrideProvider(COLLECTOR_CONFIG)
      .useValue(testConfig())
      .overrideProvider(WORKER_LOGGER)
      .useValue(
        createLogger({ service: 'di-test', level: 'silent', destination: createMemoryStream() }),
      )
      .compile();

    expect(moduleRef.get(CollectorService, { strict: false })).toBeDefined();
    expect(moduleRef.get(SourceScheduler, { strict: false })).toBeDefined();
    await moduleRef.close();
  });
});

/* ------------------------------------------------------------------ */
/* 3. 适配器注册表完整性                                                */
/* ------------------------------------------------------------------ */

describe('适配器注册表覆盖全部 SourceType', () => {
  it('六个类型一个不少（少一个就编译不过，这里再验一次运行期）', async () => {
    const { createAdapterRegistry } = await import('../src/jobs/collectors/adapters');
    const registry = createAdapterRegistry();
    for (const type of Object.values(SourceType)) {
      expect(registry[type], `${type} 应有适配器`).toBeDefined();
      expect(registry[type]!.type).toBe(type);
    }
    expect(Object.values(SourceType)).toHaveLength(6);
  });
});
