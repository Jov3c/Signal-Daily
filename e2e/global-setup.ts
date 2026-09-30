/**
 * Playwright globalSetup —— 把整条开发形态**起起来**。
 *
 * 顺序是有理由的，每一步都在防一类具体的失败：
 *
 * ```text
 * 1. 安全护栏             —— 拒绝打到非本机的 DB/Redis（这个 harness 会删 Redis 键）
 * 2. 收上一轮的尸体        —— 上次被 Ctrl-C / 超时打断时 teardown 不会跑
 * 3. 构建新鲜度            —— 跑的是 dist/.next，源码更新了就必须重建，否则假绿
 * 4. 清限流键             —— per-IP 限流 10 次 / 3600 秒，不清就会偶发假红
 * 5. 端口占用检测          —— 前面收干净了才继续，否则报错要能指向具体 PID
 * 6. 起 api（stderr 落文件）—— 验证码只能从那里拿
 * 7. 起 web（next start）  —— 读的是构建产物，也就是第 3 步校验过的那份
 * 8. 等 /health/ready 与首页 —— 200 才算就绪（503 说明 MySQL/Redis 没连上）
 * 9. 写台账               —— teardown 与用例都靠它定位进程与日志
 * ```
 *
 * ⚠ 这里**不做构建**。理由是构建是分钟级的，而用例是秒级的 ——
 * 把它们捆在一起会让每次迭代都付一遍构建的代价，最后没人愿意跑这个测试。
 * 代价是「必须先构建」，所以第 3 步把它变成一个**明确的报错**而不是一次静默的假绿。
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import {
  API_ORIGIN,
  API_STDERR_LOG,
  API_STDOUT_LOG,
  REPO_ROOT,
  WEB_BASE_URL,
  WEB_PORT,
  WEB_STDERR_LOG,
  WEB_STDOUT_LOG,
  assertBuildFresh,
  clearState,
  closeLogFd,
  describePortOwner,
  ensureArtifactsDir,
  flushRateLimitKeys,
  isPortInUse,
  killProcessTree,
  loadHarnessEnv,
  openLogFd,
  readState,
  waitForHttpOk,
  writeState,
} from './helpers';

export default async function globalSetup(): Promise<void> {
  const env = loadHarnessEnv();
  console.log(
    `[e2e] 环境：NODE_ENV=${env.nodeEnv} · DB=${redact(env.databaseUrl)} · Redis=${redact(env.redisUrl)}`,
  );

  await reapPreviousRun();
  assertBuildFresh();
  await flushRateLimitKeys(env.redisUrl).then((removed) => {
    console.log(`[e2e] 已清空 Redis 限流键：ratelimit:auth:*（删除 ${String(removed)} 个）`);
  });

  ensureArtifactsDir();
  await assertPortFree(WEB_PORT, 'web');

  const apiPid = startApi(env.apiEnv);
  const webPid = startWeb(env.webEnv);
  writeState({ apiPid, webPid, startedAt: new Date().toISOString() });

  try {
    // ⚠ `/health/ready` **不在** `/api/v1` 下（`bootstrap.ts` 用 setGlobalPrefix
    // 的 exclude 把它摘出来了）。打成 `/api/v1/health/ready` 会 404，
    // 而「404」与「没起来」在这里长得一模一样 —— 会浪费掉半小时。
    await waitForHttpOk(`${API_ORIGIN}/health/ready`, { label: 'api /health/ready' });
    // 首页用 expectStatus 放宽到 2xx/3xx：这里只关心「Next 起来了」，
    // 首页具体返回什么由前端负责，不该让 harness 也跟着它变。
    await waitForHttpOk(WEB_BASE_URL, {
      label: 'web 首页',
      expectStatus: [200, 301, 302, 307, 308],
    });
  } catch (error) {
    // 起不来就把尸体收掉，免得留下两个占着端口的孤儿进程，
    // 让下一次运行以一个完全无关的 EADDRINUSE 报错开始。
    killProcessTree(apiPid);
    killProcessTree(webPid);
    clearState();
    throw error;
  }

  console.log(
    `[e2e] 就绪：web ${WEB_BASE_URL} · api ${API_ORIGIN}（pid ${String(apiPid)}/${String(webPid)}）`,
  );
}

/**
 * 收掉上一轮留下的进程。
 *
 * `globalTeardown` 只在**正常退出**时运行。超时、Ctrl-C、断言失败后 Playwright
 * 进程被强杀 —— 这些情况下子进程会活下来，占着 3000/3001。
 * 没有这一步，第二次运行会以一堵 EADDRINUSE 的墙开场，而墙上的字
 *（「端口被占用」）完全不指向真正的原因（上一轮没收干净）。
 */
async function reapPreviousRun(): Promise<void> {
  const previous = readState();
  if (previous === null) return;

  console.log(
    `[e2e] 发现上一轮遗留的进程，先收掉（api ${String(previous.apiPid)} / web ${String(previous.webPid)}）`,
  );
  killProcessTree(previous.apiPid);
  killProcessTree(previous.webPid);
  clearState();
  // taskkill /F 是同步生效的，但端口释放有一点点延迟。
  await new Promise((resolve) => setTimeout(resolve, 500));
}

async function assertPortFree(port: number, label: string): Promise<void> {
  if (!(await isPortInUse(port))) return;
  throw new Error(
    `[e2e] 拒绝运行：${label} 端口 ${String(port)} 已被占用${describePortOwner(port)}。\n` +
      '这个 harness 需要自己起服务（否则测的可能是一份来路不明的构建产物）。\n' +
      '请先停掉占用者，或确认没有上一轮的残留进程。',
  );
}

/**
 * 起 API。
 *
 * ⚠ 必须让 api 独占 3001：`apps/web/next.config.mjs` 的 rewrite 目标在
 * **build 时**就写死成了 `http://127.0.0.1:3001/api`。api 换个端口，
 * `/api/*` 就会静默 502 —— 正好是 A 类缺陷的翻版。
 *
 * ⚠ stderr 落文件是**功能性的**，不是图方便：验证码唯一的明文出口就是
 * `ConsoleMailSender` 的 `process.stderr.write`。把它丢进终端就等于丢掉了
 * 唯一能拿到验证码的通道。
 */
function startApi(env: NodeJS.ProcessEnv): number {
  const outFd = openLogFd(API_STDOUT_LOG);
  const errFd = openLogFd(API_STDERR_LOG);
  const child = spawn(process.execPath, [path.join(REPO_ROOT, 'apps', 'api', 'dist', 'main.js')], {
    cwd: REPO_ROOT,
    env,
    stdio: ['ignore', outFd, errFd],
    windowsHide: true,
  });
  closeLogFd(outFd);
  closeLogFd(errFd);
  if (child.pid === undefined) throw new Error('[e2e] api 子进程没有拿到 pid');
  return child.pid;
}

/**
 * 起 Web。
 *
 * ⚠ 直接 `node apps/web/node_modules/next/dist/bin/next start`，而不是
 * `pnpm --filter @signal/web start`。
 * 后者会派生一棵 `pnpm → node → next` 的树：teardown 时多杀少杀一层都会出问题，
 * 而 Windows 上「杀不干净」的表现是下一轮 EADDRINUSE。
 * 直接起 node 就只有一层，`taskkill /T /F` 稳。
 *
 * `next start` 的阶段解析走 `apps/web/(site)/...` 与 `apps/web/node_modules`，
 * 所以 cwd 必须是 `apps/web` —— 那是 Next 认定的「项目根」。
 */
function startWeb(env: NodeJS.ProcessEnv): number {
  const outFd = openLogFd(WEB_STDOUT_LOG);
  const errFd = openLogFd(WEB_STDERR_LOG);
  const nextBin = path.join(
    REPO_ROOT,
    'apps',
    'web',
    'node_modules',
    'next',
    'dist',
    'bin',
    'next',
  );
  const child = spawn(process.execPath, [nextBin, 'start', '-p', String(WEB_PORT)], {
    cwd: path.join(REPO_ROOT, 'apps', 'web'),
    env,
    stdio: ['ignore', outFd, errFd],
    windowsHide: true,
  });
  closeLogFd(outFd);
  closeLogFd(errFd);
  if (child.pid === undefined) throw new Error('[e2e] web 子进程没有拿到 pid');
  return child.pid;
}

/** 日志里不要把连接串的密码打出来。 */
function redact(url: string): string {
  return url.replace(/\/\/[^/@]*@/, '//***@');
}
