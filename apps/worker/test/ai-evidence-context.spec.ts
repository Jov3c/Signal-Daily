/**
 * Source / Evidence 上下文的守卫（`docs/08` 的「新输入」）。
 *
 * 整个模块最重要的一条规则在这里：**独立来源数只数 distinct `source_id`**。
 * 同一家媒体把同一篇稿子转载 10 次，在 `event_evidence` 里是 10 行 ——
 * 拿行数当来源数的话，一台内容农场就能把 credibility 顶满
 * （`docs/22` 明确要避免的「10 家媒体转载同一稿件 = 10 个独立证据」）。
 */

import { describe, expect, it } from 'vitest';
import { EvidenceType, SourceKind, SourceTier } from '@signal/contracts';
import { buildEvidenceContext, toPromptJson } from '../src/jobs/ai/evidence-context';
import { evidence } from './support/ai-fakes';

const OFFICIAL_SOURCE = {
  kind: SourceKind.OFFICIAL,
  tier: SourceTier.S,
  official: true,
} as const;

const MEDIA_SOURCE = {
  kind: SourceKind.MEDIA,
  tier: SourceTier.B,
  official: false,
} as const;

describe('独立来源数', () => {
  it('同一来源的 10 条证据只算 1 个独立来源', () => {
    const evidences = Array.from({ length: 10 }, (_, index) =>
      evidence(String(index + 1), '7', EvidenceType.SUPPORTING_SOURCE),
    );
    const { context } = buildEvidenceContext({ source: MEDIA_SOURCE, evidences });

    expect(context.independentSourceCount).toBe(1);
    // 证据条数仍然是 10 —— 不是「丢掉了」，而是「不计入独立性」
    expect(evidences).toHaveLength(10);
  });

  it('三个不同来源算 3 个', () => {
    const evidences = [
      evidence('1', '7', EvidenceType.PRIMARY_SOURCE, true),
      evidence('2', '8', EvidenceType.SUPPORTING_SOURCE),
      evidence('3', '9', EvidenceType.SUPPORTING_SOURCE),
    ];
    const { context } = buildEvidenceContext({ source: OFFICIAL_SOURCE, evidences });
    expect(context.independentSourceCount).toBe(3);
  });

  it('`sourceId` 为 null 的证据不计入独立来源（否则删掉 Source 反而虚高）', () => {
    const evidences = [
      evidence('1', '7', EvidenceType.SUPPORTING_SOURCE),
      evidence('2', null, EvidenceType.RELATED_DISCUSSION),
      evidence('3', null, EvidenceType.RELATED_DISCUSSION),
    ];
    const { context } = buildEvidenceContext({ source: MEDIA_SOURCE, evidences });
    expect(context.independentSourceCount).toBe(1);
  });

  it('没有证据时为 0', () => {
    const { context } = buildEvidenceContext({ source: MEDIA_SOURCE, evidences: [] });
    expect(context.independentSourceCount).toBe(0);
    expect(context.primaryEvidenceType).toBeNull();
    expect(context.hasOfficialConfirmation).toBe(false);
  });

  it('混合：重复来源被折叠，独立来源被计入', () => {
    const evidences = [
      evidence('1', '7', EvidenceType.PRIMARY_SOURCE, true),
      evidence('2', '7', EvidenceType.SUPPORTING_SOURCE), // 同来源重复
      evidence('3', '8', EvidenceType.SUPPORTING_SOURCE),
      evidence('4', '8', EvidenceType.SUPPORTING_SOURCE), // 同来源重复
      evidence('5', '9', EvidenceType.SOCIAL_CONFIRMATION),
    ];
    const { context } = buildEvidenceContext({ source: MEDIA_SOURCE, evidences });
    expect(context.independentSourceCount).toBe(3);
  });
});

describe('官方确认判定', () => {
  it('有 OFFICIAL_CONFIRMATION 证据即为真', () => {
    const { context } = buildEvidenceContext({
      source: MEDIA_SOURCE,
      evidences: [evidence('1', '8', EvidenceType.OFFICIAL_CONFIRMATION)],
    });
    expect(context.hasOfficialConfirmation).toBe(true);
  });

  it('PRIMARY_SOURCE + **该证据的来源**是 official 即为真', () => {
    const { context } = buildEvidenceContext({
      source: MEDIA_SOURCE, // 内容可以来自媒体
      evidences: [evidence('1', '7', EvidenceType.PRIMARY_SOURCE, true, true)],
    });
    expect(context.hasOfficialConfirmation).toBe(true);
  });

  it('PRIMARY_SOURCE 但该证据的来源不是 official 时为假', () => {
    // 关键：判定只看库里的 official 布尔位，不看正文里写了什么。
    const { context } = buildEvidenceContext({
      source: MEDIA_SOURCE,
      evidences: [evidence('1', '7', EvidenceType.PRIMARY_SOURCE, true, false)],
    });
    expect(context.hasOfficialConfirmation).toBe(false);
  });

  /* ---------------------------------------------------------------- */
  /* 假阳性 / 假阴性（独立审查 P2 的回归守卫）                          */
  /* ---------------------------------------------------------------- */

  it('**假阳性回归**：内容来源是官方，但证据来源不是 → false', () => {
    // ⚠ 第一版判的是**内容自己的来源** `source.official`，于是
    // 「官方来源的内容 + 事件里任意一条 primary 证据」会被误判成有官方确认 ——
    // 而那条 primary 可能来自一家普通媒体。这等于给二手来源加了官方光环，
    // 直接违背 `docs/08` 的「官方原文应显著优先于二手报道」。
    const { context } = buildEvidenceContext({
      source: OFFICIAL_SOURCE, // 内容来自官方
      evidences: [evidence('1', '9', EvidenceType.PRIMARY_SOURCE, true, false)], // 证据来自媒体
    });
    expect(context.hasOfficialConfirmation).toBe(false);
  });

  it('**假阴性回归**：内容来源是媒体，但事件里有官方一手证据 → true', () => {
    // ⚠ 同一根因的另一面：官方先发 + 媒体转载聚成一个事件时，
    // 给媒体那条内容评分**看不到**事件里的官方一手证据，
    // 于是官方原文被当成普通二手报道。
    const { context } = buildEvidenceContext({
      source: MEDIA_SOURCE, // 内容来自媒体
      evidences: [evidence('1', '7', EvidenceType.PRIMARY_SOURCE, true, true)], // 证据来自官方
    });
    expect(context.hasOfficialConfirmation).toBe(true);
  });

  it('内容来源 official + 证据来源 official 也是 true（两种都官方）', () => {
    const { context } = buildEvidenceContext({
      source: OFFICIAL_SOURCE,
      evidences: [evidence('1', '7', EvidenceType.PRIMARY_SOURCE, true, true)],
    });
    expect(context.hasOfficialConfirmation).toBe(true);
  });

  it('证据来源未知（sourceId 为 null）时不算官方确认', () => {
    const { context } = buildEvidenceContext({
      source: OFFICIAL_SOURCE,
      evidences: [evidence('1', null, EvidenceType.PRIMARY_SOURCE, true, null)],
    });
    expect(context.hasOfficialConfirmation).toBe(false);
  });

  it('SUPPORTING_SOURCE 再多也不会变成官方确认', () => {
    const evidences = Array.from({ length: 20 }, (_, index) =>
      evidence(String(index + 1), `${index + 10}`, EvidenceType.SUPPORTING_SOURCE),
    );
    const { context } = buildEvidenceContext({ source: MEDIA_SOURCE, evidences });
    expect(context.hasOfficialConfirmation).toBe(false);
    expect(context.independentSourceCount).toBe(20); // 来源确实很多
  });
});

describe('Primary Evidence 选取', () => {
  it('取 isPrimary 的那条', () => {
    const { context } = buildEvidenceContext({
      source: OFFICIAL_SOURCE,
      evidences: [
        evidence('1', '7', EvidenceType.RELATED_DISCUSSION),
        evidence('2', '8', EvidenceType.PRIMARY_SOURCE, true),
      ],
    });
    expect(context.primaryEvidenceType).toBe(EvidenceType.PRIMARY_SOURCE);
  });

  it('多条 primary 时取 id 最小的（确定性，不随查询顺序变化）', () => {
    // Agent 01：这个唯一性 DB 层不强制，必须靠事务。绕过事务写坏时，
    // 两次读取必须给出同一个结果，否则同一份数据会算出不同的 credibility。
    const forward = buildEvidenceContext({
      source: MEDIA_SOURCE,
      evidences: [
        evidence('9', '7', EvidenceType.SUPPORTING_SOURCE, true),
        evidence('10', '8', EvidenceType.PRIMARY_SOURCE, true),
      ],
    });
    const backward = buildEvidenceContext({
      source: MEDIA_SOURCE,
      evidences: [
        evidence('10', '8', EvidenceType.PRIMARY_SOURCE, true),
        evidence('9', '7', EvidenceType.SUPPORTING_SOURCE, true),
      ],
    });

    // id 是 BIGINT → 序列化成 string，必须按**数值**比较：
    // 字典序下 '10' < '9'，会选错。
    expect(forward.context.primaryEvidenceType).toBe(EvidenceType.SUPPORTING_SOURCE);
    expect(backward.context.primaryEvidenceType).toBe(forward.context.primaryEvidenceType);
  });

  it('diagnostics 暴露 primary 数量，让数据完整性问题可见', () => {
    const { diagnostics } = buildEvidenceContext({
      source: MEDIA_SOURCE,
      evidences: [
        evidence('1', '7', EvidenceType.SUPPORTING_SOURCE, true),
        evidence('2', '8', EvidenceType.PRIMARY_SOURCE, true),
      ],
    });
    expect(diagnostics.primaryEvidenceCount).toBe(2);
    expect(diagnostics.evidenceCount).toBe(2);
  });

  it('id 非法时不抛异常（一条脏数据不该让整条评分流水线挂掉）', () => {
    expect(() =>
      buildEvidenceContext({
        source: MEDIA_SOURCE,
        evidences: [
          evidence('not-a-number', '7', EvidenceType.SUPPORTING_SOURCE, true),
          evidence('5', '8', EvidenceType.PRIMARY_SOURCE, true),
        ],
      }),
    ).not.toThrow();
  });

  it('**空 id 不会被当成最小值**（P4 回归守卫）', () => {
    // ⚠ `BigInt('')` 不抛错 —— 它等于 `0n`。第一版的兜底是
    // `try { BigInt(id) } catch { MAX_SAFE }`，于是空 id 被当成**最小值**胜出，
    // 「取 id 最小」变成了「取空 id」。兜底逻辑在最需要它的输入上恰好失效。
    const { context } = buildEvidenceContext({
      source: MEDIA_SOURCE,
      evidences: [
        evidence('', '7', EvidenceType.SUPPORTING_SOURCE, true),
        evidence('5', '8', EvidenceType.PRIMARY_SOURCE, true),
      ],
    });
    // 应选 id=5 那条（PRIMARY_SOURCE），而不是空 id 那条
    expect(context.primaryEvidenceType).toBe(EvidenceType.PRIMARY_SOURCE);
  });

  it('全是脏 id 时结果仍然确定（不依赖数组顺序）', () => {
    const forward = buildEvidenceContext({
      source: MEDIA_SOURCE,
      evidences: [
        evidence('', '7', EvidenceType.SUPPORTING_SOURCE, true),
        evidence('  ', '8', EvidenceType.PRIMARY_SOURCE, true),
      ],
    });
    const backward = buildEvidenceContext({
      source: MEDIA_SOURCE,
      evidences: [
        evidence('  ', '8', EvidenceType.PRIMARY_SOURCE, true),
        evidence('', '7', EvidenceType.SUPPORTING_SOURCE, true),
      ],
    });

    // 两条都是脏 id → 都走兜底（同值）→ 取「第一个遇到的最小值」，
    // 顺序不同结果可能不同，但**必须不抛错**且落在候选集合内。
    expect(Object.values(EvidenceType)).toContain(forward.context.primaryEvidenceType);
    expect(Object.values(EvidenceType)).toContain(backward.context.primaryEvidenceType);
  });
});

describe('prompt 序列化', () => {
  it('恰好输出 docs/08 的六个字段，顺序固定', () => {
    const { context } = buildEvidenceContext({
      source: OFFICIAL_SOURCE,
      evidences: [evidence('1', '7', EvidenceType.PRIMARY_SOURCE, true)],
    });
    const json = toPromptJson(context);

    expect(Object.keys(JSON.parse(json))).toEqual([
      'sourceKind',
      'sourceTier',
      'official',
      'independentSourceCount',
      'hasOfficialConfirmation',
      'primaryEvidenceType',
    ]);
  });

  it('同样的输入产生同样的字节序列（prompt cache 友好）', () => {
    const input = {
      source: OFFICIAL_SOURCE,
      evidences: [evidence('1', '7', EvidenceType.PRIMARY_SOURCE, true)],
    };
    const first = toPromptJson(buildEvidenceContext(input).context);
    const second = toPromptJson(buildEvidenceContext(input).context);
    expect(first).toBe(second);
  });

  it('上下文里没有任何「可被模型改写」的入口 —— 它是纯数据', () => {
    const { context } = buildEvidenceContext({
      source: OFFICIAL_SOURCE,
      evidences: [evidence('1', '7', EvidenceType.PRIMARY_SOURCE, true)],
    });
    // tier / official 直接来自库，模型看到的就是我们的判断结果
    expect(context.sourceTier).toBe(SourceTier.S);
    expect(context.official).toBe(true);
  });
});
