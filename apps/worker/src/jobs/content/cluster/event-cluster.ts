/**
 * Event Cluster —— 决定一条 Content 归属哪个 `Event`。
 *
 * `docs/07`：
 *
 * > 同一事件只形成一个 Event，多个 Content 可以属于该 Event。
 *
 * ── 为什么复用 Near Dedup 的结果，而不是自己再算一遍相似度 ──────────
 * S3 已经把「哪些内容和它像」算出来了（`dedup/similarity.ts`）。
 * 这里只做**归属决策**，不重复计算 —— 相似度算法只有一处实现，
 * 改阈值/改指纹时不会出现「两个阶段判得不一样」。
 *
 * ── 「像」不等于「同一事件」────────────────────────────────────────
 * 这是本模块最容易做错的地方：相似度高只说明**文字像**，
 * 同一事件的连续进展（「发布」→「发布后撤回」）文字也很像，
 * 但语义上是两个事件。
 *
 * V1 的取舍：**只按相似度归属，不做时间/语义切分**。
 * 因此 `docs/07` 的 `Event.lastSeenAt` 会持续被推后，一个长期话题
 * 可能被聚成一个越来越大的 Event。这是**已知限制**，已记入 HANDOFF
 *（真要解决需要事件边界判定，属于 V2；`docs/07` 对 V1 只要求
 *「同一事件只形成一个 Event」）。
 *
 * ── `Event.status` 是裸字符串 ──────────────────────────────────────
 * `docs/05` 没有定义 `EventStatus` 枚举（Agent 01 特意没有发明一个）。
 * 因此这里用一个常量 `EVENT_STATUS_ACTIVE`，而不是散落的字面量 ——
 * 万一将来契约补了枚举，只需要改这一处。
 */

import type { NearDuplicateMatch } from '../dedup/similarity';

/** `Event.status` 的取值。`docs/05` 未定义枚举，见文件头。 */
export const EVENT_STATUS_ACTIVE = 'ACTIVE';

/** `EventContent.relation` 的取值（`docs/03` 只说是个 VarChar(20)）。 */
export const EVENT_RELATION = {
  /** 主稿（该事件的第一篇 / 由主来源发布的那篇）。 */
  PRIMARY: 'primary',
  /** 同一事件的其他报道。 */
  RELATED: 'related',
} as const;
export type EventRelation = (typeof EVENT_RELATION)[keyof typeof EVENT_RELATION];

/** 库中已有的事件（只需 id 与它包含的 content）。 */
export type ExistingEvent = {
  eventId: string;
  contentIds: readonly string[];
};

export type EventDecision =
  | {
      action: 'join';
      eventId: string;
      /** 促成这次归属的那条匹配（用于日志与排查）。 */
      viaContentId: string;
      viaScore: number;
      /**
       * 这条内容**本来就已经在这个事件里**（幂等命中）。
       *
       * ⚠ 调用方必须据此**跳过写操作** —— 再挂一次会撞
       * `EventContent` 的唯一约束（`contentId` 唯一）。
       * 第一版只返回了「加入哪个事件」，服务层于是无脑挂接，
       * 第二次聚合直接抛 P2002。
       */
      alreadyMember: boolean;
    }
  | { action: 'create'; reason: 'no-similar-content-in-any-event' };

/**
 * 决定归属。
 *
 * 规则：
 * 1. 在近似重复的候选里，找出**已经在某个 Event 里**的那些；
 * 2. 取**相似度最高**的那条所属的 Event；
 * 3. 相似度并列时取 **`eventId` 数值最小**的 —— 只为确定性，
 *    避免同一批数据两次跑出不同的归属。
 *
 * ⚠ 只认 `crossSourceMatches` 与 `sameSourceMatches` **两者**：
 * 同源的第二篇报道也是同一事件的一部分（例如官方先发公告、
 * 随后发补充说明），不该被排除在外。
 */
export function decideEventAssignment(
  probe: { contentId: string },
  matches: readonly NearDuplicateMatch[],
  events: readonly ExistingEvent[],
): EventDecision {
  // ⚠ **幂等自检必须放在最前面**，不能放在下面的循环里。
  // 第一版把它和其他逻辑一起写在 `matches.length === 0` 的提前返回**之后**，
  // 于是「已经在某个事件里的内容再跑一次聚合」会走到 `create` 分支 ——
  // 也就是 **每次重试都新建一个重复的 Event**。
  // 而重试是正常路径（作业超时、Redis 抖动都会导致重跑）。
  for (const event of events) {
    if (event.contentIds.includes(probe.contentId)) {
      return {
        action: 'join',
        eventId: event.eventId,
        viaContentId: probe.contentId,
        viaScore: 1,
        alreadyMember: true,
      };
    }
  }

  if (matches.length === 0 || events.length === 0) {
    return { action: 'create', reason: 'no-similar-content-in-any-event' };
  }

  // contentId → eventId（一个 Content 只属于一个 Event，见 `EventContent.contentId` 的唯一约束）
  const eventOfContent = new Map<string, string>();
  for (const event of events) {
    for (const contentId of event.contentIds) {
      eventOfContent.set(contentId, event.eventId);
    }
  }

  let best: { eventId: string; viaContentId: string; viaScore: number } | null = null;

  for (const match of matches) {
    const eventId = eventOfContent.get(match.contentId);
    if (eventId === undefined) continue;

    if (
      best === null ||
      match.score > best.viaScore ||
      (match.score === best.viaScore && compareIds(eventId, best.eventId) < 0)
    ) {
      best = { eventId, viaContentId: match.contentId, viaScore: match.score };
    }
  }

  return best === null
    ? { action: 'create', reason: 'no-similar-content-in-any-event' }
    : {
        action: 'join',
        eventId: best.eventId,
        viaContentId: best.viaContentId,
        viaScore: best.viaScore,
        alreadyMember: false,
      };
}

/**
 * 事件的展示标题。
 *
 * `Event.canonicalTitle` 是 `VarChar(500)`。取**主稿的标题** ——
 * 主稿来自优先级最高的来源（官方一手），它的措辞通常最权威。
 *
 * 不做「自动生成一个更中性的标题」：那需要 AI（`DAILY_DRAFT` 一类），
 * 而 `docs/00` 明确「AI 是编辑助理，不是主编」。管理员可以在后台改。
 */
export function canonicalTitleOf(primaryTitle: string, maxChars = 500): string {
  const codePoints = Array.from(primaryTitle);
  return codePoints.length <= maxChars ? primaryTitle : codePoints.slice(0, maxChars).join('');
}

/** 按数值比较两个十进制 id（同 `dedup/exact.ts` 的约定）。 */
function compareIds(a: string, b: string): number {
  if (a === b) return 0;
  try {
    const left = BigInt(a);
    const right = BigInt(b);
    if (left === right) return 0;
    return left < right ? -1 : 1;
  } catch {
    return a < b ? -1 : 1;
  }
}
