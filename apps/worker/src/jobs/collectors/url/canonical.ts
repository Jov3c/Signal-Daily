/**
 * 链接归一化 —— 去重的第一道地基。
 *
 * `docs/06` 的幂等三键里，第 2 条是「canonical URL hash」。它只有在
 * **同一个页面的不同写法被归一化成同一个字符串**时才有意义。
 * 现实里同一个页面至少有这些写法：
 *
 * ```
 * https://Example.com/post          ← 主机大小写
 * https://example.com:443/post      ← 默认端口显式写出
 * https://example.com/post#comments ← 锚点
 * https://example.com/post?utm_source=x&utm_medium=social
 * https://example.com/post/?        ← 尾斜杠
 * ```
 *
 * 不归一化的话，同一篇文章会被抓成 5 条 RawItem，
 * 而 `docs/07` 的「Exact Dedup」与 `docs/22` 的
 * 「同 Source 重复只能算 1 个独立来源」会一起失效。
 *
 * ── 刻意保持保守的地方 ──────────────────────────────────────────────
 * 只丢掉**明确是跟踪参数**的那些键。不认识的查询参数一律保留 ——
 * 很多站点用查询串承载真实内容（`?id=123`、`?p=456`），
 * 激进地「只留 path」会把不同的页面判成同一条，那是**漏掉真内容**，
 * 比多抓几条严重得多。
 */

/**
 * 明确无内容语义的跟踪参数。
 *
 * 判断标准：**去掉它页面内容不会变**。所以 `ref`（有些站点用它做
 * 真实路由）不在列表里 —— 宁可少归一化一条，也不要误合并两条。
 */
const TRACKING_PARAMS: readonly string[] = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'utm_id',
  'utm_name',
  'utm_reader',
  'fbclid',
  'gclid',
  'gbraid',
  'wbraid',
  'msclkid',
  'yclid',
  'igshid',
  'mc_cid',
  'mc_eid',
  '_hsenc',
  '_hsmi',
  'hsCtaTracking',
  'spm',
  'scm',
  'share_token',
  'trk',
  'trkCampaign',
];

const DEFAULT_PORTS: Readonly<Record<string, string>> = {
  'http:': '80',
  'https:': '443',
};

/**
 * 把可能相对的链接解析成绝对 http(s) 地址。
 *
 * 解析失败、或 scheme 不是 http(s)（`mailto:` / `javascript:` / `data:`）
 * 时返回 `null` —— 这类链接**不能**当作 `originalUrl`：
 * `docs/00` 要求「任何公开内容必须可追溯到原始来源」，
 * 而 `javascript:` 追溯不到任何东西。调用方应当跳过该条目并计数。
 */
export function resolveItemUrl(raw: string | null, base: string | null): URL | null {
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;

  // 先按绝对地址试，失败再按相对地址拼 base。
  // 顺序不能反：`new URL('https://x/y', base)` 也成立，但那样会把
  // 一个本来正确的绝对地址重新拼到 base 上（feed 里的绝对链接很常见）。
  const candidates = [trimmed];
  if (base !== null) {
    const joined = joinRelative(trimmed, base);
    if (joined !== null) candidates.push(joined);
  }

  for (const candidate of candidates) {
    try {
      const url = new URL(candidate);
      if (url.protocol === 'http:' || url.protocol === 'https:') return url;
    } catch {
      // 试下一个候选
    }
  }
  return null;
}

/** `new URL(relative, base)`，base 本身非法时返回 null 而不是抛。 */
function joinRelative(raw: string, base: string): string | null {
  try {
    return new URL(raw, base).toString();
  } catch {
    return null;
  }
}

/**
 * 归一化成去重用的稳定字符串。
 *
 * 步骤（每一步都对应上面注释里的一个真实写法）：
 *   1. 主机名小写、去掉末尾的点（`example.com.` 与 `example.com` 同一台机器）；
 *   2. 去掉默认端口；
 *   3. 去掉 fragment（锚点不影响服务端返回的内容）；
 *   4. 去掉跟踪参数；
 *   5. 剩余查询参数**按键排序**，让顺序不同的同一组参数得到同一个结果；
 *   6. path 为空时补 `/`；**不**去掉非空 path 的尾斜杠
 *      （`/a` 与 `/a/` 在部分站点是不同的资源）。
 */
export function canonicalizeUrl(input: string | URL): string | null {
  let url: URL;
  try {
    url = input instanceof URL ? new URL(input.toString()) : new URL(input);
  } catch {
    return null;
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

  // 1. 主机名
  let host = url.hostname.toLowerCase();
  while (host.endsWith('.')) host = host.slice(0, -1);
  if (host === '') return null;

  // 2. 默认端口
  const port = url.port !== '' && url.port !== DEFAULT_PORTS[url.protocol] ? `:${url.port}` : '';

  // 3 + 4 + 5. fragment / 跟踪参数 / 排序
  //
  // ⚠ 这里**必须**用 `URLSearchParams` 重新序列化，不能手工拼 `k=v`。
  // `url.searchParams` 迭代出来的是**已解码**的值，手工拼回去会破坏数据：
  // 实测 `?q=a%26b`（值就是字面量 `a&b`）会被拼成 `?q=a&b` ——
  // 描述的是**另一个资源**（`q=a` 且多一个空参数）。
  // `URLSearchParams.toString()` 会做正确的百分号编码，
  // 顺带解决查询串里裸中文（未编码）的问题。
  const kept = new URLSearchParams();
  const pairs: [string, string][] = [];
  for (const [key, value] of url.searchParams) {
    if (TRACKING_PARAMS.includes(key)) continue;
    pairs.push([key, value]);
  }
  pairs.sort((a, b) => (a[0] === b[0] ? compare(a[1], b[1]) : compare(a[0], b[0])));
  for (const [key, value] of pairs) kept.append(key, value);

  const query = kept.size === 0 ? '' : `?${kept.toString()}`;

  // 6. path
  const path = url.pathname === '' ? '/' : url.pathname;

  return `${url.protocol}//${host}${port}${path}${query}`;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
