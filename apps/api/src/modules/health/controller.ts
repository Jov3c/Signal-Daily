/**
 * 健康检查控制器。
 *
 * ```text
 * GET /health/live     → 200 恒成立
 * GET /health/ready    → 200（全部依赖 up）/ 503（任一依赖 down）
 * ```
 *
 * ── ⚠ 503 是**手动设置状态码**的，不是 `throw` ──────────────────────
 * 直觉写法是 `throw new ServiceUnavailableException(report)`。
 * 那在本仓库里是**错的**：`AppErrorFilter` 是 `@Catch()`（全捕获，经
 * `APP_FILTER` 注册，对所有控制器生效），它会把任何异常——包括
 * `HttpException`——收敛成 `docs/02` 的统一错误封套：
 *
 * ```json
 * {"error":{"code":"INTERNAL_ERROR","message":"Internal server error",...}}
 * ```
 *
 * 于是 `checks` 整个丢掉，`/health/ready` 变成「只知道坏了、不知道谁坏了」——
 * 而那正是这个端点唯一要说的事。
 *
 * 所以这里用 `@Res({ passthrough: true })` 直接写状态码、把报告作为
 * 正常响应体返回。`passthrough: true` 是必需的：没有它 Nest 会认为
 * 响应已被手动接管，从而**不发送**返回的对象。
 *
 * 用最小结构类型 `StatusSettable` 而不是 express 的 `Response`：
 * 本仓库刻意不引入 `@types/express`（同 `common/http/http-types.ts` 的理由），
 * 这样本控制器也能在没有任何 HTTP 框架实例的测试里直接构造。
 *
 * ── 响应体形状不进 `docs/02` 的封套 ────────────────────────────────
 * `{data: ...}` 封套是**业务 API** 的约定（`docs/02`）。健康端点的
 * 消费者是 docker healthcheck、Uptime Kuma 与运维脚本，
 * 它们要的是「HTTP 200 与否」和一个能直接读的诊断体，不是封套。
 * `docs/04` 也把这两条单独列在 `## Health` 下，不属 `/api/v1` 业务面。
 */

import { Controller, Get, Header, Inject, Res } from '@nestjs/common';
import { HealthService, type LiveReport, type ReadyReport } from './service';
import { HEALTH_CONTROLLER_PATH, HEALTH_LIVE_SEGMENT, HEALTH_READY_SEGMENT } from './routes';

/** `@Res({ passthrough: true })` 需要的最小能力。 */
export type StatusSettable = { status(code: number): unknown };

@Controller(HEALTH_CONTROLLER_PATH)
export class HealthController {
  constructor(@Inject(HealthService) private readonly health: HealthService) {}

  /** 进程存活 —— 恒 200，不查任何依赖。 */
  @Get(HEALTH_LIVE_SEGMENT)
  // 健康响应**绝不能**被任何中间层缓存：一份被缓存的 200 会在后端
  // 真的挂掉之后继续冒充「健康」。
  @Header('Cache-Control', 'no-store')
  live(): LiveReport {
    return this.health.live();
  }

  /** 依赖就绪 —— 全部 up 才 200，否则 503。 */
  @Get(HEALTH_READY_SEGMENT)
  @Header('Cache-Control', 'no-store')
  async ready(@Res({ passthrough: true }) res: StatusSettable): Promise<ReadyReport> {
    const report = await this.health.ready();
    // 200 / 503 由报告本身决定；compose 的 healthcheck 只看 `r.ok`。
    res.status(report.status === 'ok' ? 200 : 503);
    return report;
  }
}
