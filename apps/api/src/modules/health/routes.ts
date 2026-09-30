/**
 * 健康检查路由的**唯一真源**。
 *
 * ```text
 * GET /health/live     进程存活
 * GET /health/ready    MySQL + Redis 可用（docs/15 / docs/04）
 * ```
 *
 * ── ⚠ 这两条路径**不在** `/api/v1` 下 ──────────────────────────────
 * 全站前缀 `/api/v1` 由 `bootstrap.ts` 的 `setGlobalPrefix` 统一下发。
 * 所以这两条必须走 `exclude`（Agent 00 的 HANDOFF 原话：
 * 「接入健康检查时请用 `setGlobalPrefix` 的 `exclude` 选项，不要改这里的前缀常量」）。
 *
 * ── 为什么把路径抽成一个文件而不是写在装饰器里 ──────────────────────
 * 有**四个**互相独立的地方要就同一组路径达成一致，它们分属不同文件、
 * 不同语言，编译期谁也管不到谁：
 *
 * ```text
 * 1. controller.ts 的 @Controller/@Get   —— 路由真正注册在哪
 * 2. bootstrap.ts 的 setGlobalPrefix.exclude —— 决定它前缀后是否还叫这个名字
 * 3. docker-compose.yml 的 api healthcheck  —— 一个 curl/fetch 的 URL 字面量
 * 4. scripts/ops/healthcheck.sh 的两个路径    —— 另一个 bash 字面量
 * ```
 *
 * 这四处只要有一处写错，表现都是同一种**只在部署后才会出现**的故障：
 * 容器永远 `starting`、compose 的 `depends_on: service_healthy` 卡死、
 * 整机起不来 —— 而 `pnpm test` 全绿（因为测试根本不读 compose）。
 *
 * 本项目已经为同一类问题付过学费（Agent 06 的 `translateJobId`：
 * 集成测试自己拼 `it-<random>` 字面量，从没调用过真的 builder）。
 * 所以这里把路径抽成常量，并由 `health-routes.spec.ts` 把
 * **上面第 3、4 两处的字面量**读出来与它逐字比对。
 */

import { RequestMethod } from '@nestjs/common';

/** 控制器挂载段（`@Controller(...)` 用）。 */
export const HEALTH_CONTROLLER_PATH = 'health';

/** 控制器内的子路径（`@Get(...)` 用）。 */
export const HEALTH_LIVE_SEGMENT = 'live';
export const HEALTH_READY_SEGMENT = 'ready';

/** 完整路径 —— **不含**全局前缀。compose 与运维脚本里出现的就是这两个。 */
export const HEALTH_LIVE_PATH = `${HEALTH_CONTROLLER_PATH}/${HEALTH_LIVE_SEGMENT}`;
export const HEALTH_READY_PATH = `${HEALTH_CONTROLLER_PATH}/${HEALTH_READY_SEGMENT}`;

/**
 * 交给 `setGlobalPrefix(prefix, { exclude })` 的表。
 *
 * 用 `{ path, method }` 而不是裸字符串：裸字符串会被 Nest 当成
 * `RequestMethod.ALL`（`mapToExcludeRoute` 的行为）。这里写死 GET，
 * 将来若有人给 `/health/ready` 加一条 POST，那条**会**带上 `/api/v1` 前缀 ——
 * 那是正确的（它是一条业务路由），而不是被这个 exclude 顺手豁免掉。
 */
export const HEALTH_ROUTE_EXCLUSIONS: { path: string; method: RequestMethod }[] = [
  { path: HEALTH_LIVE_PATH, method: RequestMethod.GET },
  { path: HEALTH_READY_PATH, method: RequestMethod.GET },
];
