/**
 * 日报状态机（`docs/05` 的 `DailyEditionStatus`）。
 *
 * ```text
 * DRAFT → REVIEWING → SCHEDULED → PUBLISHED
 *   ↓        ↓            ↓
 *        CANCELLED ──→ DRAFT（撤销误操作）
 * ```
 *
 * ── 为什么把转移表写成穷尽的 `Record` ─────────────────────────────────
 * `docs/05` 是强契约：将来加一个状态（例如 `FAILED`）时，
 * **这里会编译不过**，而不是让新状态静默落进某个 `default` 分支里
 * 以「看起来能用」的姿态上线。Agent 07 在审核动作映射上用了同一手法。
 *
 * ── 几条需要解释的边 ─────────────────────────────────────────────────
 *
 * 1. **`PUBLISHED` 是终态。** `docs/10` 允许发布后改 typo / broken link /
 *    fact correction 并**记录 revision**，但 `prisma/schema.prisma` 里
 *    **没有 revision 表**（属 Agent 01，§10 禁止我建 Migration）。
 *    没有 revision 的「发布后修改」就是**静默改历史**，比不支持更糟。
 *    因此 V1 明确不支持发布后编辑，并已提 CCR 请求一张 revision 表。
 *
 * 2. **`CANCELLED → DRAFT` 是允许的。** `docs/10` 说「取消草稿不占号」，
 *    所以取消是**无损**的；若不允许恢复，一次误点就永久毁掉当天的一期，
 *    而管理员除了重开一天没有别的办法。恢复后它仍是 DRAFT，
 *    草稿编译器会照常补内容，一切规则不变。
 *
 * 3. **`SCHEDULED → REVIEWING` 不在表里**，因为**不需要**：
 *    排期后仍可编辑（见 `service.ts` 的 `EDITABLE_STATUSES`），
 *    编辑**不会**把它踢回 REVIEWING —— 它依然是「已排期」，
 *    只是内容被修正了。把它踢回去会让 08:00 的发布白白跳过一期。
 */

import { DailyEditionStatus, DAILY_EDITION_STATUSES } from '@signal/contracts';

/** 穷尽的状态转移表：`from` → 允许到达的 `to`。 */
export const DAILY_TRANSITIONS: Readonly<
  Record<DailyEditionStatus, readonly DailyEditionStatus[]>
> = {
  [DailyEditionStatus.DRAFT]: [
    DailyEditionStatus.REVIEWING,
    DailyEditionStatus.SCHEDULED,
    DailyEditionStatus.CANCELLED,
  ],
  [DailyEditionStatus.REVIEWING]: [DailyEditionStatus.SCHEDULED, DailyEditionStatus.CANCELLED],
  [DailyEditionStatus.SCHEDULED]: [DailyEditionStatus.PUBLISHED, DailyEditionStatus.CANCELLED],
  // 终态：发布后的修改需要 revision 表，V1 不做（见文件头第 1 条）。
  [DailyEditionStatus.PUBLISHED]: [],
  [DailyEditionStatus.CANCELLED]: [DailyEditionStatus.DRAFT],
};

/** 该转移是否合法。 */
export function canTransition(from: DailyEditionStatus, to: DailyEditionStatus): boolean {
  return DAILY_TRANSITIONS[from].includes(to);
}

/**
 * 可以编辑版块/条目的状态。
 *
 * **排期后（`SCHEDULED`）仍可编辑** —— `docs/10` 限制的是**发布后**，
 * 而不是发布前。管理员 07:50 排期、07:55 发现一个错别字却被拒绝修改，
 * 是产品上的不合理，也会逼出「先取消再重排」这种绕路。
 *
 * 唯一的例外是 `PUBLISHED`：见文件头第 1 条。
 */
export const EDITABLE_STATUSES: readonly DailyEditionStatus[] = [
  DailyEditionStatus.DRAFT,
  DailyEditionStatus.REVIEWING,
  DailyEditionStatus.SCHEDULED,
];

export function isEditable(status: DailyEditionStatus): boolean {
  return EDITABLE_STATUSES.includes(status);
}

/**
 * 启动期自检：转移表必须覆盖 `docs/05` 的**每一个**状态。
 *
 * 与 `Record` 的编译期穷尽互补 —— `Record` 保证「不多不少」，
 * 这里保证运行期拿到的枚举值确实是契约里的那些（值被改名而不改结构时，
 * `Record` 是查不出来的）。
 */
export function assertStateMachineCoversContract(): void {
  for (const status of DAILY_EDITION_STATUSES) {
    if (!Object.hasOwn(DAILY_TRANSITIONS, status)) {
      throw new Error(`Daily state machine is missing a transition list for: ${status}`);
    }
  }
  for (const from of Object.keys(DAILY_TRANSITIONS) as DailyEditionStatus[]) {
    if (!(DAILY_EDITION_STATUSES as readonly string[]).includes(from)) {
      throw new Error(`Daily state machine has a non-contract state: ${from}`);
    }
    for (const to of DAILY_TRANSITIONS[from]) {
      if (!(DAILY_EDITION_STATUSES as readonly string[]).includes(to)) {
        throw new Error(`Daily state machine points at a non-contract state: ${from} → ${to}`);
      }
    }
  }
}
