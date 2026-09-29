/**
 * 日报发布模块的内存替身（worker 侧单元测试用，不需要 MySQL / Redis）。
 *
 * ⚠ 替身必须与真实仓储**同语义**，否则「全绿」只是自证。
 * 关键差异点都在下面显式标注（Agent 05 的自查记录里有两条假绿
 * 正是替身与真实实现不一致造成的）。
 */

import {
  ContentPipelineStatus,
  ContentType,
  DailyEditionStatus,
  SourceKind,
  SourceTier,
} from '@signal/contracts';
import type { DraftCandidate } from '../../src/jobs/publishing/draft-compiler';
import type { EditionSnapshot } from '../../src/jobs/publishing/preflight';
import type {
  PublishingEditionRow,
  PublishingRepository,
  PublishingSectionInput,
} from '../../src/jobs/publishing/publishing.repository';
import type {
  PublishingNotificationInput,
  PublishingNotifier,
} from '../../src/jobs/publishing/notifier';

const iso = (value: Date | null): string | null => (value === null ? null : value.toISOString());
const toBusinessDate = (value: Date): string => value.toISOString().slice(0, 10);

/* ------------------------------------------------------------------ */
/* 仓储                                                               */
/* ------------------------------------------------------------------ */

export type FakeEdition = PublishingEditionRow & { sections: PublishingSectionInput[] };

export class InMemoryPublishingRepository implements PublishingRepository {
  readonly editions = new Map<string, FakeEdition>();

  /** 候选池（按业务日无关，直接给定）。 */
  candidates: DraftCandidate[] = [];

  /** 每次 `replaceSections` 的入参，供「不许覆盖非 DRAFT」类断言。 */
  readonly replaceCalls: { editionId: string; sections: readonly PublishingSectionInput[] }[] = [];

  markPublishedCalls = 0;

  /** 模拟「读状态之后别人先发布了」（真实实现里是条件更新 count = 0）。 */
  simulateConcurrentPublish = false;

  private nextId = 1;

  seedEdition(input: {
    businessDate: string;
    status?: DailyEditionStatus;
    editionNo?: number | null;
    scheduledAt?: string | null;
    publishedAt?: string | null;
    sections?: PublishingSectionInput[];
  }): FakeEdition {
    const edition: FakeEdition = {
      editionId: String(this.nextId++),
      businessDate: input.businessDate,
      editionNo: input.editionNo ?? null,
      status: input.status ?? DailyEditionStatus.DRAFT,
      scheduledAt: input.scheduledAt ?? null,
      publishedAt: input.publishedAt ?? null,
      sections: input.sections ?? [],
    };
    this.editions.set(input.businessDate, edition);
    return edition;
  }

  private toRow(edition: FakeEdition): PublishingEditionRow {
    const { sections: _sections, ...row } = edition;
    return { ...row };
  }

  async findEdition(businessDate: string): Promise<PublishingEditionRow | null> {
    const edition = this.editions.get(businessDate);
    return edition === undefined ? null : this.toRow(edition);
  }

  async ensureDraft(businessDate: string): Promise<PublishingEditionRow> {
    const existing = this.editions.get(businessDate);
    if (existing !== undefined) return this.toRow(existing);
    return this.toRow(this.seedEdition({ businessDate }));
  }

  async replaceSections(
    editionId: string,
    sections: readonly PublishingSectionInput[],
  ): Promise<void> {
    this.replaceCalls.push({ editionId, sections });
    const edition = [...this.editions.values()].find((e) => e.editionId === editionId);
    if (edition === undefined) throw new Error(`Unknown editionId: ${editionId}`);
    edition.sections = sections.map((section) => ({
      ...section,
      items: section.items.map((item) => ({ ...item })),
    }));
  }

  async findCandidates(input: {
    startUtc: Date;
    endUtc: Date;
    limit: number;
  }): Promise<DraftCandidate[]> {
    // 替身按窗口过滤（真实实现用 SQL 的 `gte/lt`）。
    // 窗口边界必须真的生效 —— 否则 `candidateWindow` 的测试就是空跑。
    return this.candidates
      .filter((candidate) => {
        const at = new Date(candidate.publishedAt).getTime();
        return at >= input.startUtc.getTime() && at < input.endUtc.getTime();
      })
      .slice(0, input.limit);
  }

  async snapshot(editionId: string): Promise<EditionSnapshot | null> {
    const edition = [...this.editions.values()].find((e) => e.editionId === editionId);
    if (edition === undefined) return null;

    return {
      businessDate: edition.businessDate,
      status: edition.status,
      sections: edition.sections.map((section, sectionIndex) => ({
        sectionId: `${editionId}-s${String(sectionIndex)}`,
        type: section.type,
        title: section.title,
        sortOrder: section.sortOrder,
        items: section.items.map((item, itemIndex) => ({
          itemId: `${editionId}-i${String(itemIndex)}`,
          contentId: item.contentId,
          displayStyle: item.displayStyle as never,
          sortOrder: item.sortOrder,
          contentExists: true,
          contentStatus: ContentPipelineStatus.APPROVED,
          sourceName: '某来源',
          originalUrl: `https://example.com/${item.contentId}`,
        })),
      })),
    };
  }

  async countPublished(): Promise<number> {
    return [...this.editions.values()].filter((e) => e.status === DailyEditionStatus.PUBLISHED)
      .length;
  }

  async markPublished(
    editionId: string,
    input: { editionNo: number; publishedAt: Date },
  ): Promise<PublishingEditionRow | null> {
    this.markPublishedCalls += 1;
    if (this.simulateConcurrentPublish) return null;

    const edition = [...this.editions.values()].find((e) => e.editionId === editionId);
    if (edition === undefined) return null;
    // 与真实实现一致：已经发布过的不再占号。
    if (edition.status === DailyEditionStatus.PUBLISHED) return null;

    edition.status = DailyEditionStatus.PUBLISHED;
    edition.editionNo = input.editionNo;
    edition.publishedAt = input.publishedAt.toISOString();
    return this.toRow(edition);
  }
}

/* ------------------------------------------------------------------ */
/* 通知                                                               */
/* ------------------------------------------------------------------ */

/** 记录全部通知，并按 `(type, targetUrl)` 模拟幂等。 */
export class RecordingNotifier implements PublishingNotifier {
  readonly calls: PublishingNotificationInput[] = [];

  private readonly seen = new Set<string>();

  async notify(input: PublishingNotificationInput): Promise<boolean> {
    const key = `${input.type}::${input.targetUrl}`;
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    this.calls.push(input);
    return true;
  }

  /** 便于断言「某类通知发过几次」。 */
  countOf(type: string): number {
    return this.calls.filter((call) => call.type === type).length;
  }
}

/* ------------------------------------------------------------------ */
/* 候选构造                                                           */
/* ------------------------------------------------------------------ */

let candidateCounter = 0;

/**
 * 造一个候选；用 `overrides` 覆盖任意字段。
 *
 * ⚠ 默认 `publishedAt` 取 **2026-09-28T12:00:00Z**，它落在
 * `candidateWindow('2026-09-29')`（UTC `[09-28T00:00, 09-29T00:00)`）**之内**。
 * 这一点很关键：第一版默认值写成了 `09-29T01:00Z`（窗口外），
 * 于是所有「生成了草稿」的用例都拿到空结果 —— 那不是 bug，
 * 是替身的默认值不真实。窗口过滤本身由
 * 「窗口真的在过滤」那条用例单独覆盖。
 */
export function makeCandidate(overrides: Partial<DraftCandidate> = {}): DraftCandidate {
  candidateCounter += 1;
  const contentId = overrides.contentId ?? String(1000 + candidateCounter);
  return {
    contentId,
    title: '某个 AI 模型发布了新版本',
    summary: null,
    sourceId: '7',
    sourceName: '某来源',
    sourceKind: SourceKind.MEDIA,
    sourceTier: SourceTier.B,
    official: false,
    finalScore: 80,
    publishedAt: '2026-09-28T12:00:00.000Z',
    eventId: null,
    isEventPrimary: true,
    contentType: ContentType.ARTICLE,
    ...overrides,
  };
}

export { toBusinessDate, iso };
