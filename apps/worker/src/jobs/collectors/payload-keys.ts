/**
 * `RawItem.payload` 的**形状白名单**。
 *
 * ── 为什么从「黑名单」改成「白名单」（这是一次 P0 缺陷的修复）──────
 * `tasks/agent-04-collectors.md` 要求：
 *
 * > Source tier/kind/official **不复制到 Raw payload 作为事实源**，
 * > 处理时通过 Source 关联读取。
 *
 * 最初的实现是一条**键名黑名单**：`['tier','kind','official','trustScore',…]`，
 * 命中即抛错。它有牙齿（反证能变红），但牙齿朝错了方向：
 *
 * - **误杀**：X 适配器用 `payload.kind` 记录「这条推文的引用关系」
 *   （`original` / `quoted` / `replied_to` / `retweeted`），与
 *   `Source.kind`（`PERSON` / `OFFICIAL` / `MEDIA`）**只是撞名**。
 *   于是每一条推文都在落库前抛错 → **`SourceType.X_USER` 整体不可用**，
 *   0 条入库。而适配器测试断言 `payload['kind']` 存在、守卫测试断言
 *   `kind` 必须被拒 —— 两条互相矛盾的断言从来没有同时执行过。
 * - **漏网**：黑名单只查顶层键，`source_kind` / 嵌套 `{source:{tier:'S'}}`
 *   都能绕过去。
 *
 * 白名单同时解决这两件事：每个 `SourceType` 显式声明它允许写哪些键，
 * 于是「撞名」不可能发生（键名在该类型下要么被声明、要么被拒），
 * 而任何**新增**的键都必须在契约表里登记 —— 包括想偷偷塞 `tier` 的人。
 *
 * ── 维护方式 ────────────────────────────────────────────────────────
 * 适配器新增一个 payload 键时，**必须**同时在下面的表里登记。
 * 忘了登记的表现是该来源整体采集失败（一条可见的、指向具体键名的错误），
 * 而不是静默多写一个字段 —— 后者才是真正危险的方向。
 *
 * ⚠ Source 侧的 `kind` / `tier` / `official` / `trustScore` / `priority`
 * 在任何类型下都**不允许**出现在这里。它们会变（`docs/22`：Tier 由管理员维护），
 * 写进 RawItem 就等于固化一份会过期的历史快照。
 */

import { SourceType } from '@signal/contracts';

/**
 * 每个 `SourceType` 允许出现在 `RawItem.payload` 里的键。
 *
 * 只放**源侧事实**：来源自己给出的、不会因为 Signal 的编辑配置变化而变的东西。
 */
export const ALLOWED_PAYLOAD_KEYS: Readonly<Record<SourceType, readonly string[]>> = {
  /** RSS / Atom / RSS 1.0：只留它是什么格式。 */
  [SourceType.RSS]: ['feedFormat'],

  /**
   * X 白名单账号。
   *
   * `postKind` 是**推文的引用关系**（`original` / `quoted` / `replied_to` /
   * `retweeted`），刻意取一个不会与 `Source.kind` 撞名的名字 ——
   * 曾经的 `kind` 撞名让整种来源不可用（见文件头）。
   */
  [SourceType.X_USER]: [
    'tweetId',
    'postKind',
    'conversationId',
    'quotedTweetId',
    'likeCount',
    'replyCount',
    'repostCount',
    'quoteCount',
  ],

  [SourceType.GITHUB_REPO]: ['repo', 'tagName', 'prerelease', 'stars', 'homepage'],

  [SourceType.HACKER_NEWS]: ['hnId', 'hnUrl', 'score', 'comments', 'feed', 'selfPost'],

  [SourceType.HUGGINGFACE]: ['repoId', 'repoType', 'commitId', 'repoUrl'],

  [SourceType.MANUAL_URL]: ['contentType', 'httpStatus', 'truncated'],
};

/** 在任何类型下都不允许出现的键（Source 元数据）。 */
export const FORBIDDEN_PAYLOAD_KEYS: readonly string[] = [
  'tier',
  'kind',
  'official',
  'trustScore',
  'priority',
  'sourceTier',
  'sourceKind',
  'sourceOfficial',
];

/**
 * 校验一个 payload 是否合法。不合法直接抛 —— 由 service 在落库前调用。
 *
 * 抛错会**让整个来源这一轮失败**，这是刻意的：
 * 一个没登记的 payload 键意味着「有人改了适配器却没改契约表」，
 * 那要么是契约漏了、要么是适配器写错了，两种都需要人看一眼。
 * 静默把它写进库才是真正难查的方向。
 */
export function assertPayloadShape(
  type: SourceType,
  payload: Record<string, unknown>,
  where: string,
): void {
  const allowed = ALLOWED_PAYLOAD_KEYS[type];
  if (allowed === undefined) {
    throw new Error(`${where}: no payload contract is declared for SourceType ${String(type)}`);
  }

  const forbidden = FORBIDDEN_PAYLOAD_KEYS.filter((key) => key in payload);
  if (forbidden.length > 0) {
    throw new Error(
      `${where}: RawItem payload 不得包含 Source 元数据（${forbidden.join(', ')}）—— ` +
        'kind/tier/official 是会变的编辑配置，必须经 source_id 现查，' +
        '见 tasks/agent-04-collectors.md',
    );
  }

  const allowedSet = new Set(allowed);
  const unknown = Object.keys(payload).filter((key) => !allowedSet.has(key));
  if (unknown.length > 0) {
    throw new Error(
      `${where}: RawItem payload 出现了 ${type} 未登记的键（${unknown.join(', ')}）—— ` +
        '请把新键登记到 payload-keys.ts 的 ALLOWED_PAYLOAD_KEYS，' +
        '不要绕过契约表直接往 payload 里塞字段',
    );
  }
}
