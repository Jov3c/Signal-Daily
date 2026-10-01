#!/usr/bin/env node
/**
 * 清单 P2-06 —— 完整业务 Smoke（可重复执行版）。
 *
 * ── 它验证的链路 ────────────────────────────────────────────────────
 * ```text
 * Admin 登录 → 添加 RSS Source → Fetch → RawItem → Normalize → AI
 *   → Event / Evidence → Review → Featured → Daily → Publish → Public API
 *   → 用户登录 → Bookmark → Search
 * ```
 *
 * ── 三个关键判断（为什么是这样，而不是别的样子）──────────────────────
 *
 * 1. **用真实公网 RSS，不绕过采集。**
 *    SSRF 守卫（`packages/source-core/src/url-safety/`）会拒绝任何解析到
 *    内网/回环的地址，而它**在真 worker 进程里用的是真 `defaultDnsLookup`**
 *    （可注入的 DNS 只是单测接缝）。本机没有可被公网访问的地址，所以
 *    「受控本地 feed」在**不修改安全控制**的前提下不可能成立。
 *    清单同时明确「不要给 SSRF 守卫加逃生口」。
 *    于是取真实 feed（默认 `https://openai.com/news/rss.xml`），
 *    让「Source → Public」这条验收**真的走采集器**。
 *    代价：feed 内容不可控、可能变动 —— 见 README 的「已知不稳定点」。
 *    下游的可重复性由 **mock AI 注入的唯一 marker** 保证（不依赖 feed 内容）。
 *
 * 2. **跑在宿主上的 api + worker（开发模式），不是 docker 栈。**
 *    实测：docker 栈的 api 是 `NODE_ENV=production` 且未配 SMTP，
 *    `POST /auth/email/request-code` 直接返回 503 `AUTH_MAIL_NOT_CONFIGURED`
 *    —— **真实登录在 docker 栈上不可能发生**，而「Admin 登录 / 用户登录」
 *    是验收的一部分。宿主开发模式下 `ConsoleMailSender` 会把验证码写到
 *    **api 进程的 stderr**，本脚本正是从那里取码完成真实登录。
 *    （docker 栈全程不动。）
 *
 * 3. **用独立数据库 + 独立 Redis DB 序号做隔离。**
 *    数据落在 `SMOKE_DATABASE_URL`（默认 `signal_shadow` —— 本机 `signal`
 *    用户没有 CREATE DATABASE 权限，而 `signal` 是开发库，不该被冒烟污染）。
 *    Redis 用 `SMOKE_REDIS_URL` 里的 **DB 序号**（默认 `/5`）隔离队列。
 *    脚本**跑前清空、跑后清空**目标库，因此可重复执行、不留痕迹。
 *    ⚠ 安全闸：数据库名不含 `shadow`/`smoke`/`test` 时**拒绝运行**，
 *    除非显式 `--force-wipe`（防手滑把 `signal` 开发库清空）。
 *
 * 用法见 `scripts/smoke/README.md`。
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import { PrismaClient } from '@prisma/client';

/* ------------------------------------------------------------------ */
/* 参数与常量                                                          */
/* ------------------------------------------------------------------ */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const args = process.argv.slice(2);
const hasFlag = (name) => args.includes(`--${name}`);
const argValue = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at !== -1 && args[at + 1] !== undefined ? args[at + 1] : fallback;
};

if (hasFlag('help')) {
  process.stdout.write(
    [
      '用法: node scripts/smoke/run-smoke.mjs [选项]',
      '',
      '  --feed <url>        采集用的公网 RSS（默认 https://openai.com/news/rss.xml）',
      '  --skip-build        跳过 pnpm build（默认会先构建，保证 dist 是最新代码）',
      '  --keep              跑完不清库/不杀进程（调试用）',
      '  --skip-web          跳过 Next.js 页面渲染验证（默认会起 web:3100）',
      '  --force-wipe        允许对非 shadow/smoke/test 命名的库执行清空（危险）',
      '  --timeout <ms>      单步轮询超时（默认 180000）',
      '',
      '环境变量覆盖：',
      '  SMOKE_DATABASE_URL  默认 mysql://signal:signal@127.0.0.1:3306/signal_shadow',
      '  SMOKE_REDIS_URL     默认 redis://127.0.0.1:6390/5',
      '  SMOKE_API_PORT      默认 3001',
      '  SMOKE_MOCK_PORT     默认 3899',
      '',
    ].join('\n'),
  );
  process.exit(0);
}

const FEED_URL = argValue('feed', 'https://openai.com/news/rss.xml');
const SKIP_BUILD = hasFlag('skip-build');
const KEEP = hasFlag('keep');
const FORCE_WIPE = hasFlag('force-wipe');
const STEP_TIMEOUT_MS = Number(argValue('timeout', '180000'));
const SKIP_WEB = hasFlag('skip-web');
const API_PORT = Number(process.env.SMOKE_API_PORT ?? 3001);
const MOCK_PORT = Number(process.env.SMOKE_MOCK_PORT ?? 3899);
const WEB_PORT = Number(process.env.SMOKE_WEB_PORT ?? 3100);
const API_BASE = `http://127.0.0.1:${API_PORT}/api/v1`;
const API_ORIGIN = `http://127.0.0.1:${API_PORT}`;

/** 每次运行唯一的标签：用作 slug / marker / 邮箱本地部分，便于识别与清理。 */
const RUN_TAG = `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const MARKER = `zqx${RUN_TAG}`;
const SOURCE_SLUG = `smoke-rss-${RUN_TAG}`;
const ADMIN_EMAIL = 'admin@signal.local';
const USER_EMAIL = `smoke-user-${RUN_TAG}@signal.local`;

/** 仓库根 `.env` —— 缺省值的来源。CI/裸环境可能没有它。 */
function loadDotEnv() {
  const path = join(ROOT, '.env');
  const out = {};
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (match === null) continue;
    if (line.trim().startsWith('#')) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[match[1]] = value;
  }
  return out;
}

const dotenv = loadDotEnv();

const DB_URL =
  process.env.SMOKE_DATABASE_URL ??
  dotenv.SMOKE_DATABASE_URL ??
  'mysql://signal:signal@127.0.0.1:3306/signal_shadow';
const REDIS_URL =
  process.env.SMOKE_REDIS_URL ?? dotenv.SMOKE_REDIS_URL ?? 'redis://127.0.0.1:6390/5';

const DB_NAME = new URL(DB_URL).pathname.replace(/^\//, '');
const REDIS_DB = Number((new URL(REDIS_URL).pathname || '/0').replace(/^\//, '') || '0');

/* ------------------------------------------------------------------ */
/* 输出                                                                */
/* ------------------------------------------------------------------ */

const results = [];
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function say(line = '') {
  process.stdout.write(`${line}\n`);
}

async function step(name, fn) {
  say(`\n▶ ${name}`);
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail: detail ?? '' });
    say(`  ✔ ${detail ?? ''}`);
    return detail;
  } catch (error) {
    results.push({ name, ok: false, detail: error?.message ?? String(error) });
    say(`  ✘ ${error?.stack ?? error}`);
    throw error;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/** 失败时打印诊断（数据库快照 + 子进程日志尾部），在清库之前调用。 */
async function dumpDiagnostics(prisma) {
  say('\n──────── 诊断（失败时保留）────────');
  try {
    const content = await prisma.$queryRawUnsafe(
      'SELECT id, event_id, pipeline_status, final_score, LEFT(COALESCE(body_translated, ""), 60) AS body_translated FROM contents',
    );
    say(`contents: ${JSON.stringify(content, (k, v) => (typeof v === 'bigint' ? String(v) : v))}`);
    const runs = await prisma.$queryRawUnsafe(
      'SELECT id, content_id, task_type, status, provider, model, error_code, duration_ms FROM ai_runs',
    );
    say(`ai_runs: ${JSON.stringify(runs, (k, v) => (typeof v === 'bigint' ? String(v) : v))}`);
    const raw = await prisma.$queryRawUnsafe(
      'SELECT id, status, LEFT(CAST(payload AS CHAR), 120) AS payload FROM raw_items',
    );
    say(`raw_items: ${JSON.stringify(raw, (k, v) => (typeof v === 'bigint' ? String(v) : v))}`);
  } catch (error) {
    say(`  数据库快照失败：${error.message}`);
  }
  for (const record of children) {
    const tail = (record.stderr || '').split(/\r?\n/).slice(-25).join('\n');
    say(`\n--- ${record.label} stderr（尾部）---\n${tail}`);
  }
}

async function waitFor(fn, { timeoutMs = STEP_TIMEOUT_MS, intervalMs = 2000, desc }) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    last = await fn();
    if (last) return last;
    if (Date.now() > deadline) {
      throw new Error(`等待「${desc}」超时（${timeoutMs}ms）`);
    }
    await sleep(intervalMs);
  }
}

/* ------------------------------------------------------------------ */
/* 子进程管理                                                          */
/* ------------------------------------------------------------------ */

const children = [];

/** 端口是否空闲（用来在启动前发现残留进程）。 */
function isPortFree(port) {
  return new Promise((resolvePort) => {
    const server = net.createServer();
    server.once('error', () => resolvePort(false));
    server.once('listening', () => server.close(() => resolvePort(true)));
    server.listen(port, '127.0.0.1');
  });
}

function startChild(label, command, commandArgs, env, useShell = false) {
  const child = spawn(command, commandArgs, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    // ⚠ 默认不用 shell：`process.execPath` 在 Windows 上可能含空格，
    // 经 shell 拼接会被拆成两个参数。只有 pnpm 这类需要 PATHEXT 解析的才用 shell。
    shell: useShell,
  });
  const record = { label, child, stdout: '', stderr: '' };
  child.stdout.on('data', (chunk) => {
    record.stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    record.stderr += chunk.toString();
  });
  child.on('exit', (code, signal) => {
    record.exit = { code, signal };
  });
  children.push(record);
  return record;
}

async function stopChildren() {
  const isAlive = (record) => record.child.exitCode === null && record.child.signalCode === null;

  // ⚠ Windows：**先 taskkill 整棵树，不要先 SIGTERM**。
  //
  // `shell:true` 起 `pnpm … next dev` 时进程树是
  // `cmd.exe → pnpm.mjs → node(next dev)`，而 `record.child.pid` 只是 cmd.exe。
  // 先发 SIGTERM 会把 cmd.exe 打死、pnpm 与 next 被**孤儿化**，
  // 之后 taskkill 按那个已死的 pid 找树就找不到了 —— 实测残留过 next dev
  //（端口 3100 一直被占，下一次运行会被端口守卫拦住）。
  // 直接 `taskkill /T /F` 才能连子孙一起收。
  if (process.platform === 'win32') {
    for (const record of children) {
      if (record.child.pid !== undefined) {
        spawnSync('taskkill', ['/pid', String(record.child.pid), '/T', '/F'], { stdio: 'ignore' });
      }
    }
    await sleep(600);
    return;
  }

  for (const record of children) {
    if (isAlive(record)) record.child.kill('SIGTERM');
  }
  await sleep(1200);
  for (const record of children) {
    if (isAlive(record)) record.child.kill('SIGKILL');
  }
}

/* ------------------------------------------------------------------ */
/* HTTP 客户端（带 Cookie jar）                                        */
/* ------------------------------------------------------------------ */

class Session {
  constructor(base) {
    this.base = base;
    this.cookies = new Map();
  }

  async request(method, path, { body, rawBody } = {}) {
    const url = path.startsWith('http') ? path : `${this.base}${path}`;
    const headers = { accept: 'application/json' };
    if (this.cookies.size > 0) {
      headers.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    }
    let payload;
    if (rawBody !== undefined) payload = rawBody;
    else if (body !== undefined) {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(body);
    }

    const response = await fetch(url, { method, headers, body: payload });
    const setCookies =
      typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
    for (const raw of setCookies) {
      const pair = raw.split(';')[0];
      const eq = pair.indexOf('=');
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (value === '') this.cookies.delete(name);
      else this.cookies.set(name, value);
    }

    const text = await response.text();
    let json;
    try {
      json = text === '' ? null : JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: response.status, ok: response.ok, json, text, url };
  }

  expect(response, statuses, label) {
    const allowed = Array.isArray(statuses) ? statuses : [statuses];
    if (!allowed.includes(response.status)) {
      throw new Error(
        `${label} 期望 HTTP ${allowed.join('/')}，实际 ${response.status}：${response.text.slice(0, 400)}`,
      );
    }
    return response;
  }
}

/* ------------------------------------------------------------------ */
/* Redis（只用 RESP 发 SELECT + FLUSHDB，避免引入 ioredis 依赖）        */
/* ------------------------------------------------------------------ */

/**
 * 在**同一条连接**上依次执行若干条 RESP 命令。
 *
 * ⚠ 必须在同一条连接上：`FLUSHDB` 作用于当前连接选中的 DB，
 * 分成两条连接发（SELECT 一条、FLUSHDB 另一条）会去刷 **db 0**，
 * 而不是我们想隔离的那个序号 —— 那既清不干净、又可能误伤别人。
 */
function redisCommands(host, port, commands) {
  return new Promise((resolveCommand, rejectCommand) => {
    const socket = net.connect(port, host);
    let buffer = '';
    let replies = 0;
    socket.setTimeout(4000);

    const encode = (args) =>
      `*${args.length}\r\n${args
        .map((arg) => {
          const value = String(arg);
          return `$${Buffer.byteLength(value)}\r\n${value}\r\n`;
        })
        .join('')}`;

    socket.on('connect', () => socket.write(commands.map(encode).join('')));

    const consume = () => {
      while (buffer.includes('\r\n')) {
        const lineEnd = buffer.indexOf('\r\n');
        const line = buffer.slice(0, lineEnd);
        if (line.startsWith('-')) {
          socket.destroy();
          rejectCommand(new Error(`Redis error: ${line}`));
          return;
        }
        if (!line.startsWith('+') && !line.startsWith(':')) return; // 简单字符串/整数才处理
        buffer = buffer.slice(lineEnd + 2);
        replies += 1;
        if (replies >= commands.length) {
          socket.end();
          resolveCommand(true);
          return;
        }
      }
    };

    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      consume();
    });
    socket.on('timeout', () => {
      socket.destroy();
      rejectCommand(new Error('Redis command timed out'));
    });
    socket.on('error', rejectCommand);
  });
}

async function flushRedisDb() {
  const url = new URL(REDIS_URL);
  const port = Number(url.port || 6379);
  await redisCommands(url.hostname, port, [['SELECT', String(REDIS_DB)], ['FLUSHDB']]);
}

/* ------------------------------------------------------------------ */
/* 数据库清空                                                          */
/* ------------------------------------------------------------------ */

/** 依赖顺序（子表在前）。环（contents.event_id ↔ events）在本 schema 里不构成 FK 环。 */
const TABLES_IN_DELETE_ORDER = [
  'daily_items',
  'daily_sections',
  'daily_editions',
  'featured_items',
  'editorial_reviews',
  'content_topics',
  'bookmarks',
  'reading_progress',
  'event_evidence',
  'event_contents',
  'admin_notifications',
  'job_runs',
  'ai_runs',
  'contents',
  'events',
  'raw_items',
  'sources',
  'email_otp_codes',
  'sessions',
  'auth_accounts',
  'user_preferences',
  'users',
  'topics',
  'people',
];

async function wipeDatabase(prisma) {
  for (const table of TABLES_IN_DELETE_ORDER) {
    try {
      await prisma.$executeRawUnsafe(`DELETE FROM \`${table}\``);
    } catch (error) {
      throw new Error(`清空表 ${table} 失败：${error.message}`, { cause: error });
    }
  }
}

/* ------------------------------------------------------------------ */
/* api 日志里的 OTP 抓取                                               */
/* ------------------------------------------------------------------ */

let apiLog = '';

/** 请求验证码，然后从 api 的 stderr 里把刚打印出来的 6 位码取出来。 */
async function login(session, email, label) {
  const offset = apiLog.length;
  const response = await session.request('POST', '/auth/email/request-code', { body: { email } });
  session.expect(response, 200, `${label} 请求验证码`);

  const code = await waitFor(
    () => {
      const fresh = apiLog.slice(offset);
      const match = /\[signal dev-mail\][^\n]*code=(\d{6})/.exec(fresh);
      return match?.[1] ?? null;
    },
    { timeoutMs: 15000, intervalMs: 300, desc: `${label} 的验证码出现在 api stderr` },
  );

  const verify = await session.request('POST', '/auth/email/verify', {
    body: { email, code },
  });
  session.expect(verify, 200, `${label} 校验验证码`);

  const me = await session.request('GET', '/me');
  session.expect(me, 200, `${label} 读取 /me`);
  return { code, me: me.json?.data ?? me.json };
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

async function main() {
  say('Signal 完整业务 Smoke');
  say(`  repo         : ${ROOT}`);
  say(`  smoke DB     : ${DB_NAME} @ ${new URL(DB_URL).host}`);
  say(`  smoke redis  : ${new URL(REDIS_URL).host} db=${REDIS_DB}`);
  say(`  api          : ${API_BASE}`);
  say(`  feed         : ${FEED_URL}`);
  say(`  run tag      : ${RUN_TAG}`);

  // 安全闸：只允许清空「显然是冒烟/影子/测试」的库。
  if (!/shadow|smoke|test/i.test(DB_NAME) && !FORCE_WIPE) {
    throw new Error(
      `拒绝运行：目标库名「${DB_NAME}」不像一次性的冒烟库。` +
        '本脚本会清空该库。若确认无误，请加 --force-wipe，或把 SMOKE_DATABASE_URL 指向 signal_shadow。',
    );
  }

  /* ---- 0. 构建 ---- */
  if (!SKIP_BUILD) {
    await step(`构建（pnpm build）`, () => {
      // 传**单个字符串**给 shell：传 args 数组 + shell:true 会触发
      // DEP0190（参数不转义），而这里只是固定命令，没必要。
      const result = spawnSync('pnpm build', { cwd: ROOT, stdio: 'inherit', shell: true });
      assert(result.status === 0, `pnpm build 退出码 ${result.status}`);
      return '构建成功';
    });
  } else {
    say('\n▶ 构建：已跳过（--skip-build）');
  }

  const apiEntry = join(ROOT, 'apps', 'api', 'dist', 'main.js');
  const workerEntry = join(ROOT, 'apps', 'worker', 'dist', 'main.js');
  const seedEntry = join(ROOT, 'prisma', 'dist', 'seed.js');
  assert(existsSync(apiEntry), `缺少构建产物 ${apiEntry}（去掉 --skip-build 再跑一次）`);
  assert(existsSync(workerEntry), `缺少构建产物 ${workerEntry}`);
  assert(existsSync(seedEntry), `缺少 seed 产物 ${seedEntry}`);

  const prisma = new PrismaClient({ datasourceUrl: DB_URL });

  const childEnv = {
    ...dotenv,
    NODE_ENV: 'development', // 关键：让 ConsoleMailSender 生效（docker 栈是 production → 503）
    DATABASE_URL: DB_URL,
    REDIS_URL: REDIS_URL,
    LOG_LEVEL: 'info',
    APP_BASE_URL: 'http://localhost:3000',
    API_BASE_URL: API_ORIGIN + '/api',
    AI_DEFAULT_PROVIDER: 'openai-compatible',
    AI_DEFAULT_BASE_URL: `http://127.0.0.1:${MOCK_PORT}/v1`,
    AI_DEFAULT_API_KEY: 'smoke-key',
    AI_MODEL_CHEAP: 'smoke-cheap',
    AI_MODEL_MEDIUM: 'smoke-medium',
    AI_MODEL_STRONG: 'smoke-strong',
  };

  let api;
  let worker;

  try {
    /* ---- 1. 清库 + seed ---- */
    await step('清空冒烟库并执行官方 seed（admin + topics + 示例 sources）', async () => {
      await flushRedisDb();
      await wipeDatabase(prisma);
      const seed = spawnSync(process.execPath, [seedEntry], {
        cwd: ROOT,
        env: { ...process.env, DATABASE_URL: DB_URL },
        encoding: 'utf8',
      });
      assert(seed.status === 0, `seed 退出码 ${seed.status}: ${seed.stderr?.slice(0, 500)}`);
      const admin = await prisma.user.findUnique({ where: { email: ADMIN_EMAIL } });
      assert(admin !== null, 'seed 之后找不到 admin@signal.local');
      const topics = await prisma.topic.count();
      assert(topics > 0, 'seed 之后没有任何 topic');
      // 关掉 seed 的示例来源：否则 worker 的调度器（60s 一轮）会去抓它们，
      // 污染本次冒烟。冒烟库是一次性的，这个改动无需还原。
      await prisma.$executeRawUnsafe('UPDATE `sources` SET `enabled` = 0');
      return `admin id=${admin.id}，topics=${topics}，已禁用 ${await prisma.source.count()} 个 seed 来源`;
    });

    /* ---- 2. 启动 mock AI + worker + api ---- */
    await step('启动 mock AI provider / worker / api', async () => {
      // ⚠ 端口必须干净：曾经的调试进程留在 3899 上会让 worker 打到**旧的**
      // mock（marker 对不上），症状是「AI 明明成功、marker 却找不到」——
      // 2026-10-02 实际踩到过一次，所以这里 fail-fast。
      for (const [port, label] of [
        [MOCK_PORT, 'mock AI'],
        [API_PORT, 'api'],
      ]) {
        assert(
          await isPortFree(port),
          `端口 ${port}（${label}）已被占用 —— 可能残留了上一次的进程，请先清掉再跑`,
        );
      }

      startChild('mock-ai', process.execPath, ['scripts/smoke/mock-ai-provider.mjs'], {
        SMOKE_MOCK_PORT: String(MOCK_PORT),
        SMOKE_AI_MARKER: MARKER,
      });
      // 确认**本次**的 mock 在服务（而不是残留进程）：/health 必须回报本次 marker。
      await waitFor(
        async () => {
          try {
            const res = await fetch(`http://127.0.0.1:${MOCK_PORT}/health`);
            const body = await res.json();
            return body?.marker === MARKER;
          } catch {
            return false;
          }
        },
        { timeoutMs: 10000, intervalMs: 200, desc: 'mock AI /health 回报本次 marker' },
      );

      worker = startChild('worker', process.execPath, [workerEntry], childEnv);
      api = startChild('api', process.execPath, [apiEntry], childEnv);

      // 把 api 的 stderr 汇总到全局缓冲（登录要从中取验证码）。
      api.child.stderr.on('data', (chunk) => {
        apiLog += chunk.toString();
      });

      await waitFor(
        async () => {
          try {
            const res = await fetch(`${API_ORIGIN}/health/ready`);
            return res.ok;
          } catch {
            return false;
          }
        },
        { timeoutMs: 30000, intervalMs: 500, desc: 'api /health/ready' },
      );
      return `mock=127.0.0.1:${MOCK_PORT}（marker 已核对），api=${API_ORIGIN}，worker pid=${worker.child.pid}`;
    });

    /* ---- 3. Admin 登录 ---- */
    const adminSession = new Session(API_BASE);
    await step('Admin 登录（真实 Email OTP，验证码取自 api stderr）', async () => {
      const { me } = await login(adminSession, ADMIN_EMAIL, 'Admin');
      assert(me?.role === 'ADMIN', `期望 ADMIN，实际 role=${me?.role}`);
      return `role=${me.role} id=${me.id}`;
    });

    /* ---- 4. 创建 Source ---- */
    let sourceId;
    await step(`添加 RSS Source（${FEED_URL}）`, async () => {
      const response = await adminSession.request('POST', '/admin/sources', {
        body: {
          name: `Smoke RSS ${RUN_TAG}`,
          slug: SOURCE_SLUG,
          type: 'RSS',
          kind: 'MEDIA',
          tier: 'B',
          official: false,
          feedUrl: FEED_URL,
          language: 'en',
          priority: 10,
          trustScore: 5,
          fetchIntervalSeconds: 3600,
          // enabled=false：手动 fetch-now 仍可用（manual 不受 enabled 限制），
          // 但调度器不会自动抓它 —— 让这次冒烟只产生我们想要的一条链路。
          enabled: false,
          config: { maxItems: 1 },
        },
      });
      adminSession.expect(response, 201, '创建 Source');
      sourceId = response.json?.data?.id;
      assert(typeof sourceId === 'string', `响应里没有 source id：${response.text.slice(0, 300)}`);
      return `sourceId=${sourceId} slug=${SOURCE_SLUG}（maxItems=1，enabled=false）`;
    });

    /* ---- 5. Fetch → RawItem ---- */
    let rawItemId;
    await step('触发 Fetch（POST /admin/sources/:id/fetch-now）→ 等待 RawItem 落库', async () => {
      const response = await adminSession.request('POST', `/admin/sources/${sourceId}/fetch-now`);
      adminSession.expect(response, 202, '触发采集');
      const raw = await waitFor(
        () =>
          prisma.rawItem.findFirst({
            where: { sourceId: BigInt(sourceId) },
            orderBy: { id: 'asc' },
          }),
        { timeoutMs: 90000, desc: 'RawItem 落库' },
      );
      rawItemId = raw.id;
      return `rawItemId=${raw.id}，status=${raw.status}，bodyChars=${raw.bodyRaw?.length ?? 0}`;
    });

    /* ---- 6. Normalize → Content ---- */
    let contentId;
    let contentTitle;
    let eventId;
    await step('Normalize → Content（worker 消费者）', async () => {
      const content = await waitFor(
        () => prisma.content.findFirst({ where: { rawItemId }, orderBy: { id: 'asc' } }),
        { timeoutMs: 90000, desc: 'Content 落库' },
      );
      contentId = content.id;
      contentTitle = content.title;
      return `contentId=${content.id} title=${JSON.stringify(content.title).slice(0, 80)}`;
    });

    /* ---- 7. Event / Evidence + AI ---- */
    await step('Event / Evidence 写入 + AI（mock provider）评分与翻译落库', async () => {
      const withEvent = await waitFor(
        async () => {
          const row = await prisma.content.findUnique({ where: { id: contentId } });
          return row?.eventId ? row : null;
        },
        { timeoutMs: 120000, desc: 'Content 挂到 Event' },
      );
      eventId = withEvent.eventId;

      const evidence = await waitFor(
        async () => {
          const rows = await prisma.eventEvidence.findMany({ where: { eventId } });
          return rows.length > 0 ? rows : null;
        },
        { timeoutMs: 60000, desc: 'Event Evidence 落库' },
      );

      const translated = await waitFor(
        async () => {
          const row = await prisma.content.findUnique({ where: { id: contentId } });
          return row?.bodyTranslated?.includes(MARKER) ? row : null;
        },
        { timeoutMs: 120000, desc: 'AI 译文落库（含 marker）' },
      );
      const scored = await prisma.content.findUnique({ where: { id: contentId } });
      assert(scored?.finalScore !== null && scored?.finalScore !== undefined, 'AI 分数没有落库');
      const aiRuns = await prisma.aiRun.count({ where: { contentId } });
      assert(aiRuns >= 2, `期望至少 2 条 ai_runs（translate + score），实际 ${aiRuns}`);
      return `eventId=${eventId}，evidence=${evidence.length} 条，ai_runs=${aiRuns}，finalScore=${scored.finalScore}，bodyTranslated 含 marker=${translated.bodyTranslated.includes(MARKER)}`;
    });

    /* ---- 8. Review（等待收尾扫描建审核行，再人工决策）---- */
    await step('人工审核：等待 REVIEW_PENDING → APPROVE_BOTH', async () => {
      const pending = await waitFor(
        async () => {
          const row = await prisma.content.findUnique({ where: { id: contentId } });
          return row?.pipelineStatus === 'REVIEW_PENDING' ? row : null;
        },
        // 收尾扫描是 60s 一轮的定时器（content/module.ts REVIEW_SWEEP_INTERVAL_MS）。
        { timeoutMs: 180000, desc: '内容进入 REVIEW_PENDING（收尾扫描 60s 一轮）' },
      );
      assert(pending !== null, '内容没有进入 REVIEW_PENDING');

      const queue = await adminSession.request('GET', '/admin/review?pageSize=50');
      adminSession.expect(queue, 200, '读取审核队列');
      const inQueue = (queue.json?.data ?? []).some((row) => row.contentId === String(contentId));
      assert(inQueue, `审核队列里没有 contentId=${contentId}`);

      const decision = await adminSession.request('POST', `/admin/review/${contentId}/decision`, {
        body: { action: 'APPROVE_BOTH', note: `smoke ${RUN_TAG}` },
      });
      adminSession.expect(decision, 200, '审核决策');
      assert(decision.json?.data?.pipelineStatus === 'APPROVED', '决策后内容不是 APPROVED');
      return `pipelineStatus=APPROVED，reviewStatus=${decision.json?.data?.reviewStatus}`;
    });

    /* ---- 9. Featured ---- */
    let businessDate;
    await step('Featured：加入精选 + 公开接口可见', async () => {
      const created = await adminSession.request('POST', '/admin/featured', {
        body: {
          contentId: String(contentId),
          customTitle: `Smoke 精选 ${RUN_TAG}`,
          sortWeight: 100,
        },
      });
      adminSession.expect(created, 201, '加入精选');

      const publicList = await adminSession.request('GET', '/featured?limit=50');
      adminSession.expect(publicList, 200, '公开精选列表');
      const found = (publicList.json?.data ?? []).some(
        (row) => String(row.contentId) === String(contentId),
      );
      assert(found, '公开 /featured 里没有这条内容');
      return 'featured_items 已写入，且 GET /featured 能读到';
    });

    /* ---- 10. Daily：建草稿 → 编辑 → 排期 → 发布 ---- */
    await step('Daily：排期并发布当日一期 + 公开接口可见', async () => {
      businessDate = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(new Date());

      // 打开编辑台即惰性补建草稿（daily/service.ts detail()）。
      const detail = await adminSession.request('GET', `/admin/daily/${businessDate}`);
      adminSession.expect(detail, 200, '读取日报详情（补建草稿）');

      const sections = await adminSession.request('PUT', `/admin/daily/${businessDate}/sections`, {
        body: {
          headline: `Smoke 日报 ${RUN_TAG}`,
          sections: [
            {
              type: 'AI',
              title: '冒烟测试版块',
              sortOrder: 0,
              items: [
                {
                  contentId: String(contentId),
                  displayStyle: 'LEAD', // 发布预检要求恰好一条 LEAD
                  sortOrder: 0,
                  customHeadline: null,
                  customExcerpt: null,
                },
              ],
            },
          ],
        },
      });
      adminSession.expect(sections, 200, '写入日报版块');

      const scheduled = await adminSession.request('POST', `/admin/daily/${businessDate}/schedule`);
      adminSession.expect(scheduled, 200, '排期');
      assert(scheduled.json?.data?.status === 'SCHEDULED', '排期后状态不是 SCHEDULED');

      const published = await adminSession.request('POST', `/admin/daily/${businessDate}/publish`);
      adminSession.expect(published, 200, '发布日报');
      assert(
        published.json?.data?.edition?.status === 'PUBLISHED',
        `发布后状态不是 PUBLISHED：${published.text.slice(0, 300)}`,
      );

      const publicDaily = await adminSession.request('GET', `/daily/${businessDate}`);
      adminSession.expect(publicDaily, 200, '公开日报接口');
      return `businessDate=${businessDate}，editionNo=${published.json?.data?.editionNoLabel}，公开 /daily/${businessDate} 可读`;
    });

    /* ---- 11. Public API + Search ---- */
    await step('Public API：/contents/:id 可见 + Search 能搜到（FULLTEXT）', async () => {
      const detail = await adminSession.request('GET', `/contents/${contentId}`);
      adminSession.expect(detail, 200, '公开内容详情');
      assert(detail.json?.data?.id === String(contentId), '公开内容详情 id 不匹配');

      const search = await adminSession.request('GET', `/search?q=${encodeURIComponent(MARKER)}`);
      adminSession.expect(search, 200, '搜索');
      const rows = search.json?.data ?? [];
      const hit = rows.some((row) => String(row.id) === String(contentId));
      assert(hit, `搜索「${MARKER}」没有命中 contentId=${contentId}（返回 ${rows.length} 条）`);
      return `GET /contents/${contentId} 可读；GET /search?q=${MARKER} 命中（${rows.length} 条）`;
    });

    /* ---- 12. 用户登录 + Bookmark ---- */
    await step('用户登录（新用户 OTP）→ 收藏落库', async () => {
      const userSession = new Session(API_BASE);
      const { me } = await login(userSession, USER_EMAIL, 'Smoke 用户');
      assert(me?.email?.toLowerCase() === USER_EMAIL, `用户邮箱不匹配：${me?.email}`);
      const userId = me.id;

      const added = await userSession.request('POST', `/bookmarks/${contentId}`);
      userSession.expect(added, 200, '加收藏');

      const row = await prisma.bookmark.findFirst({
        where: { userId: BigInt(userId), contentId },
      });
      assert(row !== null, 'bookmarks 表里没有这条收藏');

      const list = await userSession.request('GET', '/bookmarks');
      userSession.expect(list, 200, '读取收藏列表');
      return `userId=${userId}，bookmarks 已落库（createdAt=${row.createdAt.toISOString()}）`;
    });

    /* ---- 13. Web：真实渲染已发布内容 ---- */
    if (SKIP_WEB) {
      say('\n▶ Web 渲染：已跳过（--skip-web）');
      results.push({ name: 'Web（Next.js）渲染', ok: true, detail: '已跳过（--skip-web）' });
    } else {
      await step(`Web（Next.js）渲染 /article/${contentId}`, async () => {
        assert(await isPortFree(WEB_PORT), `端口 ${WEB_PORT} 被占用（web）`);
        startChild(
          'web',
          `pnpm --filter @signal/web exec next dev -p ${WEB_PORT}`,
          [],
          { API_BASE_URL: `${API_ORIGIN}/api`, NODE_ENV: 'development' },
          true, // pnpm 需要 shell 解析
        );

        // Next dev 首次请求要现场编译，慢是正常的。
        await waitFor(
          async () => {
            try {
              const res = await fetch(`http://127.0.0.1:${WEB_PORT}/article/${contentId}`);
              return res.status > 0;
            } catch {
              return false;
            }
          },
          { timeoutMs: 150000, intervalMs: 1500, desc: 'web（next dev）起来' },
        );

        const res = await fetch(`http://127.0.0.1:${WEB_PORT}/article/${contentId}`);
        assert(res.status === 200, `网页 /article/${contentId} 返回 ${res.status}`);
        const html = await res.text();
        const hasMarker = html.includes(MARKER);
        const hasTitle = contentTitle !== '' && html.includes(contentTitle);
        assert(
          hasMarker || hasTitle,
          '网页 HTML 里既没有原文标题也没有翻译 marker —— 说明前端没有真正渲染这条内容',
        );
        return `GET /article/${contentId} 200；HTML 含译文 marker=${hasMarker}，含标题=${hasTitle}`;
      });
    }

    say('\n全部步骤通过。');
  } finally {
    if (KEEP) {
      say('\n（--keep：保留进程与数据，自行清理）');
    } else {
      // 失败时先留证据再清库 —— 否则「为什么失败」随清理一起消失。
      if (results.some((row) => !row.ok)) {
        await dumpDiagnostics(prisma);
      }
      say('\n清理中…');
      await stopChildren();
      try {
        await flushRedisDb();
      } catch (error) {
        say(`  ⚠ Redis 清理失败：${error.message}`);
      }
      try {
        await wipeDatabase(prisma);
        say('  冒烟库已清空');
      } catch (error) {
        say(`  ⚠ 数据库清理失败：${error.message}`);
      }
      say('  进程已停止');
    }
    await prisma.$disconnect().catch(() => undefined);
  }

  /* ---- 汇总 ---- */
  const failed = results.filter((row) => !row.ok);
  say('\n──────── 结果汇总 ────────');
  for (const row of results) {
    say(`${row.ok ? '✔' : '✘'} ${row.name}${row.detail ? `  — ${row.detail}` : ''}`);
  }
  say(`\n共 ${results.length} 步，失败 ${failed.length} 步。`);
  if (failed.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  say(`\n冒烟失败：${error?.stack ?? error}`);
  process.exitCode = 1;
});
