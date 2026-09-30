/**
 * 日报编辑面的请求解析与校验。
 *
 * 手写校验（与 Agent 02/03/07 同一取舍）：
 * 1. 能把**所有**错误一次收齐再返回，而不是遇到第一个就退出；
 * 2. 校验规则本身就是契约（`docs/10`），写在代码里比写在装饰器里好读；
 * 3. 本模块要区分「版块整体替换」里的结构性错误与可截断的展示字段 ——
 *    这是装饰器表达不了的。
 */

import {
  DAILY_DISPLAY_STYLES,
  DAILY_EDITION_STATUSES,
  DAILY_SECTION_TYPES,
  DAILY_TARGET_PUBLISH_HOUR,
  isBusinessDate,
  type DailyDisplayStyle,
  type DailyEditionStatus,
  type DailySectionType,
} from '@signal/contracts';
import { invalid } from '../../common/validation';
import {
  MAX_CUSTOM_EXCERPT_LENGTH,
  MAX_CUSTOM_HEADLINE_LENGTH,
  MAX_EDITION_HEADLINE_LENGTH,
  MAX_ITEMS_PER_SECTION,
  MAX_SECTIONS,
  MAX_SECTION_TITLE_LENGTH,
  clampChars,
} from './limits';

// 本模块原先自带 `invalid` 的副本，现在统一从 `common/validation` 引用；
// 对外仍继续导出，保持既有的导入面不变。
export { invalid };

/** 请求体必须是 JSON 对象。 */
export function asRecord(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw invalid(['body: must be a JSON object']);
  }
  return body as Record<string, unknown>;
}

/** 一个 `YYYY-MM-DD` 业务日路径参数。 */
export function parseBusinessDate(value: string): string {
  if (!isBusinessDate(value)) {
    throw invalid(['date: must be a valid YYYY-MM-DD business date']);
  }
  return value;
}

/** 年月查询参数（后台列表与公开归档共用）。 */
export type YearMonth = { year: number; month: number };

/**
 * 解析 `?year=&month=`。
 *
 * 默认值取「当月」而不是报错：后台列表一打开就该有内容。
 * 但**给了非法值就报错**（而不是静默回落到当月）——
 * 否则管理员筛 2026-13 会看到当月数据并以为筛选生效了。
 */
export function parseYearMonth(query: Record<string, unknown>, now: Date): YearMonth {
  const errors: string[] = [];

  const yearRaw = query['year'];
  const monthRaw = query['month'];

  let year: number;
  let month: number;

  if (yearRaw === undefined || yearRaw === '') {
    year = Number(currentBusinessYearMonth(now).year);
  } else {
    const parsed = Number(yearRaw);
    if (!Number.isInteger(parsed) || parsed < 2000 || parsed > 9999) {
      errors.push('year: must be an integer between 2000 and 9999');
      year = 0;
    } else {
      year = parsed;
    }
  }

  if (monthRaw === undefined || monthRaw === '') {
    month = Number(currentBusinessYearMonth(now).month);
  } else {
    const parsed = Number(monthRaw);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 12) {
      errors.push('month: must be an integer between 1 and 12');
      month = 0;
    } else {
      month = parsed;
    }
  }

  if (errors.length > 0) throw invalid(errors);
  return { year, month };
}

/** 当前**业务**（上海）时区的年与月。 */
function currentBusinessYearMonth(now: Date): { year: string; month: string } {
  // `Intl` 而不是手算偏移：上海没有夏令时，但手算偏移的写法一旦被复制到
  // 别的时区就会静默出错，而 `Intl` 的意图一眼可读。
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(now);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '01';
  return { year: get('year'), month: get('month') };
}

/** 把 `{year, month}` 换算成半开区间 `[from, to)` 的业务日字符串。 */
export function monthRange(input: YearMonth): { from: string; to: string } {
  const pad = (value: number): string => String(value).padStart(2, '0');
  const from = `${input.year}-${pad(input.month)}-01`;
  const nextYear = input.month === 12 ? input.year + 1 : input.year;
  const nextMonth = input.month === 12 ? 1 : input.month + 1;
  return { from, to: `${nextYear}-${pad(nextMonth)}-01` };
}

/** 后台列表的 `?status=`。 */
export function parseOptionalStatus(
  query: Record<string, unknown>,
): DailyEditionStatus | undefined {
  const raw = query['status'];
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw !== 'string' || !(DAILY_EDITION_STATUSES as readonly string[]).includes(raw)) {
    throw invalid([`status: must be one of ${DAILY_EDITION_STATUSES.join(', ')}`]);
  }
  return raw as DailyEditionStatus;
}

/** 写入用的版块形状（已截断、已去重校验）。 */
export type SectionBody = {
  type: DailySectionType;
  title: string;
  sortOrder: number;
  items: {
    contentId: string;
    displayStyle: DailyDisplayStyle;
    sortOrder: number;
    customHeadline: string | null;
    customExcerpt: string | null;
  }[];
};

export type SectionsBody = {
  headline: string | null | undefined;
  sections: SectionBody[];
};

/**
 * 解析「整体替换版块」的请求体。
 *
 * 结构性错误**报错**（未知版块类型、重复的 sortOrder、缺 contentId）；
 * 展示字段**截断**（标题/摘要过长）。
 *
 * 为什么 sortOrder 要在这里专门查一次：DB 有
 * `@@unique([editionId, sortOrder])` 与 `@@unique([sectionId, sortOrder])`，
 * 重复会在写入时抛 P2002 —— 一个「看起来像服务器错误」的 500。
 * 管理员拖错了顺序不该看到 500。
 */
export function parseSectionsBody(body: unknown): SectionsBody {
  const record = asRecord(body);
  const errors: string[] = [];

  const headlineRaw = record['headline'];
  if (headlineRaw !== undefined && headlineRaw !== null && typeof headlineRaw !== 'string') {
    errors.push('headline: must be a string or null');
  }

  const sectionsRaw = record['sections'];
  if (!Array.isArray(sectionsRaw)) {
    errors.push('sections: must be an array');
    throw invalid(errors);
  }
  if (sectionsRaw.length > MAX_SECTIONS) {
    errors.push(`sections: at most ${MAX_SECTIONS} sections are allowed`);
  }

  const seenTypes = new Set<string>();
  const seenSectionOrders = new Set<number>();
  const sections: SectionBody[] = [];

  sectionsRaw.forEach((raw, sectionIndex) => {
    const at = `sections[${sectionIndex}]`;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      errors.push(`${at}: must be an object`);
      return;
    }
    const section = raw as Record<string, unknown>;

    const typeRaw = section['type'];
    if (
      typeof typeRaw !== 'string' ||
      !(DAILY_SECTION_TYPES as readonly string[]).includes(typeRaw)
    ) {
      errors.push(`${at}.type: must be one of ${DAILY_SECTION_TYPES.join(', ')}`);
    } else if (seenTypes.has(typeRaw)) {
      // 同一期两个同类型版块：前台要么二选一、要么并列渲染，两种都不是
      // `docs/10` 描述的结构。这里直接拒绝，而不是留一个无人能解释的状态。
      errors.push(`${at}.type: duplicate section type ${typeRaw}`);
    } else {
      seenTypes.add(typeRaw);
    }

    const titleRaw = section['title'];
    if (typeof titleRaw !== 'string' || titleRaw.trim() === '') {
      errors.push(`${at}.title: must be a non-empty string`);
    }

    const sortOrderRaw = section['sortOrder'];
    if (!Number.isInteger(sortOrderRaw)) {
      errors.push(`${at}.sortOrder: must be an integer`);
    } else if (seenSectionOrders.has(sortOrderRaw as number)) {
      errors.push(`${at}.sortOrder: duplicate sortOrder ${String(sortOrderRaw)}`);
    } else {
      seenSectionOrders.add(sortOrderRaw as number);
    }

    const itemsRaw = section['items'];
    const items: SectionBody['items'] = [];
    if (!Array.isArray(itemsRaw)) {
      errors.push(`${at}.items: must be an array`);
    } else {
      if (itemsRaw.length > MAX_ITEMS_PER_SECTION) {
        errors.push(`${at}.items: at most ${MAX_ITEMS_PER_SECTION} items are allowed`);
      }
      const seenItemOrders = new Set<number>();
      const seenContentIds = new Set<string>();

      itemsRaw.forEach((rawItem, itemIndex) => {
        const itemAt = `${at}.items[${itemIndex}]`;
        if (typeof rawItem !== 'object' || rawItem === null || Array.isArray(rawItem)) {
          errors.push(`${itemAt}: must be an object`);
          return;
        }
        const item = rawItem as Record<string, unknown>;

        const contentIdRaw = item['contentId'];
        if (typeof contentIdRaw !== 'string' || !/^\d{1,20}$/.test(contentIdRaw)) {
          errors.push(`${itemAt}.contentId: must be a decimal string`);
        } else if (seenContentIds.has(contentIdRaw)) {
          // `@@unique([sectionId, contentId])` —— 同一版块里同一条内容只能出现一次。
          errors.push(`${itemAt}.contentId: duplicate contentId in this section`);
        } else {
          seenContentIds.add(contentIdRaw);
        }

        const styleRaw = item['displayStyle'];
        if (
          typeof styleRaw !== 'string' ||
          !(DAILY_DISPLAY_STYLES as readonly string[]).includes(styleRaw)
        ) {
          errors.push(`${itemAt}.displayStyle: must be one of ${DAILY_DISPLAY_STYLES.join(', ')}`);
        }

        const itemOrderRaw = item['sortOrder'];
        if (!Number.isInteger(itemOrderRaw)) {
          errors.push(`${itemAt}.sortOrder: must be an integer`);
        } else if (seenItemOrders.has(itemOrderRaw as number)) {
          errors.push(`${itemAt}.sortOrder: duplicate sortOrder ${String(itemOrderRaw)}`);
        } else {
          seenItemOrders.add(itemOrderRaw as number);
        }

        const customHeadlineRaw = item['customHeadline'];
        if (
          customHeadlineRaw !== undefined &&
          customHeadlineRaw !== null &&
          typeof customHeadlineRaw !== 'string'
        ) {
          errors.push(`${itemAt}.customHeadline: must be a string or null`);
        }

        const customExcerptRaw = item['customExcerpt'];
        if (
          customExcerptRaw !== undefined &&
          customExcerptRaw !== null &&
          typeof customExcerptRaw !== 'string'
        ) {
          errors.push(`${itemAt}.customExcerpt: must be a string or null`);
        }

        if (errors.some((message) => message.startsWith(itemAt))) return;

        items.push({
          contentId: contentIdRaw as string,
          displayStyle: styleRaw as DailyDisplayStyle,
          sortOrder: itemOrderRaw as number,
          customHeadline: clampChars(
            typeof customHeadlineRaw === 'string' ? customHeadlineRaw : null,
            MAX_CUSTOM_HEADLINE_LENGTH,
          ),
          customExcerpt: clampChars(
            typeof customExcerptRaw === 'string' ? customExcerptRaw : null,
            MAX_CUSTOM_EXCERPT_LENGTH,
          ),
        });
      });
    }

    if (errors.some((message) => message.startsWith(at))) return;

    sections.push({
      type: typeRaw as DailySectionType,
      title: clampChars(titleRaw as string, MAX_SECTION_TITLE_LENGTH) as string,
      sortOrder: sortOrderRaw as number,
      items,
    });
  });

  if (errors.length > 0) throw invalid(errors);

  return {
    headline:
      headlineRaw === undefined
        ? undefined
        : clampChars(
            typeof headlineRaw === 'string' ? headlineRaw : null,
            MAX_EDITION_HEADLINE_LENGTH,
          ),
    sections,
  };
}

/**
 * 校验排期请求体。
 *
 * ── ⚠ **排期不接受自定义时刻**（这是一个刻意的决定，见 `service.schedule()`）──
 * `docs/10` 的模型里「排期」= 把这一期标记为「到目标时刻就可以上」，
 * 而目标时刻是**契约常量**（`DAILY_TARGET_PUBLISH_HOUR` = 上海 08:00）。
 * 管理员要「现在就发」有另一条路：`POST …/publish`。
 *
 * ── 为什么传了就 **400**，而不是忽略 ─────────────────────────────────
 * 本模块第一版接受一个 `scheduledAt` 并把它存进库、**却没有任何代码读它**
 *（§23 独立审查的 P2）。后果是：管理员传 `20:00` 以为晚上发，
 * 而 worker 在 08:00 那一班就发出去了 —— 一个**被静默兑现错的承诺**。
 *
 * 现在有两条出路，两条都必须**说清**：
 *
 * - 传了 `scheduledAt` → 400，并在错误里说明「排期固定用该业务日的上海
 *   08:00；要立刻发出请用 POST …/publish」——
 *   沉默地接受、沉默地忽略，正是第一版的错。
 * - 传了别的未知字段 → 也 400（把「这个接口没有参数」讲明白）。
 */
export function parseScheduleBody(body: unknown): void {
  const record = body === undefined || body === null ? {} : asRecord(body);
  const keys = Object.keys(record).filter((key) => record[key] !== undefined);
  if (keys.length === 0) return;

  if (keys.includes('scheduledAt')) {
    throw invalid([
      'scheduledAt: scheduling always uses the edition target time ' +
        `(Asia/Shanghai ${String(DAILY_TARGET_PUBLISH_HOUR).padStart(2, '0')}:00) — ` +
        'to publish right now use POST /admin/daily/{date}/publish',
    ]);
  }

  throw invalid([
    `body: this endpoint takes no parameters (got: ${keys.join(', ')}) — ` +
      'scheduling always uses the edition target time; use POST /admin/daily/{date}/publish to publish now',
  ]);
}
