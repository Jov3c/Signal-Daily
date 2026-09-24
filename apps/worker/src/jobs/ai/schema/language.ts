/**
 * 语言代码规范化。
 *
 * 为什么需要一个专门的函数：`contents.language` 是 **`CHAR(5)`**
 * （Agent 01 的 schema）。模型很乐意返回 `chinese`、`zh-Hans-CN`、
 * `Chinese (Simplified)` 这类东西 —— 它们要么超出 5 个字符被数据库报错，
 * 要么被静默截断成 `chine`，于是搜索/过滤按语言筛选就永远匹配不上。
 *
 * 规则：接受一个宽松的输入，收敛成 `ll` 或 `ll-RR` 两种形态；
 * 无法收敛时返回 `null`，由调用方决定（翻译任务必须要有语言，
 * 因此会变成 schema 校验失败 → 重试 1 次 → 失败）。
 */

/** `ll` 或 `ll-RR`（共 2 或 5 字符，正好落在 `CHAR(5)` 内）。 */
export const LANGUAGE_CODE_PATTERN = /^[a-z]{2}(-[A-Z]{2})?$/;

/** 常见语言名 → ISO 639-1 的兜底映射（模型偶尔坚持说人话）。 */
const LANGUAGE_NAME_ALIASES: Readonly<Record<string, string>> = {
  chinese: 'zh',
  'chinese (simplified)': 'zh',
  'simplified chinese': 'zh',
  'chinese (traditional)': 'zh-TW',
  'traditional chinese': 'zh-TW',
  english: 'en',
  japanese: 'ja',
  korean: 'ko',
  french: 'fr',
  german: 'de',
  spanish: 'es',
  russian: 'ru',
  portuguese: 'pt',
  italian: 'it',
};

/**
 * 把模型的输出收敛成合法语言代码。
 *
 * @returns 合法的 `ll` / `ll-RR`，或 `null`
 */
export function normalizeLanguageCode(value: unknown): string | null {
  if (typeof value !== 'string') return null;

  const trimmed = value.trim();
  if (trimmed === '') return null;

  const alias = LANGUAGE_NAME_ALIASES[trimmed.toLowerCase()];
  if (alias !== undefined) return alias;

  // `zh_CN` / `zh-CN` / `zh-cn` / `ZH` 都收敛到同一种形态。
  const parts = trimmed.replace(/_/g, '-').split('-');
  const primary = (parts[0] ?? '').toLowerCase();
  if (!/^[a-z]{2}$/.test(primary)) return null;

  const region = parts[1];
  if (region === undefined || region === '') return primary;

  // 只保留「两字母地区」这一种形态：`zh-Hans` 这类 script 子标签无法塞进
  // CHAR(5)，宁可回退到主语言也不要一个会被截断的值。
  return /^[a-zA-Z]{2}$/.test(region) ? `${primary}-${region.toUpperCase()}` : primary;
}

/** 判断字符串是否已经是合法的契约语言代码。 */
export function isValidLanguageCode(value: string): boolean {
  return LANGUAGE_CODE_PATTERN.test(value);
}
