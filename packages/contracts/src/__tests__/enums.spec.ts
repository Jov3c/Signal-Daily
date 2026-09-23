import { describe, expect, it } from 'vitest';
import {
  AI_TASK_TYPES,
  ARTICLE_FONT_SIZES,
  CONTENT_PIPELINE_STATUSES,
  CONTENT_TYPES,
  DAILY_DISPLAY_STYLES,
  DAILY_EDITION_STATUSES,
  DAILY_SECTION_TYPES,
  EDITORIAL_REVIEW_STATUSES,
  EVIDENCE_TYPES,
  RAW_ITEM_STATUSES,
  SOURCE_KINDS,
  SOURCE_TIERS,
  SOURCE_TYPES,
  USER_ROLES,
  USER_STATUSES,
  USER_THEMES,
  AiTaskType,
  AiRunStatus,
  ArticleFontSize,
  ContentPipelineStatus,
  ContentType,
  DailyDisplayStyle,
  DailyEditionStatus,
  DailySectionType,
  EditorialReviewStatus,
  EvidenceType,
  JobRunStatus,
  RawItemStatus,
  SourceKind,
  SourceTier,
  SourceType,
  UserRole,
  UserStatus,
  UserTheme,
} from '../index';

/**
 * 这些断言逐条对照 `docs/05-enums-state-machines.md` v1.1。
 * 任何一个枚举值被改动/拼错，此测试立即失败。
 */
describe('docs/05 枚举契约', () => {
  it('SourceType = 采集 Adapter', () => {
    expect(SOURCE_TYPES).toEqual([
      'RSS',
      'X_USER',
      'GITHUB_REPO',
      'HACKER_NEWS',
      'HUGGINGFACE',
      'MANUAL_URL',
    ]);
  });

  it('SourceKind = 来源业务身份', () => {
    expect(SOURCE_KINDS).toEqual([
      'OFFICIAL',
      'PERSON',
      'MEDIA',
      'COMMUNITY',
      'DEVELOPER',
      'GOVERNMENT',
      'TREND',
    ]);
  });

  it('SourceTier = S/A/B/C', () => {
    expect(SOURCE_TIERS).toEqual(['S', 'A', 'B', 'C']);
  });

  it('EvidenceType 五类证据', () => {
    expect(EVIDENCE_TYPES).toEqual([
      'PRIMARY_SOURCE',
      'OFFICIAL_CONFIRMATION',
      'SUPPORTING_SOURCE',
      'SOCIAL_CONFIRMATION',
      'RELATED_DISCUSSION',
    ]);
  });

  it('ContentType 七类', () => {
    expect(CONTENT_TYPES).toEqual([
      'ARTICLE',
      'X_POST',
      'GITHUB_REPO',
      'GITHUB_RELEASE',
      'HN_STORY',
      'MODEL',
      'SHORT_POST',
    ]);
  });

  it('RawItemStatus', () => {
    expect(RAW_ITEM_STATUSES).toEqual([
      'FETCHED',
      'NORMALIZED',
      'DUPLICATE',
      'READY_FOR_ANALYSIS',
      'FAILED',
    ]);
  });

  it('ContentPipelineStatus', () => {
    expect(CONTENT_PIPELINE_STATUSES).toEqual([
      'INGESTED',
      'ANALYZING',
      'REVIEW_PENDING',
      'APPROVED',
      'REJECTED',
      'ARCHIVED',
    ]);
  });

  it('EditorialReviewStatus = PENDING/APPROVED/REJECTED/DEFERRED', () => {
    expect(EDITORIAL_REVIEW_STATUSES).toEqual(['PENDING', 'APPROVED', 'REJECTED', 'DEFERRED']);
  });

  it('DailyEditionStatus', () => {
    expect(DAILY_EDITION_STATUSES).toEqual([
      'DRAFT',
      'REVIEWING',
      'SCHEDULED',
      'PUBLISHED',
      'CANCELLED',
    ]);
  });

  it('DailySectionType', () => {
    expect(DAILY_SECTION_TYPES).toEqual([
      'FRONT_PAGE',
      'AI',
      'PRODUCT',
      'DEVELOPMENT',
      'TECH',
      'X_VOICES',
      'BRIEFS',
    ]);
  });

  it('DailyDisplayStyle', () => {
    expect(DAILY_DISPLAY_STYLES).toEqual(['LEAD', 'MAJOR', 'STANDARD', 'BRIEF']);
  });

  it('UserRole / UserStatus', () => {
    expect(USER_ROLES).toEqual(['USER', 'ADMIN']);
    expect(USER_STATUSES).toEqual(['ACTIVE', 'DISABLED']);
  });

  it('UserPreference 子枚举', () => {
    expect(USER_THEMES).toEqual(['LIGHT', 'DARK', 'SYSTEM']);
    expect(ARTICLE_FONT_SIZES).toEqual(['SMALL', 'DEFAULT', 'LARGE']);
  });

  it('AiTaskType', () => {
    expect(AI_TASK_TYPES).toEqual([
      'LANGUAGE_DETECT',
      'TRANSLATE',
      'CLASSIFY',
      'SCORE',
      'DEDUP_VERIFY',
      'EVENT_CLUSTER',
      'DAILY_DRAFT',
    ]);
  });

  it('枚举成员名与值一一对应（防止改名不改值）', () => {
    const pairs: [Record<string, string>, string[]][] = [
      [SourceType, SOURCE_TYPES],
      [SourceKind, SOURCE_KINDS],
      [SourceTier, SOURCE_TIERS],
      [EvidenceType, EVIDENCE_TYPES],
      [ContentType, CONTENT_TYPES],
      [RawItemStatus, RAW_ITEM_STATUSES],
      [ContentPipelineStatus, CONTENT_PIPELINE_STATUSES],
      [EditorialReviewStatus, EDITORIAL_REVIEW_STATUSES],
      [DailyEditionStatus, DAILY_EDITION_STATUSES],
      [DailySectionType, DAILY_SECTION_TYPES],
      [DailyDisplayStyle, DAILY_DISPLAY_STYLES],
      [UserRole, USER_ROLES],
      [UserStatus, USER_STATUSES],
      [UserTheme, USER_THEMES],
      [ArticleFontSize, ARTICLE_FONT_SIZES],
      [AiTaskType, AI_TASK_TYPES],
      [AiRunStatus, Object.values(AiRunStatus)],
      [JobRunStatus, Object.values(JobRunStatus)],
    ];

    for (const [enumObject, values] of pairs) {
      for (const value of values) {
        expect(enumObject[value]).toBe(value);
      }
    }
  });
});
