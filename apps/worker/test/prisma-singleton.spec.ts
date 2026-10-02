/**
 * P3-02 的回归守卫：**一个 Worker 进程只初始化一个 `PrismaClient`**。
 *
 * ── 为什么需要这个文件 ──────────────────────────────────────────────
 * 收敛前 worker 的四个 Job 模块各持有一份 `PrismaClient` 子类
 *（collectors / ai / content / publishing）—— 一个进程挂上四个模块就是
 * **四个连接池**。清单 P3-02 把它收敛成一份 `@Global()` 的
 * `WorkerPrismaService`（`src/common/prisma/`）。
 *
 * 「收敛完成」不能靠「我看了一遍代码」来宣布 —— 这个仓库已经栽过好几次
 * 「把四份包装改成一份」这件事的假阴性（`compile()` 只建图不实例化）。
 * 所以这里分两层实测：
 *
 * 1. **静态**：整个 `src/` 里只有一处 `extends PrismaClient`，
 *    且四个 Job 模块都 import 了 `PrismaModule`。
 * 2. **运行时**：用**真实** `WorkerModule` 建应用上下文，逐个取出四个模块
 *    的仓储，断言它们持有的 `prisma` 字段是**同一个对象**；
 *    关闭时 `$disconnect()` 与 `onModuleDestroy()` 都**恰好发生一次**。
 *
 * 第 2 条是真正的证据：如果哪天有人再往某个模块 `providers` 里加一份
 * PrismaService，仓储拿到的对象就不再全等，disconnect 也会变成 2 次以上。
 *
 * ⚠ 与 `boot.spec.ts` 一样，本文件需要一份合法 env（各 provider 工厂会跑
 * `parseEnv()`），但**不连 Redis**：`NODE_ENV=test` 下 `shouldStartConsumers()`
 * 为 false，消费者与定时器都不启动。
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { TEST_ENV } from '@signal/test-utils';
import { createWorkerApp } from '../src/bootstrap';
import { WorkerPrismaService } from '../src/common/prisma/prisma.service';
import { AI_REPOSITORY } from '../src/jobs/ai/ai-run.repository';
import { JOB_RUN_REPOSITORY, SOURCE_REPOSITORY } from '../src/jobs/collectors/ports';
import { CONTENT_REPOSITORY } from '../src/jobs/content/ports';
import { PUBLISHING_REPOSITORY } from '../src/jobs/publishing/publishing.repository';
import { PUBLISHING_NOTIFIER } from '../src/jobs/publishing/notifier';
import { PUBLISHING_JOB_RUN_RECORDER } from '../src/jobs/publishing/prisma-job-run.repository';

const WORKER_SRC = fileURLToPath(new URL('../src', import.meta.url));

/** 递归收集 `.ts`（跳过 node_modules / dist）。 */
function collectTs(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      collectTs(full, found);
    } else if (entry.name.endsWith('.ts')) {
      found.push(full);
    }
  }
  return found;
}

/* ------------------------------------------------------------------ */
/* 1. 静态扫描                                                         */
/* ------------------------------------------------------------------ */

describe('P3-02 静态：worker src 里只有一份 PrismaClient 实现', () => {
  const files = collectTs(WORKER_SRC).map((path) => ({
    path: path.replace(WORKER_SRC, 'src').replace(/\\/g, '/'),
    code: readFileSync(path, 'utf8'),
  }));

  it('扫描到了源码（防止空跑）', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it('`extends PrismaClient` 全仓库只有一处，且就是那个全局 service', () => {
    const inheritors = files
      .filter((file) => /\bclass\s+[A-Z][A-Za-z0-9_]*\s+extends\s+PrismaClient\b/.test(file.code))
      .map((file) => file.path);

    // 收敛前这里是 4 份（jobs/{collectors,ai,content,publishing}/prisma.service.ts）。
    // 掉到 1 才是收敛完成；涨到 2 说明有人又加了一份连接池。
    expect(inheritors).toEqual(['src/common/prisma/prisma.service.ts']);
  });

  it('四个 Job 模块都 `imports` 了 PrismaModule（否则单独编译时会解析不到）', () => {
    const modules = [
      'src/jobs/collectors/module.ts',
      'src/jobs/ai/module.ts',
      'src/jobs/content/module.ts',
      'src/jobs/publishing/module.ts',
    ];

    for (const modulePath of modules) {
      const file = files.find((entry) => entry.path === modulePath);
      expect(file, `${modulePath} 应存在`).toBeDefined();
      // `imports: [ ... PrismaModule ]` —— 允许前面还有别的模块。
      expect(file!.code, `${modulePath} 的 imports 里应有 PrismaModule`).toMatch(
        /imports:\s*\[[^\]]*\bPrismaModule\b/,
      );
    }
  });
});

/* ------------------------------------------------------------------ */
/* 2. 运行时：真实 WorkerModule                                        */
/* ------------------------------------------------------------------ */

beforeAll(() => {
  for (const [key, value] of Object.entries(TEST_ENV)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
});

const disconnectSpy = vi.spyOn(PrismaClient.prototype, '$disconnect');
const destroySpy = vi.spyOn(WorkerPrismaService.prototype, 'onModuleDestroy');

afterAll(() => {
  disconnectSpy.mockRestore();
  destroySpy.mockRestore();
});

describe('P3-02 运行时：四个模块共用一个连接池', () => {
  it('四个模块的仓储持有同一个 prisma 对象，且关闭时只 disconnect 一次', async () => {
    const context = await createWorkerApp();

    // 容器里的那一个实例。
    // ⚠ 这里**不能**写 `expect(single).toBeInstanceOf(WorkerPrismaService)`：
    // Prisma 的客户端实例是个 Proxy，`instanceof` 对它返回 **false**
    //（实测 `new PrismaClient() instanceof PrismaClient === false`），断言会失败；
    // 而 vitest 构造失败信息时序列化这个 Proxy 又会无限递归，最后抛的是
    // `RangeError: Maximum call stack size exceeded`，看不到真正的原因。
    // 本用例要证的是「只有一个对象」，下面那些**全等**断言才是重点。
    const single = context.get(WorkerPrismaService, { strict: false });
    expect(single).toBeDefined();
    expect(typeof single.$disconnect).toBe('function');

    // 四个模块各自「会真的读库」的对象 —— 逐个取出它们实际持有的 prisma。
    const holders: { label: string; prisma: unknown }[] = [
      {
        label: 'ai 仓储',
        prisma: (context.get(AI_REPOSITORY, { strict: false }) as PrismaHolder).prisma,
      },
      {
        label: 'collectors source 仓储',
        prisma: (context.get(SOURCE_REPOSITORY, { strict: false }) as PrismaHolder).prisma,
      },
      {
        label: 'collectors job-run 仓储',
        prisma: (context.get(JOB_RUN_REPOSITORY, { strict: false }) as PrismaHolder).prisma,
      },
      {
        label: 'content 仓储',
        prisma: (context.get(CONTENT_REPOSITORY, { strict: false }) as PrismaHolder).prisma,
      },
      {
        label: 'publishing 仓储',
        prisma: (context.get(PUBLISHING_REPOSITORY, { strict: false }) as PrismaHolder).prisma,
      },
      {
        label: 'publishing 通知器',
        prisma: (context.get(PUBLISHING_NOTIFIER, { strict: false }) as PrismaHolder).prisma,
      },
      {
        label: 'publishing job-run 记录器',
        prisma: (context.get(PUBLISHING_JOB_RUN_RECORDER, { strict: false }) as PrismaHolder)
          .prisma,
      },
    ];

    for (const { label, prisma } of holders) {
      // 不是 `instanceof`（那只能说明「是某个 PrismaClient」）——
      // 这里要的是**全等**：四个模块拿到的是同一个对象，也就是同一个连接池。
      //
      // ⚠ 先算出布尔值再断言，而不是 `expect(prisma).toBe(single)`：
      // Prisma 客户端对象一旦进入 vitest 的失败 diff 序列化就会无限递归
      //（失败信息变成 `RangeError`，看不出是哪一条断言挂了）。
      const sameObject = prisma === single;
      expect(sameObject, `${label} 的 prisma 应与全局实例全等（同一个连接池）`).toBe(true);
    }

    await context.close();

    // 全局只有一个实例 → 容器只会销毁它一次 → 只 disconnect 一次。
    // 收敛前这里是 4（四个模块各有一个 onModuleDestroy）。
    expect(destroySpy).toHaveBeenCalledTimes(1);
    expect(disconnectSpy).toHaveBeenCalledTimes(1);
  });
});

/** 仓储 / 通知器把注入的 prisma 存成私有字段；运行时读取它需要放宽类型。 */
type PrismaHolder = { prisma: unknown };
