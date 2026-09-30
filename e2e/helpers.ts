/**
 * E2E harness 的共享工具：环境装载 / 安全护栏 / 子进程台账 / 验证码解析。
 *
 * 放在 `helpers.ts` 而不是各处复制，是因为有四类消费者要就同一批约定达成一致，
 * 而它们分属不同进程、编译期谁也管不到谁：
 *
 * ```text
 * 1. global-setup.ts    —— 起进程、写台账
 * 2. global-teardown.ts —— 读台账、杀进程
 * 3. login.spec.ts      —— 读台账、轮询日志拿验证码
 * 4. 未来新增的用例      —— 同一个 baseURL、同一份 envoy
 * ```
 *
 * 这正是本仓库反复踩过的形状（见 `apps/api/src/modules/health/routes.ts` 的注释）：
 * 字面量一旦被复制到多处，就会出现「四处里有三处对」的部署期故障。
 */

import { spawnSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createConnection } from 'node:net';
import path from 'node:path';

/** 仓库根。`e2e/` 就在根下，所以上一层就是根。 */
export const REPO_ROOT = path.resolve(__dirname, '..');

/** 所有运行时产物（日志、台账、报告）都落在这里，`.gitignore` 已排除。 */
export const ARTIFACTS_DIR = path.join(REPO_ROOT, 'e2e', '.artifacts');

/**
 * ⚠ 端口是**写死**的，不是可配的。
 *
 * `next.config.mjs` 的 rewrite 目标在 `next build` 时求值一次并写进
 * `routes-manifest.json`，开发形态下的默认值就是 `http://127.0.0.1:3001/api`。
 * 也就是说「api 在 3001、web 在 3000」不是我们的偏好，而是**已经烤进构建产物**的
 * 事实。让端口可配会产生一种极具迷惑性的失败：web 起来了、页面也渲染了，
 * 只有 `/api/*` 静默 502 —— 也就是 A 类缺陷换了个马甲回来。
 */
export const API_ORIGIN = 'http://127.0.0.1:3001';
export const WEB_PORT = 3000;
export const WEB_BASE_URL = `http://localhost:${String(WEB_PORT)}`;

/** 子进程台账：setup 写、teardown 与用例读。 */
export const STATE_FILE = path.join(ARTIFACTS_DIR, 'harness-state.json');

/** API 的 stdout / stderr **分开**落文件。 */
export const API_STDOUT_LOG = path.join(ARTIFACTS_DIR, 'api.stdout.log');
export const API_STDERR_LOG = path.join(ARTIFACTS_DIR, 'api.stderr.log');
export const WEB_STDOUT_LOG = path.join(ARTIFACTS_DIR, 'web.stdout.log');
export const WEB_STDERR_LOG = path.join(ARTIFACTS_DIR, 'web.stderr.log');

export type HarnessState = {
  apiPid: number;
  webPid: number;
  startedAt: string;
};

/* ------------------------------------------------------------------ */
/* .env 装载                                                           */
/* ------------------------------------------------------------------ */

/**
 * 解析 `.env`。
 *
 * ⚠ 仓库里**没有任何 dotenv**（`grep -rn dotenv packages apps` 是空的）：
 * `parseEnv()` 直接读 `process.env`，compose 用 `env_file:` 注入。
 * 所以 api 子进程拿不到 `.env` 里的东西 —— 必须由这里显式喂给它。
 * 这是「本地跑得起来」与「本地静默起不来」之间的唯一区别。
 */
export function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    // 去一层引号（`.env` 里没人写引号，但将来有人写了不该炸）
    if (value.length >= 2 && /^(".*"|'.*')$/.test(value)) value = value.slice(1, -1);
    out[key] = value;
  }
  return out;
}

export type HarnessEnv = {
  /** 喂给 api 子进程的环境（含验证码落 stderr 所需的 `NODE_ENV=development`）。 */
  apiEnv: NodeJS.ProcessEnv;
  /** 喂给 web 子进程的环境（`NODE_ENV` 必须是 production，见下）。 */
  webEnv: NodeJS.ProcessEnv;
  databaseUrl: string;
  redisUrl: string;
  nodeEnv: string;
};

/**
 * 组装子进程环境，并顺手做掉两处「实测与文档不符」的修正。
 *
 * ⚠ 修正一：**Redis 端口**。
 * 仓库 `.env` 写的是 `redis://localhost:6379`，但本机实跑的 Redis 在 **6390**。
 * 这个差异不能靠改 `.env` 解决（那是生产配置，且 `.env` 被 gitignore、
 * 改了对别人无效）。所以这里在**喂给子进程之前**把端口改掉，
 * 并把它做成一个显式、可 grep 的动作，而不是某个神秘的环境差异。
 *
 * ⚠ 修正二：web 子进程的 `NODE_ENV`。
 * api 必须 `development`，否则 `ConsoleMailSender` 会拒绝工作
 *（`mail-sender.ts` 的双保险会把生产形态的验证码请求打成 503），
 * 我们就永远拿不到验证码。而 `next start` 跑的是**生产构建**，
 * 给它 `development` 会让 Next 自己的分支判断错乱。两个进程要不同的值。
 */
export function loadHarnessEnv(): HarnessEnv {
  const envPath = path.join(REPO_ROOT, '.env');
  const fromFile = existsSync(envPath) ? parseDotEnv(readFileSync(envPath, 'utf8')) : {};
  const merged: Record<string, string> = {};
  for (const [key, value] of Object.entries({ ...fromFile, ...process.env })) {
    if (value !== undefined) merged[key] = value;
  }

  const nodeEnv = merged['NODE_ENV'] ?? 'development';
  const databaseUrl = merged['DATABASE_URL'] ?? '';
  const redisUrl = rewriteRedisPort(merged['REDIS_URL'] ?? 'redis://localhost:6390');

  assertHarnessSafe(nodeEnv, databaseUrl, redisUrl);

  const apiEnv: NodeJS.ProcessEnv = {
    ...merged,
    NODE_ENV: nodeEnv,
    DATABASE_URL: databaseUrl,
    REDIS_URL: redisUrl,
  };
  const webEnv: NodeJS.ProcessEnv = {
    ...merged,
    NODE_ENV: 'production',
    DATABASE_URL: databaseUrl,
    REDIS_URL: redisUrl,
  };

  return { apiEnv, webEnv, databaseUrl, redisUrl, nodeEnv };
}

/** 把 Redis 连接串的端口强制改成本机实跑的 6390（保留其余部分不动）。 */
function rewriteRedisPort(raw: string): string {
  try {
    const url = new URL(raw);
    url.port = '6390';
    return url.toString();
  } catch {
    return 'redis://localhost:6390';
  }
}

/**
 * ⚠ 硬护栏：这个 harness 会 **删 Redis 键**（见 `flushRateLimitKeys`）。
 *
 * 删限流键本身是安全的（它只影响「短时间内还能请求几次」），但「对着生产 Redis
 * 删键」这件事的性质完全不同：一旦 `REDIS_URL` / `DATABASE_URL` 指向远端，
 * 这个动作就从「本机测试准备」变成了「对生产环境的写入」。
 *
 * 所以这里不是警告，是**拒绝运行**。判断标准刻意保守 —— 只认 `localhost` /
 * `127.0.0.1` / `::1`，其余一律当成生产。宁可让人手动改一行来跑，
 * 也不要让一次误配悄悄打到线上。
 */
function assertHarnessSafe(nodeEnv: string, databaseUrl: string, redisUrl: string): void {
  if (nodeEnv === 'production') {
    throw new Error(
      '[e2e] 拒绝运行：NODE_ENV=production。\n' +
        '这个 harness 会清空 Redis 里的限流键，绝不能指向生产环境。\n' +
        '请确认 .env 的 NODE_ENV 为 development。',
    );
  }

  const localHosts = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
  for (const [name, value] of [
    ['DATABASE_URL', databaseUrl],
    ['REDIS_URL', redisUrl],
  ] as const) {
    if (value === '') {
      throw new Error(`[e2e] 拒绝运行：${name} 为空 —— api 子进程会直接启动失败。`);
    }
    let host: string;
    try {
      host = new URL(value).hostname;
    } catch {
      throw new Error(`[e2e] 拒绝运行：${name} 不是合法连接串。`);
    }
    if (!localHosts.has(host)) {
      throw new Error(
        `[e2e] 拒绝运行：${name} 的 host 是 "${host}"，不是本机。\n` +
          '这个 harness 会清空 Redis 里的限流键 —— 它只能对着本机跑。\n' +
          '（若确实要连本机上的其他名字，请显式改这里的白名单。）',
      );
    }
  }
}

/* ------------------------------------------------------------------ */
/* 限流键                                                              */
/* ------------------------------------------------------------------ */

/**
 * 清掉 `ratelimit:auth:*`。
 *
 * ── 为什么必须做，以及为什么不能用「换个邮箱」绕过 ────────────────
 * 限流有两层：`otpRequestPerEmail = 3 次 / 600 秒` 和
 * `otpRequestPerIp = 10 次 / 3600 秒`。用例用**每次运行唯一**的邮箱，
 * 所以 per-email 那层自然规避掉了；但 per-IP 那层是按来源 IP 计数的，
 * 换邮箱一点用都没有 —— 连着跑第 11 次「发送验证码」就会拿到 429，
 * 表现为「点发送验证码没反应」，也就是一条**看似随机**的假红。
 *
 * 这种偶发红是最坏的一种：每次重跑都可能变绿，于是没人会去查。
 * 所以准备阶段直接把键删干净，让每次运行都从同一个确定的状态出发。
 *
 * 用仓库自己的 `ioredis`（api 的依赖），而不是新引一个 redis 客户端 ——
 * 多一个依赖就多一份与生产连接的语义差异（重连、TLS、序列化）。
 */
export async function flushRateLimitKeys(redisUrl: string): Promise<number> {
  // ioredis 是 api 的依赖，pnpm 严格模式下不在根 node_modules 里，
  // 所以从 apps/api 的解析上下文去 require。
  const { createRequire } = await import('node:module');
  const requireFromApi = createRequire(path.join(REPO_ROOT, 'apps', 'api', 'package.json'));
  const mod = requireFromApi('ioredis') as { default?: unknown } | unknown;
  const RedisCtor = ((mod as { default?: unknown }).default ?? mod) as new (
    url: string,
    options?: Record<string, unknown>,
  ) => {
    // ⚠ `args` 里必须收 `number`：ioredis 的 `SCAN` 允许 `COUNT 200`
    // 写成数字。写成 `string[]` 时 `tsc` 报 TS2345 —— 而这条错误
    // **在补上 `e2e/tsconfig.json` 之前谁也看不到**（`e2e/**` 不在任何
    // project 的 include 里）。这是那份 tsconfig 抓到的第一个真实错误。
    scan(cursor: string, ...args: (string | number)[]): Promise<[string, string[]]>;
    del(...keys: string[]): Promise<number>;
    quit(): Promise<'OK'>;
  };

  const client = new RedisCtor(redisUrl, { lazyConnect: false, maxRetriesPerRequest: 2 });
  try {
    const keys: string[] = [];
    let cursor = '0';
    do {
      const [next, batch] = await client.scan(cursor, 'MATCH', 'ratelimit:auth:*', 'COUNT', 200);
      cursor = next;
      keys.push(...batch);
    } while (cursor !== '0');

    if (keys.length === 0) return 0;
    return await client.del(...keys);
  } finally {
    await client.quit().catch(() => undefined);
  }
}

/* ------------------------------------------------------------------ */
/* 子进程台账                                                          */
/* ------------------------------------------------------------------ */

export function ensureArtifactsDir(): void {
  mkdirSync(ARTIFACTS_DIR, { recursive: true });
}

export function readState(): HarnessState | null {
  if (!existsSync(STATE_FILE)) return null;
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8')) as HarnessState;
  } catch {
    // 台账写坏了（比如上次进程被 SIGKILL 打断在写一半）→ 当作没有，
    // 而不是让整个 setup 崩在一个读不出来的 JSON 上。
    return null;
  }
}

export function writeState(state: HarnessState): void {
  ensureArtifactsDir();
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

export function clearState(): void {
  rmSync(STATE_FILE, { force: true });
}

/**
 * 杀一整棵进程树。
 *
 * ⚠ Windows 上 `process.kill(pid)` **不递归**：它只杀那一个进程，
 * 它派生的子进程（以及它们占着的端口）会变成孤儿继续跑。
 * 下一次运行就会撞上 `EADDRINUSE`，而报错信息里只有端口号、没有是谁占的。
 * 所以这里首选 `taskkill /T /F`（`/T` 才是「连同子树」）。
 *
 * 另：即使 `/T` 也不保证清干净 —— 所以 setup 里还有一道**端口占用检测**兜底，
 * 两处叠起来才算「真的收干净了」。
 */
export function killProcessTree(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* 已经没了 */
    }
  }
}

/** 打开一个追加写的 fd，供 `spawn` 的 stdio 用。 */
export function openLogFd(file: string): number {
  ensureArtifactsDir();
  return openSync(file, 'a');
}

export function closeLogFd(fd: number): void {
  try {
    closeSync(fd);
  } catch {
    /* 无所谓 */
  }
}

/* ------------------------------------------------------------------ */
/* 就绪探测                                                            */
/* ------------------------------------------------------------------ */

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** TCP 连得上就算端口被占。 */
export function isPortInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const done = (inUse: boolean): void => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(inUse);
    };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.setTimeout(1000, () => done(false));
  });
}

/** 谁占着这个端口（Windows 的 netstat），只为把报错写得更可操作。 */
export function describePortOwner(port: number): string {
  if (process.platform !== 'win32') return '';
  const result = spawnSync('netstat', ['-ano'], { encoding: 'utf8' });
  const lines = (result.stdout ?? '').split(/\r?\n/).filter((l) => l.includes(`:${String(port)} `));
  const pid = lines.map((l) => l.trim().split(/\s+/).pop() ?? '').find((p) => /^\d+$/.test(p));
  return pid === undefined ? '' : `（占用者 PID ${pid}，处置：taskkill /pid ${pid} /T /F）`;
}

/**
 * 轮询直到 HTTP 200。
 *
 * 用 200 而不是「端口通」：`/health/ready` 在依赖没起来时返回 **503**，
 * 端口却是通的。只看端口会让我们在 MySQL/Redis 还没连上时就开跑，
 * 然后用例挂在第一条断言上 —— 报错指向登录，真正的原因在基础设施。
 *
 * `expectOkStatus` 允许传一组「可以接受的状态码」：web 首页对 HEAD/GET
 * 都不该是 5xx，但没必要苛求 200（例如将来加了重定向）。
 */
export async function waitForHttpOk(
  url: string,
  options: { timeoutMs?: number; expectStatus?: number[]; label?: string } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 90_000;
  const expectStatus = options.expectStatus ?? [200];
  const label = options.label ?? url;
  const deadline = Date.now() + timeoutMs;
  let last = '（还没发出请求）';

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { redirect: 'manual' });
      if (expectStatus.includes(response.status)) return;
      last = `HTTP ${String(response.status)}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await delay(500);
  }

  throw new Error(
    `[e2e] 等待 ${label} 就绪超时（${String(timeoutMs)}ms）。最后一次结果：${last}\n` +
      `请查看日志：${API_STDERR_LOG} / ${WEB_STDERR_LOG}`,
  );
}

/* ------------------------------------------------------------------ */
/* 验证码                                                              */
/* ------------------------------------------------------------------ */

/**
 * 邮箱取**每次运行唯一**的值。
 *
 * ── 为什么不直接用种子用户 `admin@signal.local` ────────────────────
 * 两个理由，第二个是决定性的：
 * 1. 登录会 `findOrCreateByEmail` **自动建号**，用新邮箱不需要任何前置数据；
 * 2. 用固定邮箱会让 `otpRequestPerEmail`（3 次 / 600 秒）**跨运行累积** ——
 *    连跑第四次就 429。虽然 setup 清了 Redis 键，但「不依赖清理是否成功」
 *    显然是更好的性质：将来有人重构了清理逻辑，这条用例不该跟着塌。
 *
 * `.local` 域名与 `+` 都在校验范围内（`dto/auth.dto.ts` 的 EMAIL_PATTERN
 * 只要求 `x@y.z`，且会 trim + 小写）。
 */
export function uniqueEmail(): string {
  const stamp = Date.now().toString(36);
  const salt = Math.floor(Math.random() * 46_656).toString(36);
  return `e2e+${stamp}-${salt}@signal.local`;
}

/**
 * 从 API 日志里解析出某个邮箱的验证码。
 *
 * ── 为什么是读日志，而不是读库或调接口 ────────────────────────────
 * OTP 在库里是**哈希存储**的（`email_otp_codes.code_hash`）—— 读库拿不到明文，
 * 这是刻意的设计（`docs/14`）。接口也不会回显。唯一的明文来源是
 * `ConsoleMailSender`，它在 `NODE_ENV !== 'production'` 且未配 SMTP 时把验证码
 * 写到 **stderr**（刻意不走 pino，免得进结构化日志流）。
 *
 * 所以：setup 把子进程 stderr 重定向到文件，这里轮询那个文件。
 * 两个文件都扫（stdout + stderr）是刻意的冗余 —— 万一将来有人把
 * `process.stderr.write` 改成 `console.log`，这条用例不该静默地变成「拿不到验证码」。
 */
export async function readOtpCode(email: string, timeoutMs = 30_000): Promise<string> {
  const target = email.trim().toLowerCase();
  const pattern = /\[signal dev-mail\][^\n]*?to=(\S+) code=(\d{6})/g;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    for (const file of [API_STDERR_LOG, API_STDOUT_LOG]) {
      const text = readIfExists(file);
      // 取**最后**一条：同一邮箱若请求过多次，最新的那个才是有效的
      // （之前的可能已被消费或过期）。
      const hit = [...text.matchAll(pattern)].filter((m) => m[1]?.toLowerCase() === target).pop();
      if (hit?.[2] !== undefined) return hit[2];
    }
    await delay(200);
  }

  throw new Error(
    `[e2e] 等待 ${target} 的验证码超时（${String(timeoutMs)}ms）。\n` +
      `没有在 ${API_STDERR_LOG} / ${API_STDOUT_LOG} 里找到 ` +
      '`[signal dev-mail] to=… code=…`。\n' +
      '常见原因：api 子进程的 NODE_ENV 不是 development（ConsoleMailSender 会拒绝发信），\n' +
      '或者 api 根本没起来 —— 先看上面那个 stderr 日志。',
  );
}

function readIfExists(file: string): string {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

/* ------------------------------------------------------------------ */
/* 构建新鲜度                                                          */
/* ------------------------------------------------------------------ */

/**
 * ⚠ 校验「源码没有比构建产物更新」。
 *
 * ── 为什么值得专门写一段 ────────────────────────────────────────
 * 这条用例的全部价值在于**它会不会变红**。而 Playwright 跑的是
 * `next start`（读 `.next/`）与 `node dist/main.js`（读 `apps/api/dist/`）——
 * 都是**构建产物**。如果有人改了 `components/auth.tsx` 而没重建，
 * 跑出来的仍然是旧代码：用例**绿得毫无意义**。
 *
 * 这正好是「有牙齿」验证时的陷阱：把 `router.refresh()` 注释掉，忘了重建，
 * 用例照样绿，于是得出「这条用例没牙」的错误结论。
 *
 * 所以宁可在这里**硬失败**，也不要让一次静默的假绿浪费掉整轮验证。
 * 逃生舱：`E2E_SKIP_FRESHNESS_CHECK=1`。
 */
export function assertBuildFresh(): void {
  if (process.env['E2E_SKIP_FRESHNESS_CHECK'] === '1') return;

  const buildTime = (p: string): number => {
    try {
      return statSync(p).mtimeMs;
    } catch {
      return Number.NEGATIVE_INFINITY;
    }
  };

  const apiBuiltAt = maxMtime(path.join(REPO_ROOT, 'apps', 'api', 'dist'));
  const webBuiltAt = buildTime(path.join(REPO_ROOT, 'apps', 'web', '.next', 'BUILD_ID'));

  if (apiBuiltAt === Number.NEGATIVE_INFINITY) {
    throw new Error('[e2e] 缺少构建产物 apps/api/dist —— 先跑 `pnpm build`。');
  }
  if (webBuiltAt === Number.NEGATIVE_INFINITY) {
    throw new Error(
      '[e2e] 缺少构建产物 apps/web/.next —— 先跑 `pnpm --filter @signal/web build`。',
    );
  }

  /**
   * ⚠ 必须**按目标分别比对**，不能把两边取 min 一起比。
   *
   * 第一版就是取 `min(api构建时间, web构建时间)` 和「所有源码的最新时间」比 ——
   * 结果是：只改了 web 的一个文件、只重建了 web，最旧的 api 构建时间仍然
   * 早于那个文件，于是**误报**。
   * 这个误报本身很有教育意义：它说明「源码」与「产物」不是一张表，
   * 而是**两张各有各的对应关系的表**。
   *
   * 所以：api 产物只对 api 的源码负责，web 产物只对 web 的源码负责；
   * `packages/` 与 `prisma/` 两边都依赖（改了它们两个都得重建）。
   */
  const sharedRoots = [path.join(REPO_ROOT, 'packages'), path.join(REPO_ROOT, 'prisma')];
  const skipNoise = (p: string): boolean =>
    !p.includes(`${path.sep}node_modules${path.sep}`) && !p.includes(`${path.sep}dist${path.sep}`);

  const newestOf = (roots: string[]): { mtime: number; path: string } => {
    let best = { mtime: Number.NEGATIVE_INFINITY, path: '' };
    for (const root of roots) {
      let isDir: boolean;
      try {
        isDir = statSync(root).isDirectory();
      } catch {
        continue; // 路径不存在：由上面的「缺构建产物」分支负责报错，不在这里炸
      }
      const found = isDir
        ? maxMtimeWithPath(root, skipNoise)
        : { mtime: buildTime(root), path: root };
      if (found.mtime > best.mtime) best = found;
    }
    return best;
  };

  const apiNewest = newestOf([path.join(REPO_ROOT, 'apps', 'api', 'src'), ...sharedRoots]);
  const webNewest = newestOf([
    path.join(REPO_ROOT, 'apps', 'web', 'app'),
    path.join(REPO_ROOT, 'apps', 'web', 'components'),
    path.join(REPO_ROOT, 'apps', 'web', 'lib'),
    path.join(REPO_ROOT, 'apps', 'web', 'types'),
    path.join(REPO_ROOT, 'apps', 'web', 'next.config.mjs'),
    path.join(REPO_ROOT, 'apps', 'web', 'package.json'),
    ...sharedRoots,
  ]);

  const stale: string[] = [];
  if (apiNewest.mtime > apiBuiltAt) {
    stale.push(`  api: 最新的源码改动 ${apiNewest.path}（晚于 apps/api/dist）`);
  }
  if (webNewest.mtime > webBuiltAt) {
    stale.push(`  web: 最新的源码改动 ${webNewest.path}（晚于 apps/web/.next）`);
  }

  if (stale.length > 0) {
    throw new Error(
      '[e2e] 拒绝运行：源码比构建产物新，跑起来的是旧代码。\n' +
        `${stale.join('\n')}\n` +
        '  修复：pnpm build && pnpm --filter @signal/web build\n' +
        '  （若是刻意跳过，设 E2E_SKIP_FRESHNESS_CHECK=1）',
    );
  }
}

function maxMtime(dir: string): number {
  return maxMtimeWithPath(dir, () => true).mtime;
}

function maxMtimeWithPath(
  dir: string,
  accept: (p: string) => boolean,
): { mtime: number; path: string } {
  let best = { mtime: Number.NEGATIVE_INFINITY, path: '' };
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return best;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (!accept(full)) continue;
    if (entry.isDirectory()) {
      const nested = maxMtimeWithPath(full, accept);
      if (nested.mtime > best.mtime) best = nested;
    } else if (entry.isFile()) {
      const mtime = maxMtimeWithPath0(full);
      if (mtime > best.mtime) best = { mtime, path: full };
    }
  }
  return best;
}

function maxMtimeWithPath0(file: string): number {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return Number.NEGATIVE_INFINITY;
  }
}
