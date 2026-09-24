/**
 * Source / Evidence 上下文 —— `tasks/agent-06-ai.md` 的「新输入」。
 *
 * `docs/08` 要求 credibility 的输入增加：
 *
 * ```json
 * {
 *   "sourceKind": "OFFICIAL",
 *   "sourceTier": "S",
 *   "official": true,
 *   "independentSourceCount": 3,
 *   "hasOfficialConfirmation": true,
 *   "primaryEvidenceType": "PRIMARY_SOURCE"
 * }
 * ```
 *
 * 并附四条硬规则：
 *
 * 1. **Tier 是输入，不是结论** —— 我们把这个数字喂给模型，模型不能改写它。
 * 2. **多来源只有「独立来源」才提高可信度。**
 * 3. **官方原文应显著优先于二手报道。**
 * 4. **AI 不得凭语言风格伪造「官方确认」。**
 *
 * ── 关于 `independentSourceCount` 的所有权边界 ─────────────────────────
 * 「`distinct source_id` 计算独立来源基础值」是 Agent 05 的责任
 * （`tasks/agent-05-pipeline.md`）。本模块**只读**地推导同一个数用于 AI 上下文，
 * 不写入 `Event` / `EventEvidence`，也不缓存。取舍：多算一次，
 * 但避免两个 Agent 对同一个字段的写路径产生竞争；
 * 若 Agent 05 后续把该值落库，这里换成读列即可（端口已隔离）。
 *
 * ── 为什么是「独立来源数」而不是「证据条数」 ──────────────────────────
 * 同一家媒体把同一篇稿子转载 10 次（RSS 一次 + 页面一次 + 被聚合一次），
 * 在 `event_evidence` 里就是 10 行。如果拿行数当来源数，
 * 一台内容农场就能把 credibility 顶满 —— 这正是 `docs/22` 明确要避免的
 * 「10 家媒体转载同一稿件 = 10 个独立证据」。所以只数 **distinct `source_id`**。
 */

import { EvidenceType, type SourceKind, type SourceTier } from '@signal/contracts';

/** 来源身份（只取 credibility 判断需要的三个属性）。 */
export type SourceIdentity = {
  kind: SourceKind;
  tier: SourceTier;
  official: boolean;
};

/**
 * 一条证据的只读投影。
 *
 * `sourceId` 为 `null` 是**合法**的：`EventEvidence.sourceId` 可空
 * （人工补的证据、或原来源被删除后 `SetNull`）。这类证据无法证明「独立」，
 * 因此**不计入** `independentSourceCount` —— 否则删掉 Source 反而会让
 * 独立来源数虚高，那是个可以被人为制造的漏洞。
 *
 * ⚠ `sourceOfficial` 是**证据自己那条来源**的 official 标记，
 * 不是内容所属来源的。两者在真实数据里会分叉（`docs/22`：同一事件多来源）：
 * 官方先发 + 媒体转载聚成一个事件时，「内容来自媒体」与
 * 「primary 证据来自官方」同时成立。
 *
 * 独立审查的 P2：第一版 `detectOfficialConfirmation()` 判的是
 * **内容自己的来源** `source.official`，于是
 * 「官方来源的内容 + 事件里任意一条 primary 证据」被误判成有官方确认（假阳性），
 * 而「媒体来源的内容 + 事件里的官方一手证据」被判成没有（假阴性）。
 * `sourceId` 为 `null` 时本字段也是 `null`（无从判断，按「不是官方」处理）。
 */
export type EvidenceProjection = {
  id: string;
  sourceId: string | null;
  /** 该证据所属来源是否被管理员标为 `official`；`sourceId` 为 null 时也是 null。 */
  sourceOfficial: boolean | null;
  evidenceType: EvidenceType;
  isPrimary: boolean;
};

/** `docs/08` 的那六个字段（就是要塞进 prompt 的东西）。 */
export type EvidenceContext = {
  sourceKind: SourceKind;
  sourceTier: SourceTier;
  official: boolean;
  independentSourceCount: number;
  hasOfficialConfirmation: boolean;
  primaryEvidenceType: EvidenceType | null;
};

/** 构建结果 + 供日志使用的诊断信息（**不进 prompt**）。 */
export type EvidenceContextResult = {
  context: EvidenceContext;
  diagnostics: {
    /** 参与计算的证据条数（含重复来源）。 */
    evidenceCount: number;
    /**
     * `isPrimary = true` 的证据条数。
     *
     * `docs/03`/Agent 01 明确：**这个唯一性 DB 层不强制**，靠事务保证。
     * 正常情况下应为 0 或 1；大于 1 说明数据被绕过事务写坏了
     * （Agent 07 的人工修正路径是另一个可能的入口）。
     * 本模块不修数据 —— 只把这个数暴露出来让它可被观测，
     * 并且**确定性地**取 id 最小的那条，避免同一份数据两次算出不同结果。
     */
    primaryEvidenceCount: number;
  };
};

/**
 * 「有官方确认」的判定。
 *
 * 两条路径：
 * 1. 存在 `OFFICIAL_CONFIRMATION` 类型的证据 —— 这是 `docs/07` 里
 *    「官方原始发布 → `OFFICIAL_CONFIRMATION`」的产物。
 * 2. 存在 `PRIMARY_SOURCE` 类型的证据，**且该证据自己的来源**被管理员标为 `official`。
 *
 * ⚠ 第 2 条判的必须是**证据那条来源**（`evidence.sourceOfficial`），
 * 不是当前内容所属来源。判错会同时产生假阳性与假阴性 —— 见
 * `EvidenceProjection.sourceOfficial` 的说明。
 *
 * ⚠ 关键：判定只看**库里的 `official` 布尔位**，完全不看正文里写了什么。
 * `docs/08` 的「AI 不得凭语言风格伪造官方确认」在实现上就落成这一句 ——
 * 模型没有任何路径能影响这个布尔值，它连输出字段都没有。
 */
function detectOfficialConfirmation(evidences: readonly EvidenceProjection[]): boolean {
  return evidences.some((evidence) => {
    if (evidence.evidenceType === EvidenceType.OFFICIAL_CONFIRMATION) return true;
    if (evidence.evidenceType === EvidenceType.PRIMARY_SOURCE && evidence.sourceOfficial === true) {
      return true;
    }
    return false;
  });
}

/**
 * 独立来源数 = **distinct 非空 `sourceId`**。
 *
 * 同一来源的 RSS + 页面 + 聚合重复抓取只算 1。
 */
function countIndependentSources(evidences: readonly EvidenceProjection[]): number {
  const distinct = new Set<string>();
  for (const evidence of evidences) {
    if (evidence.sourceId !== null) distinct.add(evidence.sourceId);
  }
  return distinct.size;
}

/**
 * 取 Primary Evidence 的类型。
 *
 * 多条 primary 时取 `id` 最小的一条 —— 用 `BigInt` 比较而不是字符串比较，
 * 否则 `'10' < '9'` 会给出错误的顺序（`id` 是 BIGINT，序列化成 string 后
 * 字典序与数值序不同）。
 */
function pickPrimaryEvidenceType(evidences: readonly EvidenceProjection[]): EvidenceType | null {
  let picked: EvidenceProjection | null = null;
  for (const evidence of evidences) {
    if (!evidence.isPrimary) continue;
    if (picked === null || toComparableBigInt(evidence.id) < toComparableBigInt(picked.id)) {
      picked = evidence;
    }
  }
  return picked === null ? null : picked.evidenceType;
}

/**
 * BIGINT id 的比较值。
 *
 * 正常路径下 `id` 一定能解析；解析不了时退回 `BigInt` 最大值，
 * 让它在「取最小」的排序里排到最后，而**不是**抛异常 ——
 * 一个格式异常的 id 不应该让整条评分流水线挂掉。
 *
 * ⚠ 必须先判空串：`BigInt('')` **不抛错**，它等于 `0n`。
 * 独立审查的 P4：第一版直接 `BigInt(id)` 加 try/catch，
 * 于是空 id 被当成**最小值**而胜出（「取 id 最小」变成了「取空 id」），
 * 兜底逻辑在最需要它的输入上恰好失效。
 * 用正则先卡住形态，非十进制数字串一律走兜底。
 */
function toComparableBigInt(id: string): bigint {
  if (!/^\d+$/.test(id)) return BigInt(Number.MAX_SAFE_INTEGER);
  try {
    return BigInt(id);
  } catch {
    return BigInt(Number.MAX_SAFE_INTEGER);
  }
}

/** 组装 AI 的 credibility 上下文。 */
export function buildEvidenceContext(input: {
  source: SourceIdentity;
  evidences: readonly EvidenceProjection[];
}): EvidenceContextResult {
  const { source, evidences } = input;
  const primaryEvidenceCount = evidences.filter((evidence) => evidence.isPrimary).length;

  return {
    context: {
      sourceKind: source.kind,
      sourceTier: source.tier,
      official: source.official,
      independentSourceCount: countIndependentSources(evidences),
      hasOfficialConfirmation: detectOfficialConfirmation(evidences),
      primaryEvidenceType: pickPrimaryEvidenceType(evidences),
    },
    diagnostics: {
      evidenceCount: evidences.length,
      primaryEvidenceCount,
    },
  };
}

/**
 * 把上下文序列化成 prompt 里那段 JSON。
 *
 * 字段顺序固定 —— 固定的字节序列才能命中上游的 prompt cache。
 */
export function toPromptJson(context: EvidenceContext): string {
  return JSON.stringify(
    {
      sourceKind: context.sourceKind,
      sourceTier: context.sourceTier,
      official: context.official,
      independentSourceCount: context.independentSourceCount,
      hasOfficialConfirmation: context.hasOfficialConfirmation,
      primaryEvidenceType: context.primaryEvidenceType,
    },
    null,
    2,
  );
}
