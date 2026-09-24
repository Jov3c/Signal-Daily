/**
 * 适配器注册表 —— `SourceType` → 适配器。
 *
 * ── 为什么用一张显式的表而不是 if/else ──────────────────────────────
 * `SourceType` 是冻结枚举（`docs/05`），有 6 个值。用 `switch` 的话，
 * 将来枚举新增一个值而这里忘了加分支，TypeScript 只有在写
 * `const exhaustive: never` 时才会报错 —— 而那种写法很容易在
 * 「先跑起来再说」的压力下被绕过。
 *
 * 用 `Record<SourceType, CollectorAdapter>` 就不一样了：
 * **少一个键就编译不过**，没有任何绕过的写法。代价是必须在构造时
 * 提供全部 6 个适配器，这正是我们想要的。
 *
 * ── 未注册的类型不会静默跳过 ────────────────────────────────────────
 * 类型系统管不到运行期（数据可能来自旧版本或手工改库），
 * 因此 `adapterFor()` 在查不到时**抛错**而不是返回 null。
 *
 * 这个错误随后被 `CollectorService` 的 catch 收敛成一条
 * `SOURCE_FETCH_FAILED` 的失败结论（而不是让它冒到顶层变成堆栈）。
 * 取舍如下：库里出现一个没有适配器的 `SourceType`，既可能是代码缺陷，
 * 也可能是数据问题 —— 后者管理员自己能处理（停用那个来源），
 * 而让它以堆栈结束只会得到一个「任务崩了」的信号，
 * 后台的 `last_error_code` 反而是空的、无从下手。
 * 失败信息里带着完整的 `SourceType` 取值，日志里也有带 cause 的原异常，
 * 所以代码缺陷同样是可见的。
 */

import { SourceType } from '@signal/contracts';
import type { CollectorAdapter } from '../types';
import { GithubRepoCollectorAdapter } from './github-repo.adapter';
import { HackerNewsCollectorAdapter } from './hacker-news.adapter';
import { HuggingFaceCollectorAdapter } from './huggingface.adapter';
import { ManualUrlCollectorAdapter } from './manual-url.adapter';
import { RssCollectorAdapter } from './rss.adapter';
import { XUserCollectorAdapter } from './x-user.adapter';

export type AdapterRegistry = Readonly<Record<SourceType, CollectorAdapter>>;

/**
 * 构建默认注册表。
 *
 * 适配器是**无状态**的：网络依赖（`fetchImpl` / `lookup`）随
 * `CollectorContext` 逐次传入，所以这里不需要任何参数。
 * 测试注入 stub `fetch` 就能在**不联网**的前提下跑真实的解析与过滤逻辑
 * （与 Agent 03 的 `source-tester.ts` 同一手法）。
 */
export function createAdapterRegistry(): AdapterRegistry {
  return {
    [SourceType.RSS]: new RssCollectorAdapter(),
    [SourceType.X_USER]: new XUserCollectorAdapter(),
    [SourceType.GITHUB_REPO]: new GithubRepoCollectorAdapter(),
    [SourceType.HACKER_NEWS]: new HackerNewsCollectorAdapter(),
    [SourceType.HUGGINGFACE]: new HuggingFaceCollectorAdapter(),
    [SourceType.MANUAL_URL]: new ManualUrlCollectorAdapter(),
  };
}

/** 取适配器。查不到就抛 —— 见文件头。 */
export function adapterFor(registry: AdapterRegistry, type: SourceType): CollectorAdapter {
  const adapter = registry[type];
  if (adapter === undefined) {
    throw new Error(`No collector adapter is registered for SourceType ${String(type)}`);
  }
  return adapter;
}

export { GithubRepoCollectorAdapter } from './github-repo.adapter';
export { HackerNewsCollectorAdapter } from './hacker-news.adapter';
export { HuggingFaceCollectorAdapter } from './huggingface.adapter';
export { ManualUrlCollectorAdapter } from './manual-url.adapter';
export { RssCollectorAdapter } from './rss.adapter';
export { XUserCollectorAdapter } from './x-user.adapter';
export * from './http';
export * from './json';
export * from './config-read';
