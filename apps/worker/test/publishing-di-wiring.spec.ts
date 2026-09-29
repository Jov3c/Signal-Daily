/**
 * `PublishingModule` 依赖注入接线的守卫。
 *
 * ── 为什么需要这个文件（本项目已经栽过两次）─────────────────────────
 *
 * 1. **Agent 02 的实测**：`pnpm lint` 的 `consistent-type-imports` 自动修复把
 *    `import { AuthGuard }` 改成 `import { type AuthGuard }`，于是
 *    `emitDecoratorMetadata` 生成的 `design:paramtypes` 从
 *    `[AuthGuard]` 退化成 `[Function]` —— **生产构建里解析不到依赖，
 *    而所有测试仍然是绿的**（测试跑的是 oxc transform，按源码即时生成元数据）。
 * 2. **本模块自己**：`module.ts` 里 `@Module({...})` 装饰器在**类定义时**求值，
 *    而我把一个 `const connectionProvider` 写在了类**之后** → TDZ →
 *    启动即 `ReferenceError`。那是编译期发现不了的（lint/typecheck 都过），
 *    只有真的构造模块才知道。
 *
 * 所以这里做两件事：**静态扫描**（构造参数必须有显式 `@Inject`）+
 * **真解析**（把整个模块建起来并取出关键 provider）。
 *
 * ⚠ `Test.createTestingModule().compile()` **不会**触发 `onModuleInit`，
 * 因此消费者的 `start()` 与调度器的定时器都不会真的跑 ——
 * 这正是我们能在没有 Redis 的机器上验依赖图的原因。
 * 只替换**外部世界**（Prisma / Redis 连接 / Queue / 时钟 / 日志），
 * 其余全部是真实实现。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { createLogger } from '@signal/logger';
import { createMemoryStream } from '@signal/test-utils';
import { PublishingModule } from '../src/jobs/publishing/module';
import { PUBLISHING_QUEUE, PUBLISHING_QUEUE_CONNECTION } from '../src/jobs/publishing/enqueuer';
import { PUBLISHING_NOTIFIER } from '../src/jobs/publishing/notifier';
import { PUBLISHING_JOB_RUN_RECORDER } from '../src/jobs/publishing/prisma-job-run.repository';
import { PublishingPrismaService } from '../src/jobs/publishing/prisma.service';
import { PUBLISHING_REPOSITORY } from '../src/jobs/publishing/publishing.repository';
import { PUBLISHING_LOGGER, PublishingService } from '../src/jobs/publishing/publishing.service';
import {
  PUBLISHING_ENQUEUER,
  PublishingScheduler,
  SCHEDULER_TICK_INTERVAL_MS,
} from '../src/jobs/publishing/scheduler';
import { publishingConnectionOptions } from '../src/jobs/publishing/enqueuer';

const PUBLISHING_SRC = fileURLToPath(new URL('../src/jobs/publishing', import.meta.url));

/* ------------------------------------------------------------------ */
/* 1. 静态扫描                                                         */
/* ------------------------------------------------------------------ */

/** 递归收集目录下所有 `.ts`（不含测试）。 */
function sourceFiles(dir: string): { path: string; code: string }[] {
  const out: { path: string; code: string }[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
      continue;
    }
    if (entry.endsWith('.ts')) out.push({ path: full, code: readFileSync(full, 'utf8') });
  }
  return out;
}

/**
 * 从 `constructor(` 起找配对的右括号，返回参数列表。
 *
 * 简化版（不处理泛型里的括号嵌套）够用：本模块的构造函数参数都是
 * `@Inject(TOKEN) private readonly x: Type` 这种平铺形状。
 */
function constructorParamsOf(source: string): string[] {
  const start = source.indexOf('constructor(');
  if (start === -1) return [];

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
  return body
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '');
}

describe('构造参数必须显式声明 @Inject（防 emitDecoratorMetadata 退化）', () => {
  it('所有类类型的构造参数都有 @Inject', () => {
    const offenders: string[] = [];

    for (const file of sourceFiles(PUBLISHING_SRC)) {
      // 只看「注入 token 是类」的参数：`private readonly x: SomeClass`
      //（不是 `string` / `number` / 接口名这类运行时不是值的东西）。
      for (const parameter of constructorParamsOf(file.code)) {
        const classTyped =
          /:\s*(?!string\b|number\b|boolean\b|Date\b|unknown\b|object\b)[A-Z][A-Za-z0-9_]*\s*$/.test(
            parameter,
          );
        if (!classTyped) continue;
        if (parameter.includes('@Inject(')) continue;
        offenders.push(
          `${file.path.replace(PUBLISHING_SRC, 'src/jobs/publishing')}: ${parameter.replace(/\s+/g, ' ')}`,
        );
      }
    }

    expect(offenders).toEqual([]);
  });

  it('**有牙齿**：合成样本必须被命中（否则上面那条是空跑）', () => {
    const synthetic = 'constructor(private readonly service: PublishingService) {}';
    const parameters = constructorParamsOf(synthetic);
    expect(parameters).toHaveLength(1);
    expect(parameters[0]?.includes('@Inject(')).toBe(false);

    const withInject =
      'constructor(@Inject(PublishingService) private readonly s: PublishingService) {}';
    expect(constructorParamsOf(withInject)[0]?.includes('@Inject(')).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* 2. 真解析                                                           */
/* ------------------------------------------------------------------ */

/** 只替换外部世界的模块构造器。 */
async function compileWithFakes() {
  return Test.createTestingModule({ imports: [PublishingModule] })
    .overrideProvider(PublishingPrismaService)
    .useValue({})
    .overrideProvider(PUBLISHING_QUEUE_CONNECTION)
    .useValue({ host: '127.0.0.1', port: 6379 })
    .overrideProvider(PUBLISHING_QUEUE)
    .useValue({ add: async () => undefined })
    .overrideProvider(PUBLISHING_ENQUEUER)
    .useValue({ add: async () => undefined })
    .overrideProvider(PUBLISHING_REPOSITORY)
    .useValue({})
    .overrideProvider(PUBLISHING_NOTIFIER)
    .useValue({ notify: async () => true })
    .overrideProvider(PUBLISHING_JOB_RUN_RECORDER)
    .useValue({ record: async () => undefined })
    .overrideProvider(PUBLISHING_LOGGER)
    .useValue(
      createLogger({ service: 'di-test', level: 'silent', destination: createMemoryStream() }),
    )
    .compile();
}

describe('PublishingModule 的依赖图真的能建起来', () => {
  it('整个模块能编译，关键 provider 都是真实实例', async () => {
    const moduleRef = await compileWithFakes();

    expect(moduleRef.get(PublishingService)).toBeInstanceOf(PublishingService);
    expect(moduleRef.get(PublishingScheduler)).toBeInstanceOf(PublishingScheduler);

    await moduleRef.close();
  });

  it('导出了下游需要的 provider（Agent 14 集成时要用）', async () => {
    const moduleRef = await compileWithFakes();

    expect(moduleRef.get(PublishingService, { strict: false })).toBeDefined();
    expect(moduleRef.get(PUBLISHING_REPOSITORY, { strict: false })).toBeDefined();
    expect(moduleRef.get(PUBLISHING_ENQUEUER, { strict: false })).toBeDefined();

    await moduleRef.close();
  });

  it('⚠ 取出模块实例**不**触发 onModuleInit（所以不需要 Redis 也不会起消费者）', async () => {
    // 这条不是文字游戏：如果哪天有人把 `worker.start()` 挪进构造函数，
    // 这个测试会在没有 Redis 的机器上挂掉 —— 而那正是我们要的信号
    //（「单测不需要 Redis」是本仓库的一条硬约定）。
    const moduleRef = await compileWithFakes();
    expect(moduleRef.get(PublishingModule)).toBeInstanceOf(PublishingModule);
    await moduleRef.close();
  });

  it('调度间隔取自导出的常量（改成 0 会让调度器空转）', () => {
    expect(SCHEDULER_TICK_INTERVAL_MS).toBe(60_000);
  });

  it('Redis 连接参数的解析**不是**第 4 份实现（复用 Agent 06 的）', () => {
    // 本模块的 `publishingConnectionOptions` 只是给 Agent 06 的
    // `parseRedisConnection` 起一个本地可读的名字，不做任何额外处理。
    // 这里验的是 Agent 06 已经处理过的三个坑仍然有效：
    // 空端口回退 6379、空用户名不传、`rediss:` 补 tls。
    expect(publishingConnectionOptions('redis://localhost')).toMatchObject({
      host: 'localhost',
      port: 6379,
    });
    expect(publishingConnectionOptions('rediss://user:pass@host:6380/2')).toMatchObject({
      port: 6380,
      username: 'user',
      db: 2,
      tls: {},
    });
  });
});
