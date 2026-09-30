/**
 * 展示用的格式化 —— **纯函数，`now` 一律由调用方传入**。
 *
 * ── 为什么每个函数都要一个 `now` 参数 ────────────────────────────────
 * 两个理由，都不是洁癖：
 *
 * 1. **可测**。「3 小时前」这种断言，如果函数内部自己 `new Date()`，
 *    测试就只能写一个很宽的区间（或者用假时钟）。
 * 2. **不会水合不匹配**。服务端渲染出「2h」，客户端水合时已经是「3h」——
 *    React 会报 hydration mismatch 并且**丢掉服务端那份**。
 *    把 `now` 提到调用方，就意味着时间文案只在服务端算一次，
 *    客户端不再自己算（见 `components/cards.tsx` 的注释）。
 *
 * 全部按**上海业务时区**展示（`docs/00` 的冻结时区），不是浏览器本地时区 ——
 * 否则同一篇文章在不同时区的同事屏幕上会显示不同的日期。
 */

import { BUSINESS_TIMEZONE } from '@signal/contracts';

/** 上海时区下的日历片段。 */
type ShanghaiParts = {
  year: string;
  month: string;
  day: string;
  hour: string;
  minute: string;
  weekday: string;
};

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'] as const;

/** 把时刻拆成上海时区的各个片段。用 `Intl` 而不是手算偏移。 */
export function shanghaiParts(instant: Date): ShanghaiParts {
  const formatter = new Intl.DateTimeFormat('zh-CN', {
    timeZone: BUSINESS_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    weekday: 'short',
  });

  const parts = new Map(
    formatter.formatToParts(instant).map((part) => [part.type, part.value] as const),
  );

  // 星期几单独取一次：上面那个 formatter 在部分 Node 版本里会给出
  // 「周二」之外的写法（如「星期二」），这里统一成原型用的短式。
  const weekdayIndex = new Intl.DateTimeFormat('en-US', {
    timeZone: BUSINESS_TIMEZONE,
    weekday: 'short',
  })
    .format(instant)
    .slice(0, 3);
  const weekday =
    WEEKDAYS[['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(weekdayIndex)] ?? '';

  return {
    year: parts.get('year') ?? '',
    month: parts.get('month') ?? '',
    day: parts.get('day') ?? '',
    hour: parts.get('hour') ?? '00',
    minute: parts.get('minute') ?? '00',
    weekday,
  };
}

/** `2026 年 9 月 22 日 · 周二`（原型的 `.page-head` 眉题）。 */
export function longBusinessDate(instant: Date): string {
  const p = shanghaiParts(instant);
  return `${p.year} 年 ${String(Number(p.month))} 月 ${String(Number(p.day))} 日 · ${p.weekday}`;
}

/** `2026.09.22`（文章页的 meta）。 */
export function dottedDate(instant: Date): string {
  const p = shanghaiParts(instant);
  return `${p.year}.${p.month}.${p.day}`;
}

/** `13:42`（今天的条目只要时刻）。 */
export function clockTime(instant: Date): string {
  const p = shanghaiParts(instant);
  return `${p.hour}:${p.minute}`;
}

/**
 * 相对时间：`2h` / `4h` / `3d` / `09-21`。
 *
 * 原型在 X 动态里用 `2h` 这种短式。**超过 24 小时就换成日期** ——
 * 「54h」比「09-21」更难读，而 X 动态的时效性本来就在一天以内。
 */
export function shortRelative(instant: Date, now: Date): string {
  const diffMs = now.getTime() - instant.getTime();
  if (diffMs < 0) {
    // 未来时间：说明时钟有偏差。如实显示日期，不要编出「-1h」。
    const p = shanghaiParts(instant);
    return `${p.month}-${p.day}`;
  }

  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${String(minutes)}m`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${String(hours)}h`;

  const p = shanghaiParts(instant);
  return `${p.month}-${p.day}`;
}

/**
 * 阅读时长。按**中文正文 350 字/分钟**估（比英文的 200 词/分钟快得多，
 * 因为这里统计的是字符数）。
 *
 * 最少 1 分钟：原型里没有「0 min read」，那看起来像坏掉了。
 */
export function readingMinutes(text: string | null | undefined): number {
  if (text === null || text === undefined) return 1;
  const length = text.trim().length;
  return Math.max(1, Math.round(length / 350));
}

/** `8 min read`。 */
export function readingLabel(text: string | null | undefined): string {
  return `${String(readingMinutes(text))} min read`;
}

/** 头像上的缩写：`Andrej Karpathy` → `AK`；只有一段时取前两个字符。 */
export function initialsOf(name: string): string {
  const words = name
    .trim()
    .split(/\s+/)
    .filter((word) => word !== '');
  if (words.length === 0) return '?';
  if (words.length === 1) return (words[0] ?? '').slice(0, 2).toUpperCase();
  const first = words[0]?.[0] ?? '';
  const last = words[words.length - 1]?.[0] ?? '';
  return `${first}${last}`.toUpperCase();
}

/** 把 0–1 的进度说成人话。 */
export function progressPercent(progress: number): string {
  return `${String(Math.round(Math.min(Math.max(progress, 0), 1) * 100))}%`;
}

/**
 * 业务日 `2026-09-30` → `2026 年 9 月 30 日`。
 *
 * 输入是**字符串**（`BusinessDate`），不是 Date —— 业务日没有时刻，
 * 用 Date 承载会引入一个「用哪个时区解释它」的问题，而那个问题没有意义。
 */
export function formatBusinessDate(businessDate: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(businessDate);
  if (match === null) return businessDate;
  return `${match[1] ?? ''} 年 ${String(Number(match[2]))} 月 ${String(Number(match[3]))} 日`;
}

/** 该业务日的星期几（用于日报页的眉题）。 */
export function businessDateWeekday(businessDate: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(businessDate);
  if (match === null) return '';
  const instant = new Date(
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 4, 0, 0),
  );
  return shanghaiParts(instant).weekday;
}

/**
 * 报纸刊头那一行英文日期：`TUESDAY, SEPTEMBER 22, 2026`。
 *
 * 用 `en-US` 而不是自己拼月份名 —— 业务日的月份名是展示用的英文，
 * 自己维护一张 `JANUARY…DECEMBER` 表只会在某个月份多一个字母时出错。
 *
 * 业务日是**字符串**（`YYYY-MM-DD`）而不是时刻，所以这里手工构造一个
 * 该日的上海中午（UTC 04:00）再交给 `Intl`：挑中午是为了离两端各有
 * 12 小时余量，任何时区解释都不会把它挪到相邻的那一天。
 */
export function englishBusinessDate(businessDate: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(businessDate);
  if (match === null) return '';
  const noonUtc = new Date(
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 4, 0, 0),
  );
  return new Intl.DateTimeFormat('en-US', {
    timeZone: BUSINESS_TIMEZONE,
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  })
    .format(noonUtc)
    .toUpperCase();
}

/**
 * 把一行业务日平移若干天。
 *
 * ⚠ 与 `apps/api/src/modules/admin-ops/service.ts` 的 `shiftBusinessDate`
 * 是同一份逻辑的**第二份实现**（前端 import 不了 apps/api）。
 * 两边都有测试，而且这个函数只有 6 行 —— 比起为了共享它去动
 * Agent 00 的冻结包，重复一份更划算。已记入 CCR-agent-13。
 */
export function shiftBusinessDate(businessDate: string, deltaDays: number): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(businessDate);
  if (match === null) return businessDate;
  const shifted = new Date(
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) + deltaDays * 86_400_000,
  );
  return shifted.toISOString().slice(0, 10);
}

/**
 * 中文标题 → 锚点片段。
 *
 * `Intl` 的 `\p{Letter}` 保留中文（它们**是**字母），所以
 * 「AI 与产品」→ `ai-与产品`。全部剔除会得到空串，那种情况下
 * 退回一个稳定前缀 + 长度，避免所有锚点都变成 `#`。
 */
export function slugify(text: string): string {
  const normalized = text
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^\p{Letter}\p{Number}-]+/gu, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '');
  return normalized === '' ? `section-${String(text.length)}` : normalized;
}
