/**
 * Evidence Attach 的守卫 —— `docs/07` / `docs/22` 的证据链。
 *
 * 任务书对这一节有 5 条硬要求，这里逐条覆盖：
 * 同 Event 关联多来源 / 自动生成五类证据 / `distinct source_id` 独立来源数 /
 * 同 URL 与同 Source 去重 / Primary 事务唯一。
 */

import { describe, expect, it } from 'vitest';
import { EvidenceType, SourceKind, SourceTier } from '@signal/contracts';
import {
  countIndependentSources,
  evidenceTypeFor,
  planEvidenceAttach,
  selectPrimary,
  type EvidenceCandidate,
  type EvidenceDraft,
  type ExistingEvidence,
} from '../src/jobs/content/evidence/evidence-plan';

const OFFICIAL = { tier: SourceTier.S, kind: SourceKind.OFFICIAL, official: true };
const MEDIA_B = { tier: SourceTier.B, kind: SourceKind.MEDIA, official: false };
const PERSON = { tier: SourceTier.A, kind: SourceKind.PERSON, official: false };
const DEV = { tier: SourceTier.A, kind: SourceKind.DEVELOPER, official: false };
const LOW = { tier: SourceTier.C, kind: SourceKind.TREND, official: false };

/** 造一条候选内容。 */
function candidate(
  contentId: string,
  sourceId: string,
  source: typeof OFFICIAL,
  overrides: Partial<EvidenceCandidate> = {},
): EvidenceCandidate {
  const url = overrides.url ?? `https://example.com/${contentId}`;
  return {
    contentId,
    sourceId,
    source,
    title: overrides.title ?? `标题 ${contentId}`,
    url,
    urlHash: overrides.urlHash ?? `hash-${contentId}`,
    publishedAt: overrides.publishedAt ?? null,
  };
}

describe('证据类型映射（docs/07 的四条）', () => {
  it('官方原始发布 → PRIMARY_SOURCE（事件里还没有 Primary 时）', () => {
    expect(evidenceTypeFor(OFFICIAL, false)).toBe(EvidenceType.PRIMARY_SOURCE);
  });

  it('第二条官方来源 → OFFICIAL_CONFIRMATION（不是第二个 Primary）', () => {
    expect(evidenceTypeFor(OFFICIAL, true)).toBe(EvidenceType.OFFICIAL_CONFIRMATION);
  });

  it('当事人 → SOCIAL_CONFIRMATION', () => {
    expect(evidenceTypeFor(PERSON, false)).toBe(EvidenceType.SOCIAL_CONFIRMATION);
  });

  it('核心开发者 → SUPPORTING_SOURCE', () => {
    expect(evidenceTypeFor(DEV, false)).toBe(EvidenceType.SUPPORTING_SOURCE);
  });

  it('高质量独立媒体 → SUPPORTING_SOURCE', () => {
    expect(evidenceTypeFor(MEDIA_B, false)).toBe(EvidenceType.SUPPORTING_SOURCE);
  });

  it('普通二手来源 → RELATED_DISCUSSION', () => {
    expect(evidenceTypeFor(LOW, false)).toBe(EvidenceType.RELATED_DISCUSSION);
  });

  it('政府公告按官方确认处理（是直接事实来源，但没打 official 标记）', () => {
    expect(
      evidenceTypeFor({ tier: SourceTier.B, kind: SourceKind.GOVERNMENT, official: false }, false),
    ).toBe(EvidenceType.OFFICIAL_CONFIRMATION);
  });

  it('**tier=S 即使没打 official 也算官方**（docs/22 的 S 档语义）', () => {
    expect(
      evidenceTypeFor({ tier: SourceTier.S, kind: SourceKind.MEDIA, official: false }, false),
    ).toBe(EvidenceType.PRIMARY_SOURCE);
  });

  it('**只看来源属性** —— 函数签名里没有正文字段', () => {
    // 接口形状即断言：伪造「官方口吻」的正文在类型上就传不进来。
    expect(evidenceTypeFor.length).toBe(2); // (source, hasPrimaryAlready)
  });
});

describe('独立来源数（docs/06 的口径）', () => {
  it('**同 Source 的多条内容只算 1**（防「10 家媒体转载 = 10 个来源」）', () => {
    const candidates = Array.from({ length: 10 }, (_, index) =>
      candidate(String(index + 1), '7', MEDIA_B),
    );
    expect(countIndependentSources(candidates)).toBe(1);
  });

  it('三个不同来源算 3', () => {
    expect(
      countIndependentSources([
        candidate('1', '7', MEDIA_B),
        candidate('2', '8', MEDIA_B),
        candidate('3', '9', MEDIA_B),
      ]),
    ).toBe(3);
  });

  it('sourceId 为空的证据不计入（否则删掉来源反而让数字虚高）', () => {
    expect(countIndependentSources([candidate('1', '7', MEDIA_B), candidate('2', '', MEDIA_B)])).toBe(
      1,
    );
  });

  it('空列表 → 0', () => {
    expect(countIndependentSources([])).toBe(0);
  });
});

describe('Primary 选择', () => {
  const draft = (urlHash: string, type: EvidenceType, at?: number): EvidenceDraft => ({
    contentId: '1',
    sourceId: '7',
    evidenceType: type,
    title: null,
    url: `https://example.com/${urlHash}`,
    urlHash,
    publishedAt: at === undefined ? null : new Date(at),
    isPrimary: false,
  });

  it('在 PRIMARY_SOURCE 里选 publishedAt 最早的', () => {
    const selection = selectPrimary(
      [draft('a', EvidenceType.PRIMARY_SOURCE, 5_000), draft('b', EvidenceType.PRIMARY_SOURCE, 1_000)],
      [],
    );
    expect(selection.urlHash).toBe('b');
  });

  it('**没有 PRIMARY_SOURCE 时不设 Primary**（而不是硬塞一条讨论帖）', () => {
    const selection = selectPrimary([draft('a', EvidenceType.RELATED_DISCUSSION)], []);
    expect(selection).toEqual({ urlHash: null, reason: 'no-primary-source-available' });
  });

  it('已存在的 PRIMARY_SOURCE 参与比较（不会每次都被新内容顶掉）', () => {
    const existing: ExistingEvidence[] = [
      {
        evidenceId: '1',
        urlHash: 'old',
        evidenceType: EvidenceType.PRIMARY_SOURCE,
        isPrimary: true,
        publishedAt: null,
      },
    ];
    const selection = selectPrimary([draft('new', EvidenceType.PRIMARY_SOURCE, 9_999)], existing);
    // 已存在的没有 publishedAt 信息，按「最早」处理 —— 保持 Primary 稳定
    expect(selection.urlHash).toBe('old');
  });
});

describe('挂接计划', () => {
  it('新事件的第一条官方内容成为 Primary', () => {
    const plan = planEvidenceAttach({
      candidates: [candidate('1', '7', OFFICIAL)],
      existing: [],
    });

    expect(plan.toInsert).toHaveLength(1);
    expect(plan.toInsert[0]!.evidenceType).toBe(EvidenceType.PRIMARY_SOURCE);
    expect(plan.primaryUrlHash).toBe('hash-1');
    expect(plan.independentSourceCount).toBe(1);
  });

  it('已存在的 URL 被跳过（幂等）', () => {
    const plan = planEvidenceAttach({
      candidates: [candidate('1', '7', MEDIA_B)],
      existing: [
        {
          evidenceId: '1',
          urlHash: 'hash-1',
          evidenceType: EvidenceType.SUPPORTING_SOURCE,
          isPrimary: false,
          publishedAt: null,
        },
      ],
    });

    expect(plan.toInsert).toHaveLength(0);
    expect(plan.skippedExistingUrls).toBe(1);
  });

  it('同批次里的两条官方内容：一条 PRIMARY_SOURCE、一条 OFFICIAL_CONFIRMATION', () => {
    const plan = planEvidenceAttach({
      candidates: [candidate('1', '7', OFFICIAL), candidate('2', '8', OFFICIAL)],
      existing: [],
    });

    const types = plan.toInsert.map((d) => d.evidenceType);
    expect(types.filter((t) => t === EvidenceType.PRIMARY_SOURCE)).toHaveLength(1);
    expect(types.filter((t) => t === EvidenceType.OFFICIAL_CONFIRMATION)).toHaveLength(1);
  });

  it('事件里已有 Primary 时，新来的官方内容算 OFFICIAL_CONFIRMATION', () => {
    const plan = planEvidenceAttach({
      candidates: [candidate('2', '8', OFFICIAL)],
      existing: [
        {
          evidenceId: '1',
          urlHash: 'hash-1',
          evidenceType: EvidenceType.PRIMARY_SOURCE,
          isPrimary: true,
          publishedAt: null,
        },
      ],
    });

    expect(plan.toInsert[0]!.evidenceType).toBe(EvidenceType.OFFICIAL_CONFIRMATION);
  });

  it('媒体内容进来时 Primary 仍是原来那条官方原文', () => {
    const plan = planEvidenceAttach({
      candidates: [candidate('2', '9', MEDIA_B)],
      existing: [
        {
          evidenceId: '1',
          urlHash: 'hash-1',
          evidenceType: EvidenceType.PRIMARY_SOURCE,
          isPrimary: true,
          publishedAt: null,
        },
      ],
    });

    expect(plan.primaryUrlHash).toBe('hash-1');
    expect(plan.reassignPrimary).toBe(false);
  });

  it('**同 URL 只留一条**（docs/06 的同 URL 去重）', () => {
    const plan = planEvidenceAttach({
      candidates: [
        candidate('1', '7', MEDIA_B, { url: 'https://example.com/same', urlHash: 'same' }),
        candidate('2', '8', MEDIA_B, { url: 'https://example.com/same', urlHash: 'same' }),
      ],
      existing: [],
    });

    expect(plan.toInsert).toHaveLength(1);
    expect(plan.skippedExistingUrls).toBe(1);
  });

  it('独立来源数按来源去重（同源两条内容算 1）', () => {
    const plan = planEvidenceAttach({
      candidates: [
        candidate('1', '7', MEDIA_B),
        candidate('2', '7', MEDIA_B),
        candidate('3', '8', MEDIA_B),
      ],
      existing: [],
    });

    expect(plan.independentSourceCount).toBe(2);
    expect(plan.toInsert).toHaveLength(3); // 证据三条，但独立来源两个
  });

  it('空候选 → 空计划', () => {
    const plan = planEvidenceAttach({ candidates: [], existing: [] });
    expect(plan.toInsert).toHaveLength(0);
    expect(plan.primaryUrlHash).toBeNull();
    expect(plan.independentSourceCount).toBe(0);
  });
});
