/**
 * Agent 11 — 健康检查的公开面。
 *
 * 下游（Agent 14 的根装配、运维脚本的对照测试）只应从本文件 import。
 *
 * ⚠ `bootstrap.ts` **刻意不从这里** import —— 它只需要路由表，
 * 而本文件会把 `ioredis`、`PrismaService` 一并拉进启动期的 import 图。
 * 那两处各取所需，见 `routes.ts` 的说明。
 */

/* 模块与服务 */
export { HEALTH_REDIS_CLIENT, HealthModule } from './module';
export {
  HEALTH_PROBE_TIMEOUT_MS,
  HealthService,
  PROBE_TIMEOUT_MS,
  assertProbesCoverDependencies,
  type DependencyCheck,
  type LiveReport,
  type ReadyReport,
} from './service';

/* 路由表（`bootstrap.ts` 的 exclude、compose 与运维脚本对照测试都用它） */
export {
  HEALTH_CONTROLLER_PATH,
  HEALTH_LIVE_PATH,
  HEALTH_LIVE_SEGMENT,
  HEALTH_READY_PATH,
  HEALTH_READY_SEGMENT,
  HEALTH_ROUTE_EXCLUSIONS,
} from './routes';

/* 端口（测试替换探针用） */
export {
  PROBE_FAILURE_REASONS,
  READINESS_DEPENDENCIES,
  READINESS_PROBES,
  type ProbeFailureReason,
  type ProbeResult,
  type ReadinessDependency,
  type ReadinessProbe,
} from './ports';

/* 真实探针（集成测试脱离 Nest 直接构造用） */
export {
  classifyFailure,
  createMysqlProbe,
  createRedisProbe,
  type FailureSink,
  type RedisPinger,
  type SqlPinger,
} from './probes';

export { createHealthRedisClient } from './redis-client';
