/**
 * `ContentType` 的推导。
 *
 * ── 为什么是「推导」而不是「读出来」────────────────────────────────
 * 采集端的 `CollectedItem` **有**一个 `type: ContentType` 字段
 * （`jobs/collectors/types.ts`，注释写着「建议的内容类型，供 Pipeline 使用」），
 * 六个适配器也都老老实实填了（`ARTICLE` / `X_POST` / `GITHUB_RELEASE`…）。
 *
 * **但它没有落库。** `raw_items` 表没有 type 列（Agent 01 的 schema），
 * `NewRawItem`（采集端的落库端口）没有这个字段，
 * `prisma-raw-item.repository.ts` 的 `createMany` 也没写它 ——
 * 这个字段在持久化那一步被静默丢掉了。
 *
 * 我不能加列（§10：改 schema 属 Agent 01），所以只能在 Normalize 侧
 * **按同样的规则重推一遍**。规则本身是确定的、纯函数的，
 * 重推没有任何信息损失 —— 代价只是「两处实现可能漂移」。
 *
 * ⚠ **已记入 HANDOFF**：更干净的做法是让 `raw_items` 存下采集端算好的类型，
 * 或把这份推导提到共享包。在裁决前，本文件是与适配器**逐条对齐**的唯一定义，
 * 改动它之前请先读 `adapters/*.adapter.ts` 里各自填的 `type`。
 */

import { ContentType, SourceType } from '@signal/contracts';

/**
 * 无歧义的映射：一个 `SourceType` 只对应一个 `ContentType`。
 *
 * 用 `Record<SourceType, …>` 而不是 `switch`：契约新增来源类型时
 * 这里会**编译不过**，而不是在运行期悄悄落进某个 default 分支。
 */
const UNAMBIGUOUS: Readonly<Record<Exclude<SourceType, SourceType.GITHUB_REPO>, ContentType>> = {
  [SourceType.RSS]: ContentType.ARTICLE,
  [SourceType.X_USER]: ContentType.X_POST,
  [SourceType.HACKER_NEWS]: ContentType.HN_STORY,
  [SourceType.HUGGINGFACE]: ContentType.MODEL,
  // 管理员手工给的 URL 就是一篇文章（`manual-url.adapter.ts:87` 同此）。
  [SourceType.MANUAL_URL]: ContentType.ARTICLE,
};

/**
 * 推导内容类型。
 *
 * **`GITHUB_REPO` 需要看 payload**：同一个来源既可能在抓 Release，
 * 也可能在抓仓库本身。适配器用「这一条是不是 Release」来区分
 * （`github-repo.adapter.ts`：Release 分支填 `tagName`，
 * 仓库分支不填），所以判据就是 `payload.tagName` 是不是一个非空字符串。
 *
 * 取不到 payload 时按 `GITHUB_REPO`（仓库本身）处理 —— 这是更保守的一侧：
 * 把一个 Release 当仓库展示，损失的只是「版本号」这一层语义；
 * 反过来把一个仓库当 Release 展示，会凭空造出一个不存在的版本。
 */
export function deriveContentType(
  sourceType: SourceType,
  payload: Record<string, unknown> | null | undefined,
): ContentType {
  if (sourceType === SourceType.GITHUB_REPO) {
    const tag = payload?.['tagName'];
    return typeof tag === 'string' && tag.trim() !== ''
      ? ContentType.GITHUB_RELEASE
      : ContentType.GITHUB_REPO;
  }

  const direct = UNAMBIGUOUS[sourceType as Exclude<SourceType, SourceType.GITHUB_REPO>];
  if (direct === undefined) {
    // 契约新增了 SourceType 但没在这里登记 —— 抛错而不是猜。
    throw new Error(`No ContentType rule is declared for SourceType ${String(sourceType)}`);
  }
  return direct;
}
