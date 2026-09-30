/**
 * 两条**真实**探针的实现（MySQL / Redis）。
 *
 * 它们被单独放在一个文件里，是为了能被集成测试**脱离 Nest** 直接构造
 * （`createMysqlProbe(new PrismaClient(...))`）—— 「真实探针到底会不会
 * 在真库上返回 up」必须有一条**真的执行过**的证据，否则又是
 * Agent 06 / Agent 08 那种「测试全绿但被测代码从没跑过」。
 */

import type {
  ProbeFailureReason,
  ProbeResult,
  ReadinessDependency,
  ReadinessProbe,
} from './ports';

/* ------------------------------------------------------------------ */
/* 窄端口 —— 只声明我们真正用到的能力                                   */
/* ------------------------------------------------------------------ */

/**
 * 一个能回答「你还活着吗」的数据库客户端。
 *
 * ── 为什么端口叫 `ping()` 而不是照抄 Prisma 的 `$queryRaw` ──────────
 * 两个理由：
 *
 * 1. **探针不该绑定 ORM。** 它需要的只是「能问一次」这个能力，
 *    谁的实现都行（Prisma、mysql2、一个测试替身）。端口照抄 Prisma 的
 *    方法名会让人以为必须传一个 Prisma 客户端进来。
 * 2. **SQL 只出现在一处。** 具体发什么查询是**装配方**的决定
 *    （`module.ts` 里那一行 `SELECT 1`），探针只负责「调它、把结果
 *    收敛成 up/down」。这样测试替身也不必假装会解析 SQL。
 *
 * ⚠ 顺带的好处：`apps/api/test/auth-contract.spec.ts` 有一条守卫禁止
 * `modules/` 里出现非标签模板的原生 SQL。把 `$queryRaw` 写进**类型声明**
 * 会被它误报（类型声明不可能执行任何东西），而端口改叫 `ping()` 之后
 * 那条守卫不再需要为「一个类型声明」开口子。
 */
export type SqlPinger = { ping(): Promise<unknown> };

/** ioredis 客户端结构上满足（只用到 `ping`）。 */
export type RedisPinger = { ping(): Promise<string> };

/**
 * 探针失败的**收口**回调。
 *
 * 探针自己**不写日志、也不把异常交出去**：`probe()` 的返回值会被
 * 序列化进 HTTP 响应体（`/health/` 是对外可达的），所以它只允许装
 * 三个枚举值（见 `ports.ts`）。而排查故障需要原始错误 ——
 * 那个走这条回调，由装配层交给带脱敏的 logger。
 *
 * 两条通道分开，是为了让「想泄露」这件事**写不出来**：
 * 未来若有人把返回值直接塞进响应体，泄露的不是错误原文。
 */
export type FailureSink = (error: unknown) => void;

/* ------------------------------------------------------------------ */
/* 失败归类                                                            */
/* ------------------------------------------------------------------ */

/**
 * Node 的网络层 errno。
 * 这些是「连不上/连断了」，不是「代码错了」—— 归 UNREACHABLE。
 */
const UNREACHABLE_ERRNO = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EPIPE',
  'EAI_AGAIN',
]);

/**
 * Prisma 里**确实表示「连不上」**的初始化错误码。
 *
 * ```text
 * P1001  数据库服务器不可达
 * P1002  连接超时
 * P1008  操作超时
 * P1017  服务器关闭了连接
 * ```
 *
 * ⚠ 刻意**不**包括同段里的另外几个（P1000 认证失败 / P1003 库不存在 /
 * P1010 用户被拒）。它们不是「网络不通」而是**配置不对** ——
 * 而这两个原因指向完全不同的动作：改防火墙 vs 改 secret。
 * 把它们混成 UNREACHABLE 等于把「该去哪儿看」也一起弄丢了。
 */
const PRISMA_UNREACHABLE_CODES = new Set(['P1001', 'P1002', 'P1008', 'P1017']);

/**
 * ioredis 在「连不上」时的固定文案（这两句**没有** errno，只能按文案认）。
 *
 * 实测（`redis://127.0.0.1:1`，本模块的连接参数）：
 *
 * ```text
 * 68ms  MaxRetriesPerRequestError
 *       Reached the max retries per request limit (which is 1).
 * ```
 *
 * 68 毫秒 —— 这正是把 `connectTimeout` 压到 1 秒、`maxRetriesPerRequest`
 * 压到 1 的目的：探针要**快速**给出答案，而不是把 healthcheck 挂在重试里。
 */
const UNREACHABLE_MESSAGES = [
  'reached the max retries per request',
  "stream isn't writeable",
  'connection is closed',
];

/**
 * Prisma 初始化错误的**文案**判据。
 *
 * ⚠ 这一条才是真正吃劲的：本仓库用的 Prisma 6.19.3 里，
 * `PrismaClientInitializationError` 的 `code` 与 `errorCode` **都是
 * undefined**（实测自有属性只有 stack / message / clientVersion /
 * errorCode / retryable / name），所以只能认文案：
 *
 * ```text
 * PrismaClientInitializationError
 *   Invalid `prisma.$queryRaw()` invocation:
 *   Can't reach database server at `127.0.0.1:1`
 *   Please make sure your database server is running at `127.0.0.1:1`.
 * ```
 *
 * 用**类名**（字符串）而不是 `instanceof`：那会让本文件依赖
 * `@prisma/client`，而探针文件要保持能被任何 SQL 客户端复用。
 */
const PRISMA_INITIALIZATION_ERROR_NAME = 'PrismaClientInitializationError';

const PRISMA_UNREACHABLE_MESSAGES = ["can't reach database server", 'timed out'];

/** 取错误码：Node/ioredis 用 `code`，Prisma 用 `errorCode`。 */
function errorCodeOf(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  const candidate = (error as { code?: unknown }).code ?? (error as { errorCode?: unknown }).errorCode;
  return typeof candidate === 'string' ? candidate : null;
}

/** 把任意异常收敛成**枚举**原因。异常原文不会被交给调用方。 */
export function classifyFailure(error: unknown): ProbeFailureReason {
  const code = errorCodeOf(error);
  if (code !== null) {
    if (UNREACHABLE_ERRNO.has(code)) return 'UNREACHABLE';
    if (PRISMA_UNREACHABLE_CODES.has(code)) return 'UNREACHABLE';
  }

  const name = error instanceof Error ? error.name : '';
  const message = error instanceof Error ? error.message.toLowerCase() : '';

  if (UNREACHABLE_MESSAGES.some((fragment) => message.includes(fragment))) {
    return 'UNREACHABLE';
  }
  if (
    name === PRISMA_INITIALIZATION_ERROR_NAME &&
    PRISMA_UNREACHABLE_MESSAGES.some((fragment) => message.includes(fragment))
  ) {
    return 'UNREACHABLE';
  }

  return 'ERROR';
}

/* ------------------------------------------------------------------ */
/* 探针                                                                */
/* ------------------------------------------------------------------ */

/**
 * MySQL 探针。
 *
 * ⚠ 装配方（`module.ts`）发的是 `SELECT 1`，而不是「有没有连接对象」：
 * 一个 TCP 已建立、但服务端正在关闭 / 只读挂载 / 连接已被中间设备掐断的
 * MySQL，连接对象照样存在。**能回答一次查询**才是 readiness 想表达的事。
 * 而 `SELECT 1` 不碰任何业务表，因此不依赖迁移是否跑完，
 * 也不会因为表锁而误报。
 */
export function createMysqlProbe(sql: SqlPinger, onFailure?: FailureSink): ReadinessProbe {
  const dependency: ReadinessDependency = 'mysql';
  return {
    dependency,
    async probe(): Promise<ProbeResult> {
      try {
        await sql.ping();
        return { status: 'up' };
      } catch (error) {
        // ⚠ 不 rethrow：见 ports.ts 的说明（down 是运维事件，异常是缺陷）。
        onFailure?.(error);
        return { status: 'down', reason: classifyFailure(error) };
      }
    },
  };
}

/**
 * Redis 探针。
 *
 * 校验回包**等于 `PONG`**，而不是「命令没抛」。端口通、但后面不是
 * 我们的 Redis（打到了别的服务、或一个透明代理）时，`PING` 会返回
 * 别的东西或报错 —— 那种情况下把 readiness 判成 up 会让上游继续
 * 往一个不存在的队列里投任务。
 */
export function createRedisProbe(redis: RedisPinger, onFailure?: FailureSink): ReadinessProbe {
  const dependency: ReadinessDependency = 'redis';
  return {
    dependency,
    async probe(): Promise<ProbeResult> {
      try {
        const reply = await redis.ping();
        return reply === 'PONG' ? { status: 'up' } : { status: 'down', reason: 'ERROR' };
      } catch (error) {
        onFailure?.(error);
        return { status: 'down', reason: classifyFailure(error) };
      }
    },
  };
}
