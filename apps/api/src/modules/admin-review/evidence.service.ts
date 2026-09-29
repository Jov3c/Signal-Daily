/**
 * `EvidenceService` —— 证据链的人工纠正（`docs/09`）。
 *
 * ```text
 * 增加一个 Evidence URL
 * 修改 Evidence type
 * 设置 Primary
 * 删除错误 Evidence
 * ```
 *
 * ── 三条硬规矩 ────────────────────────────────────────────────────
 * 1. **人工证据必须保留 URL**（`docs/09`）—— 没有 URL 的证据无法被核对，
 *    而证据的全部价值就是「可核对」；
 * 2. **一个事件最多一个 Primary**，靠**事务**保证（`docs/03` 明确 DB 层不强制）。
 *    人工 `set-primary` 与 Agent 05 的自动挂接走的是同一条不变量；
 * 3. **每一次人工操作都写审计**（见 `audit.ts` 的说明与它的取舍）。
 */

import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { AppError, EvidenceType, PlatformErrorCode } from '@signal/contracts';
import type { Logger } from '@signal/logger';
import { writeAudit, AuditEvent } from './audit';
import type {
  AddEvidenceInput,
  EvidenceDetail,
  EvidenceMutationResponse,
  UpdateEvidenceInput,
} from './dto/review.dto';
import { ADMIN_REVIEW_REPOSITORY, type AdminReviewRepository, type EvidenceRow } from './repository';

/** 注入 token。 */
export const EVIDENCE_LOGGER = 'EVIDENCE_LOGGER';

/** `event_evidence.url` 是 `VarChar(2048)`。 */
export const MAX_EVIDENCE_URL_LENGTH = 2048;
/** `event_evidence.title` 是 `VarChar(700)`。 */
export const MAX_EVIDENCE_TITLE_LENGTH = 700;

/** 允许的 URL scheme。 */
const ALLOWED_SCHEMES: readonly string[] = ['http:', 'https:'];

/**
 * 校验人工录入的证据 URL。
 *
 * ⚠ **只做 scheme 白名单与长度，不做完整的 SSRF 校验** —— 这是刻意的：
 * SSRF 防护针对的是「**我们去抓**这个地址」，而证据 URL **永远不会被本系统请求**，
 * 它只是存下来、渲染成一个链接给管理员点。
 * 对不抓取的地址套 SSRF 规则会把「引用一个内网文档」也拒掉，那是误伤。
 *
 * 真正需要防的是渲染层：`javascript:` / `data:` 之类的 scheme 会让链接变成
 * 可执行内容 —— scheme 白名单正好挡住这一类。
 */
export function normalizeEvidenceUrl(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === '') {
    throw new AppError({
      code: PlatformErrorCode.VALIDATION_FAILED,
      httpStatus: 400,
      safeMessage: 'Evidence URL must not be empty',
      details: { fields: ['url'] },
    });
  }
  if (trimmed.length > MAX_EVIDENCE_URL_LENGTH) {
    throw new AppError({
      code: PlatformErrorCode.VALIDATION_FAILED,
      httpStatus: 400,
      safeMessage: `Evidence URL must be at most ${MAX_EVIDENCE_URL_LENGTH} characters`,
      details: { fields: ['url'] },
    });
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new AppError({
      code: PlatformErrorCode.VALIDATION_FAILED,
      httpStatus: 400,
      safeMessage: 'Evidence URL must be an absolute URL',
      details: { fields: ['url'] },
    });
  }

  if (!ALLOWED_SCHEMES.includes(parsed.protocol)) {
    throw new AppError({
      code: PlatformErrorCode.VALIDATION_FAILED,
      httpStatus: 400,
      safeMessage: 'Evidence URL must use http or https',
      details: { fields: ['url'], scheme: parsed.protocol },
    });
  }

  return trimmed;
}

/** `EventEvidence.urlHash` 是 `Char(64)`，约定 sha256 十六进制小写。 */
export function hashEvidenceUrl(url: string): string {
  return createHash('sha256').update(url).digest('hex');
}

/**
 * 去重键。
 *
 * 与 `EventEvidence` 的 `@@unique([eventId, urlHash])` 是**同一件事**：
 * 数据库是最后一道防线，这里先查一次是为了给出**可读的错误**（409 + 已有那条的 id），
 * 而不是把一条 Prisma 的 P2002 抛给管理员。
 */
function duplicateEvidence(appError: { eventId: string; url: string }): AppError {
  return new AppError({
    code: PlatformErrorCode.CONFLICT,
    httpStatus: 409,
    safeMessage: `This URL is already recorded as evidence for the event`,
    details: { eventId: appError.eventId, url: appError.url },
  });
}

@Injectable()
export class EvidenceService {
  constructor(
    @Inject(ADMIN_REVIEW_REPOSITORY) private readonly repository: AdminReviewRepository,
    @Inject(EVIDENCE_LOGGER) private readonly logger: Logger,
  ) {}

  /** 读一个事件的证据链。 */
  async list(eventId: string): Promise<{ eventId: string; evidences: EvidenceDetail[] }> {
    const event = await this.repository.findEventDetail(eventId);
    if (event === null) throw this.eventNotFound(eventId);
    return { eventId: event.eventId, evidences: event.evidences };
  }

  /** 人工增加一条证据（`docs/09`）。 */
  async add(
    eventId: string,
    input: AddEvidenceInput,
    actorUserId: string,
  ): Promise<EvidenceMutationResponse> {
    const event = await this.repository.findEventDetail(eventId);
    if (event === null) throw this.eventNotFound(eventId);

    const url = normalizeEvidenceUrl(input.url);
    const urlHash = hashEvidenceUrl(url);

    // 先查重给出可读的 409（数据库的唯一约束是最后一道防线）。
    const existing = event.evidences.find((evidence) => evidence.urlHash === urlHash);
    if (existing !== undefined) throw duplicateEvidence({ eventId, url });

    const created = await this.repository.addEvidence({
      eventId,
      evidenceType: input.evidenceType,
      title: input.title ?? null,
      url,
      urlHash,
      publishedAt: parseOptionalDate(input.publishedAt),
      contentId: input.contentId ?? null,
      // 证据的来源从它关联的内容继承；人工补的裸 URL 没有来源，
      // **不猜测**（猜错会让独立来源数虚高）。
      sourceId: input.contentId === undefined || input.contentId === null
        ? null
        : await this.sourceIdOfContent(input.contentId),
    });

    writeAudit(this.logger, {
      event: AuditEvent.EVIDENCE_ADDED,
      actorUserId,
      target: { eventId, evidenceId: created.evidenceId, contentId: created.contentId },
      detail: { url, evidenceType: created.evidenceType },
    });

    return this.mutationResponse(eventId, created, actorUserId);
  }

  /** 修改证据类型 / 标题 / URL（`docs/09` 的「修改 Evidence type」）。 */
  async update(
    eventId: string,
    evidenceId: string,
    input: UpdateEvidenceInput,
    actorUserId: string,
  ): Promise<EvidenceMutationResponse> {
    const before = await this.repository.findEvidence(eventId, evidenceId);
    if (before === null) throw this.evidenceNotFound(eventId, evidenceId);

    const url = input.url === undefined ? undefined : normalizeEvidenceUrl(input.url);

    const updated = await this.repository.updateEvidence({
      eventId,
      evidenceId,
      ...(input.evidenceType === undefined ? {} : { evidenceType: input.evidenceType }),
      ...(input.title === undefined ? {} : { title: clamp(input.title, MAX_EVIDENCE_TITLE_LENGTH) }),
      ...(url === undefined ? {} : { url, urlHash: hashEvidenceUrl(url) }),
    });
    if (updated === null) throw this.evidenceNotFound(eventId, evidenceId);

    writeAudit(this.logger, {
      event: AuditEvent.EVIDENCE_UPDATED,
      actorUserId,
      target: { eventId, evidenceId },
      detail: {
        before: { evidenceType: before.evidenceType, title: before.title, url: before.url },
        after: { evidenceType: updated.evidenceType, title: updated.title, url: updated.url },
      },
    });

    return this.mutationResponse(eventId, updated, actorUserId);
  }

  /**
   * 删除一条证据（`docs/09` 的「删除错误 Evidence」）。
   *
   * ⚠ 删除**允许删掉 Primary** —— 那会让事件暂时没有 Primary，
   * 这是正确的：管理员刚指出「这条证据是错的」，此时硬留一个没人认的
   * Primary 比没有更糟。下次自动挂接会重选。
   */
  async remove(
    eventId: string,
    evidenceId: string,
    actorUserId: string,
  ): Promise<{ eventId: string; deleted: true; independentSourceCount: number }> {
    const before = await this.repository.findEvidence(eventId, evidenceId);
    if (before === null) throw this.evidenceNotFound(eventId, evidenceId);

    const deleted = await this.repository.deleteEvidence(eventId, evidenceId);
    if (!deleted) throw this.evidenceNotFound(eventId, evidenceId);

    writeAudit(this.logger, {
      event: AuditEvent.EVIDENCE_DELETED,
      actorUserId,
      target: { eventId, evidenceId },
      detail: { url: before.url, evidenceType: before.evidenceType, wasPrimary: before.isPrimary },
    });

    const stats = await this.repository.eventEvidenceStats([eventId]);
    return {
      eventId,
      deleted: true,
      independentSourceCount: stats.get(eventId)?.independentSourceCount ?? 0,
    };
  }

  /** 设为 Primary（`docs/09`）。事务保证「先清旧的、再设新的」。 */
  async setPrimary(
    eventId: string,
    evidenceId: string,
    actorUserId: string,
  ): Promise<EvidenceMutationResponse> {
    const result = await this.repository.setPrimaryEvidence(eventId, evidenceId);
    if (result === null) throw this.evidenceNotFound(eventId, evidenceId);

    const evidence = await this.repository.findEvidence(eventId, evidenceId);
    if (evidence === null) throw this.evidenceNotFound(eventId, evidenceId);

    writeAudit(this.logger, {
      event: AuditEvent.EVIDENCE_PRIMARY_SET,
      actorUserId,
      target: { eventId, evidenceId },
      detail: { url: evidence.url, evidenceType: evidence.evidenceType },
    });

    return this.mutationResponse(eventId, evidence, actorUserId);
  }

  /* ---------------------------------------------------------------- */

  /**
   * 组装变更响应。
   *
   * 每次都把**当前 Primary 与独立来源数**一起返回 —— 管理员刚改完证据链，
   * 他最需要的两个数字就是「现在谁是正本」和「现在有几个独立来源」，
   * 让前端再发两个请求去取是没必要的往返。
   */
  private async mutationResponse(
    eventId: string,
    evidence: EvidenceRow,
    _actorUserId: string,
  ): Promise<EvidenceMutationResponse> {
    const [event, stats] = await Promise.all([
      this.repository.findEventDetail(eventId),
      this.repository.eventEvidenceStats([eventId]),
    ]);

    return {
      eventId,
      evidence: {
        evidenceId: evidence.evidenceId,
        evidenceType: evidence.evidenceType,
        title: evidence.title,
        url: evidence.url,
        publishedAt: evidence.publishedAt,
        isPrimary: evidence.isPrimary,
        contentId: evidence.contentId,
        source: evidence.source,
      },
      primaryEvidenceId:
        event?.evidences.find((item) => item.isPrimary)?.evidenceId ?? null,
      independentSourceCount: stats.get(eventId)?.independentSourceCount ?? 0,
    };
  }

  /** 关联内容的 `sourceId`（证据继承来源用）。查不到时返回 `null`。 */
  private async sourceIdOfContent(contentId: string): Promise<string | null> {
    const content = await this.repository.findReviewDetailContent(contentId);
    return content === null ? null : content.source.id;
  }

  private eventNotFound(eventId: string): AppError {
    return new AppError({
      code: PlatformErrorCode.NOT_FOUND,
      httpStatus: 404,
      safeMessage: `Event not found: ${eventId}`,
      details: { eventId },
    });
  }

  private evidenceNotFound(eventId: string, evidenceId: string): AppError {
    return new AppError({
      code: PlatformErrorCode.NOT_FOUND,
      httpStatus: 404,
      safeMessage: `Evidence not found in this event: ${evidenceId}`,
      details: { eventId, evidenceId },
    });
  }
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

/** 解析可选的 ISO 日期。非法值 → 400（而不是静默当 null）。 */
function parseOptionalDate(value: string | null | undefined): Date | null {
  if (value === null || value === undefined) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new AppError({
      code: PlatformErrorCode.VALIDATION_FAILED,
      httpStatus: 400,
      safeMessage: 'publishedAt must be an ISO date-time string',
      details: { fields: ['publishedAt'] },
    });
  }
  return parsed;
}

/** 按**字符**截断（对齐 `VarChar` 的语义）。 */
function clamp(value: string | null, max: number): string | null {
  if (value === null) return null;
  const codePoints = Array.from(value);
  return codePoints.length <= max ? value : codePoints.slice(0, max).join('');
}

/** 供测试与 DTO 层复用。 */
export { EvidenceType };
