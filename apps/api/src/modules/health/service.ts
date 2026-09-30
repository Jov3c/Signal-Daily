/**
 * 健康检查的业务逻辑。
 *
 * ```text
 * live()   永远 ok —— 不碰任何依赖
 * ready()  MySQL + Redis 都 up 才 ok，否则 error（控制器映射成 503）
 * ```
 *
 * ── 为什么 live 与 ready 必须分开 ────────────────────────────────────
 * `docs/15` 把这两个端点分开，是为了让**两种故障能被分辨**：
 *
 * | 现象                  | live | ready | 该做什么             |
 * | --------------------- | ---- | ----- | -------------------- |
 * | 进程崩了 / 死循环      | ✗    | ✗     | 重启容器             |
 * | MySQL 暂时不可用      | ✓    | ✗     | **不要**重启，等它恢复 |
 *
 * 第二行是这条设计真正的价值：容器运行时若拿 ready 当存活探针，
 * 一次数据库抖动会让**所有** api 容器被反复重启，而重启并不会让 MySQL
 * 更快恢复 —— 只会把「依赖短暂不可用」放大成「服务整体不可用」。
 *
 * 所以 `live()` **一个依赖都不查**，`health-routes.spec.ts` 里有一条
 * 断言直接钉住这件事（探针的调用计数必须为 0）。
 */

import { Inject, Injectable } from '@nestjs/common';
import { serializeError, type Logger } from '@signal/logger';
import { APP_LOGGER } from '../../common/logger/app-logger';
import {
  READINESS_DEPENDENCIES,
  READINESS_PROBES,
  type ProbeResult,
  type ReadinessDependency,
  type ReadinessProbe,
} from './ports';

/**
 * 单条探针的超时预算（毫秒）。
 *
 * ── 为什么是 3000 而不是一个整数感更强的 2000 ──────────────────────
 * 这是**实测**出来的边界，不是拍的：MySQL 不可达时 Prisma 报
 * `PrismaClientInitializationError: Can't reach database server at ...`
 * 实测耗时 **约 2050ms**（Prisma 默认 `connect_timeout` 5 秒，
 * 但拒绝连接会先返回）。
 *
 * 预算若是 2000，就会**正好卡在它前面** —— 于是「数据库服务器不可达」
 * 这个具体原因被我们自己的超时盖成笼统的 `TIMEOUT`，运维看到的
 * 是「超时了」而不是「连不上 10.0.0.5:3306」。3000 留出余量。
 *
 * ── 预算的算术 ──────────────────────────────────────────────────────
 * 探针**并行**执行（`ready()` 用 `Promise.all`），所以整条 readiness 的
 * 最坏耗时 ≈ 单条预算 = 3 秒，仍在 compose 的 healthcheck
 * `timeout: 5s` 之内。这个不等式有一条第 8 组守卫从 compose 里
 * 把数字读出来比对 —— 改大本常量会让它红。
 */
export const PROBE_TIMEOUT_MS = 3000;

/** `PROBE_TIMEOUT_MS` 的注入 token（测试用毫秒级超时，不必真等 2 秒）。 */
export const HEALTH_PROBE_TIMEOUT_MS = 'HEALTH_PROBE_TIMEOUT_MS';

/** 单个依赖的检查结果（= 探针结果，原样透出）。 */
export type DependencyCheck = ProbeResult;

/** `/health/live` 的响应体。 */
export type LiveReport = {
  status: 'ok';
  /** 进程已运行的秒数 —— 唯一有用的信息：能区分「刚起来」与「跑了三天」。 */
  uptimeSeconds: number;
};

/** `/health/ready` 的响应体。 */
export type ReadyReport = {
  status: 'ok' | 'error';
  checks: Record<ReadinessDependency, DependencyCheck>;
};

/**
 * 执行期不变式：**每个声明过的依赖都必须恰好有一条探针**。
 *
 * ── 为什么这条断言值得存在 ──────────────────────────────────────────
 * `ready()` 的判定是「所有**探针**都 up」。如果 mysql 的探针因为
 * 接线漏了而不在数组里，那么：
 *
 * - `checks` 里没有 `mysql` 这一项；
 * - `every(up)` 只看了 redis → **status: ok**；
 * - `/health/ready` 返回 200，而数据库根本没人问过。
 *
 * 这是本类里唯一能出现的**静默错误**（其余错误都会让 503 出现），
 * 所以它在**构造函数**里执行 —— 接线错了就在进程启动时炸，
 * 而不是在生产上给出一个永远 200 的健康检查。本项目有过同款教训：
 * Agent 06 的 `assertQueueMapping()` 从来没有调用点，掏空它测试仍全绿。
 */
export function assertProbesCoverDependencies(
  probes: readonly ReadinessProbe[],
  declared: readonly ReadinessDependency[] = READINESS_DEPENDENCIES,
): void {
  const seen = new Set<string>();
  const duplicates: string[] = [];
  for (const probe of probes) {
    if (seen.has(probe.dependency)) duplicates.push(probe.dependency);
    seen.add(probe.dependency);
  }

  const missing = declared.filter((name) => !seen.has(name));
  const undeclared = [...seen].filter((name) => !declared.includes(name as ReadinessDependency));

  const problems: string[] = [];
  if (missing.length > 0) {
    problems.push(`缺少探针：${missing.join(', ')}（这些依赖会永远不被检查而 readiness 仍报 ok）`);
  }
  if (duplicates.length > 0) problems.push(`重复探针：${duplicates.join(', ')}`);
  if (undeclared.length > 0) {
    problems.push(
      `未声明的依赖：${undeclared.join(', ')}（决定 readiness 的依赖必须在 READINESS_DEPENDENCIES 里，docs/15 只允许 MySQL 与 Redis）`,
    );
  }

  if (problems.length > 0) {
    throw new Error(`健康检查探针接线错误：\n- ${problems.join('\n- ')}`);
  }
}

@Injectable()
export class HealthService {
  constructor(
    @Inject(READINESS_PROBES) private readonly probes: readonly ReadinessProbe[],
    @Inject(APP_LOGGER) private readonly logger: Logger,
    @Inject(HEALTH_PROBE_TIMEOUT_MS) private readonly timeoutMs: number,
  ) {
    // 接线错误在**启动时**暴露，不在第一次探活时。
    assertProbesCoverDependencies(probes);
  }

  /**
   * 进程存活。
   *
   * ⚠ **刻意不读任何依赖**（`docs/15`：live 是「进程存活」）——
   * 见文件头的表。有人会想「顺手把 MySQL 也查一下更保险」，
   * 那正好会把这条端点退化成 ready，失去它存在的意义。
   */
  live(): LiveReport {
    return { status: 'ok', uptimeSeconds: Math.floor(process.uptime()) };
  }

  /**
   * 依赖就绪。
   *
   * 三条刻意的行为：
   *
   * 1. **并行执行全部探针，不短路**。任一依赖挂掉就 503 是结果，
   *    但运维需要一次就看到「MySQL 挂了、Redis 还好」——
   *    短路的话第二个故障要等第一个修好才暴露。
   * 2. **每条探针独立超时**。一条卡住的探针不能把整个响应拖过
   *    compose 的 5 秒上限（否则报出来的是 docker 的 timeout，
   *    看不出是谁卡的）。
   * 3. **结果里只有枚举值**，原始异常走 logger（见 `ports.ts`）。
   */
  async ready(): Promise<ReadyReport> {
    const results = await Promise.all(
      this.probes.map(async (probe) => [probe.dependency, await this.runOne(probe)] as const),
    );

    // `as` 是安全的：构造函数已经断言过探针恰好覆盖全部声明依赖。
    const checks = Object.fromEntries(results) as Record<ReadinessDependency, DependencyCheck>;
    const status = results.every(([, check]) => check.status === 'up') ? 'ok' : 'error';

    if (status === 'error') {
      this.logger.warn({ checks }, 'readiness degraded');
    }

    return { status, checks };
  }

  /** 跑一条探针，带独立超时；任何形态的失败都收敛成 `down`。 */
  private async runOne(probe: ReadinessProbe): Promise<DependencyCheck> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<ProbeResult>((resolve) => {
      timer = setTimeout(() => {
        resolve({ status: 'down', reason: 'TIMEOUT' });
      }, this.timeoutMs);
    });

    try {
      return await Promise.race([probe.probe(), timedOut]);
    } catch (error) {
      // 探针违反「不抛」约定 —— 这是**代码缺陷**，不是依赖故障，
      // 所以按 error 记（会进 5xx 告警），原因归 ERROR。
      this.logger.error(
        { dependency: probe.dependency, err: serializeError(error) },
        'health probe threw',
      );
      return { status: 'down', reason: 'ERROR' };
    } finally {
      // 不 clear 的话，每次探活都会留一个最长 timeoutMs 的悬挂定时器
      //（探活是每 15 秒一次的常驻行为，这会一直积累）。
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}
