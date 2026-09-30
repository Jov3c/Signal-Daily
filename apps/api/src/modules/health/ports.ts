/**
 * 健康检查的端口（readiness 探针）。
 *
 * readiness 是**可注入的一串探针**，不是写死的 `if (mysql && redis)`。
 * 这样测试能在没有 MySQL / 没有 Redis 的机器上跑完整条 HTTP 路径
 * （把探针换成桩），而「真的能连上真库」由集成测试另外证明 ——
 * 两者缺一不可：只有桩会重演 Agent 06 / Agent 08 那种「零执行」的假绿，
 * 只有真库则无法在 CI 里构造「MySQL 挂了」这种状态。
 */

/**
 * readiness **只**认这两个依赖。
 *
 * `docs/15`：「外部 AI/X/GitHub 不影响 readiness」。
 * 所以这是一个**允许清单**：只有列在这里的依赖可以决定 503。
 * `health-routes.spec.ts` 有一条守卫拿它做断言，另有一条守卫扫本目录源码，
 * 确认没有任何文件 import 了 AI / X / GitHub 相关的模块。
 */
export const READINESS_DEPENDENCIES = ['mysql', 'redis'] as const;

export type ReadinessDependency = (typeof READINESS_DEPENDENCIES)[number];

/**
 * 探针失败的**枚举化**原因。
 *
 * ── ⚠ 为什么不是自由文本 ──────────────────────────────────────────────
 * `/health/` 在 nginx 里是**对外可达**的（`infra/nginx/nginx.conf` 的
 * `location /health/`）。而底层错误里最典型的两句是
 *
 * ```text
 * connect ECONNREFUSED 10.0.0.5:3306
 * WRONGPASS invalid username-password pair ...
 * ```
 *
 * `@signal/logger` 的 `redactString` 只覆盖**连接串里的密码段**
 * （`scheme://user:pass@host`）与内联 bearer 凭据 —— 它**不覆盖**裸的
 * 主机/端口/内部错误文案。把原始 message 放进响应体等于把内网拓扑
 * 送给任何一个会 curl 的人。
 *
 * 所以响应体里只有这三个值；完整错误走 logger（那里有脱敏与 requestId）。
 */
export const PROBE_FAILURE_REASONS = ['UNREACHABLE', 'TIMEOUT', 'ERROR'] as const;

export type ProbeFailureReason = (typeof PROBE_FAILURE_REASONS)[number];

/** 单个依赖的检查结果。 */
export type ProbeResult = { status: 'up' } | { status: 'down'; reason: ProbeFailureReason };

/**
 * 一条探针。**约定：不抛异常** —— 连不上是 `down`，不是异常。
 *
 * 「探针抛了」与「依赖挂了」是两件不同的事：前者是代码缺陷（会被
 * `HealthService` 兜成 `ERROR`），后者是运维事件。混在一起的话，
 * 503 的告警里就分不出「该重启 Redis」还是「该修探针」。
 */
export type ReadinessProbe = {
  readonly dependency: ReadinessDependency;
  probe(): Promise<ProbeResult>;
};

/** 注入 token。 */
export const READINESS_PROBES = 'HEALTH_READINESS_PROBES';
