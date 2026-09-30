/**
 * Playwright globalTeardown —— 把 setup 起来的东西收掉。
 *
 * ⚠ Windows 上「收干净」比想象中难，这里做了两件不显然的事：
 *
 * 1. **用 `taskkill /T /F` 而不是 `process.kill(pid)`。
 *    后者不递归 —— `next start` 会派生 worker 子进程，杀掉父进程之后
 *    子进程还占着 3000 端口。下一次运行就会撞上 EADDRINUSE，
 *    而那个报错完全不指向真正的原因。**
 *
 * 2. **即使这里没跑成，下一轮也接得住。**
 *    这个函数只在 Playwright 正常退出时被调用。用例失败、超时、
 *    Ctrl-C —— 这些都是「不正常退出」，进程会活下来。
 *    所以 `global-setup.ts` 的第一步就是读台账收尸（见 `reapPreviousRun`）。
 *    两处叠起来，才敢说「重复运行是安全的」。
 */

import { clearState, killProcessTree, readState } from './helpers';

export default async function globalTeardown(): Promise<void> {
  const state = readState();
  if (state === null) return;

  console.log(
    `[e2e] 收尾：杀掉 api ${String(state.apiPid)} / web ${String(state.webPid)} 的进程树`,
  );
  killProcessTree(state.apiPid);
  killProcessTree(state.webPid);

  // 台账删掉，下一轮的 `reapPreviousRun` 就不会去杀两个已经不存在的 pid。
  clearState();
}
