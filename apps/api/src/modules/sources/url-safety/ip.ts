/**
 * IP 地址黑名单 —— SSRF 防护的最底层判定。
 *
 * ── 这个文件为什么是独立的、且不 import 任何东西（除了 node:net）────────────
 * `docs/06` 要求「RSS / Manual URL 必须能阻止 localhost、private、link-link、
 * metadata IP，并对 redirect 重新校验」，而 Agent 04 的 Collector
 * （`apps/worker/src/jobs/collectors/**`）必须复用**同一套**判定，
 * 不能各写一份（否则两边会慢慢漂移，最终等于没有防护）。
 *
 * 因此这里刻意做成**零依赖纯函数**：只有 Node 内置模块，没有 Nest、没有 Prisma、
 * 没有 `@signal/*`。将来的搬迁（见 CONTRACT_CHANGE_REQUEST-agent-03.md）
 * 是纯粹的「移动文件」，不需要任何改写。
 *
 * ── 为什么不能只比较字符串 ────────────────────────────────────────────
 * 攻击者不会老老实实写 `http://127.0.0.1/`。已实测（`work/_agent03/probe-url-normalization.mjs`）：
 *
 *   `http://2130706433/`        → hostname `127.0.0.1`   （十进制）
 *   `http://0x7f000001/`        → hostname `127.0.0.1`   （十六进制）
 *   `http://017700000001/`      → hostname `127.0.0.1`   （八进制）
 *   `http://127.1/`             → hostname `127.0.0.1`   （短写）
 *   `http://[::ffff:127.0.0.1]/`→ hostname `[::ffff:7f00:1]` ← **点分四段变成了十六进制组**
 *
 * 前四种由 WHATWG URL 解析器归一化，解析之后再判黑名单即可覆盖；
 * 最后一种必须**自己把内嵌的 IPv4 解出来**，否则 `::ffff:127.0.0.1` 会绕过。
 *
 * ── fail-closed ──────────────────────────────────────────────────
 * 解析不出来的输入一律视为「被阻止」。宁可误拒一个正常来源（管理员能立刻看到
 * 明确的错误），也不能误放一个内网地址（那是数据泄露）。
 */

import { isIP } from 'node:net';

/** IPv4 的四个字节。用定长元组是为了让 `noUncheckedIndexedAccess` 下的取值不必断言。 */
export type Ipv4Bytes = readonly [number, number, number, number];

/** IPv6 的十六个字节。 */
export type Ipv6Bytes = readonly [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];

/* ------------------------------------------------------------------ */
/* Parsing                                                             */
/* ------------------------------------------------------------------ */

/**
 * 严格的点分四段解析。
 *
 * 刻意**拒绝前导零**（`0177.0.0.1`）：某些栈按八进制解释、某些按十进制，
 * 歧义本身就是攻击面。WHATWG 解析器已经会把这类写法归一化掉，
 * 这里再拒一次是为了兜住「直接调用本函数」的路径（例如 DNS 返回值的再校验）。
 */
export function parseIpv4Bytes(text: string): Ipv4Bytes | null {
  const parts = text.split('.');
  if (parts.length !== 4) return null;

  const octets: number[] = [];
  for (const part of parts) {
    if (!/^(?:0|[1-9]\d{0,2})$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    octets.push(value);
  }

  const [a, b, c, d] = octets;
  if (a === undefined || b === undefined || c === undefined || d === undefined) return null;
  return [a, b, c, d];
}

const HEX_GROUP = /^[0-9a-fA-F]{1,4}$/;

/** 把 16 个字节收成定长元组；长度不对就返回 null。 */
function toIpv6Bytes(bytes: number[]): Ipv6Bytes | null {
  if (bytes.length !== 16) return null;
  const at = (index: number): number => bytes[index] ?? 0;
  return [
    at(0),
    at(1),
    at(2),
    at(3),
    at(4),
    at(5),
    at(6),
    at(7),
    at(8),
    at(9),
    at(10),
    at(11),
    at(12),
    at(13),
    at(14),
    at(15),
  ];
}

/**
 * 解析 IPv6（含 `::` 缩写、末尾点分四段、`%zone` 后缀）。
 *
 * `url.hostname` 里的 IPv6 已被 WHATWG 归一化成压缩形式，
 * 但 DNS 的 `lookup()` 会返回 `::ffff:127.0.0.1` 这种**带点分四段**的形态，
 * 所以两种写法都必须支持。
 */
export function parseIpv6ToBytes(input: string): Ipv6Bytes | null {
  let text = input;
  const zoneIndex = text.indexOf('%');
  if (zoneIndex !== -1) text = text.slice(0, zoneIndex);
  if (text === '') return null;

  let head = text;
  let tail: string | null = null;
  const doubleColon = text.indexOf('::');
  if (doubleColon !== -1) {
    // `::` 至多出现一次，否则语义不明确（`1::2::3` 不是合法地址）。
    if (text.indexOf('::', doubleColon + 2) !== -1) return null;
    head = text.slice(0, doubleColon);
    tail = text.slice(doubleColon + 2);
  }

  /** 末尾的 `a.b.c.d` 换成两个十六进制组。 */
  const expandTrailingIpv4 = (groups: string[]): string[] | null => {
    const last = groups[groups.length - 1];
    if (last === undefined || !last.includes('.')) return groups;
    const octets = parseIpv4Bytes(last);
    if (octets === null) return null;
    const [a, b, c, d] = octets;
    return [
      ...groups.slice(0, -1),
      (((a << 8) | b) >>> 0).toString(16),
      (((c << 8) | d) >>> 0).toString(16),
    ];
  };

  const headGroupsRaw = head === '' ? [] : head.split(':');
  const headGroups = expandTrailingIpv4(headGroupsRaw);
  if (headGroups === null) return null;

  let tailGroups: string[] | null = null;
  if (tail !== null) {
    const converted = expandTrailingIpv4(tail === '' ? [] : tail.split(':'));
    if (converted === null) return null;
    tailGroups = converted;
  }

  const bytes: number[] = [];
  const pushGroup = (group: string): boolean => {
    if (!HEX_GROUP.test(group)) return false;
    const value = Number.parseInt(group, 16);
    bytes.push((value >> 8) & 0xff, value & 0xff);
    return true;
  };

  for (const group of headGroups) {
    if (!pushGroup(group)) return null;
  }

  if (tailGroups === null) {
    // 没有 `::`：必须是完整的 8 组。
    return toIpv6Bytes(bytes);
  }

  // `::` 至少要代表一组 0，因此已写出的组数必须 < 8。
  const written = headGroups.length + tailGroups.length;
  if (written >= 8) return null;
  for (let i = written; i < 8; i += 1) bytes.push(0, 0);
  for (const group of tailGroups) {
    if (!pushGroup(group)) return null;
  }

  return toIpv6Bytes(bytes);
}

/* ------------------------------------------------------------------ */
/* Block lists                                                         */
/* ------------------------------------------------------------------ */

/** IPv4 的 32 位整数形式。 */
function ipv4ToInt(bytes: Ipv4Bytes): number {
  const [a, b, c, d] = bytes;
  return (((a << 24) | (b << 16) | (c << 8) | d) >>> 0) as number;
}

/**
 * 被阻止的 IPv4 网段。
 *
 * 除 RFC1918 私网外，也一并挡掉「不是公网单播地址」的各类特殊段 ——
 * 它们要么不可路由、要么会被云厂商用作 metadata / 内部服务端点：
 *   0.0.0.0/8        本网络
 *   10/8 172.16/12 192.168/16   RFC1918 私网
 *   100.64/10        CGNAT（运营商级 NAT，云内常见）
 *   127/8            loopback
 *   169.254/16       link-local —— **169.254.169.254 就是云 metadata 端点**
 *   192.0.0/24       IETF 协议分配
 *   192.0.2/24 198.51.100/24 203.0.113/24   文档用（TEST-NET）
 *   192.88.99/24     6to4 中继任播
 *   198.18/15        基准测试
 *   224/4            组播
 *   240/4            保留（含 255.255.255.255 广播）
 */
const BLOCKED_IPV4_CIDRS: readonly (readonly [Ipv4Bytes, number])[] = [
  [[0, 0, 0, 0], 8],
  [[10, 0, 0, 0], 8],
  [[100, 64, 0, 0], 10],
  [[127, 0, 0, 0], 8],
  [[169, 254, 0, 0], 16],
  [[172, 16, 0, 0], 12],
  [[192, 0, 0, 0], 24],
  [[192, 0, 2, 0], 24],
  [[192, 88, 99, 0], 24],
  [[192, 168, 0, 0], 16],
  [[198, 18, 0, 0], 15],
  [[198, 51, 100, 0], 24],
  [[203, 0, 113, 0], 24],
  [[224, 0, 0, 0], 4],
  [[240, 0, 0, 0], 4],
];

/** 字节前缀匹配（`bits` 可以不是 8 的倍数）。 */
function matchesPrefix(bytes: readonly number[], prefix: readonly number[], bits: number): boolean {
  const fullBytes = Math.floor(bits / 8);
  for (let i = 0; i < fullBytes; i += 1) {
    if ((bytes[i] ?? 0) !== (prefix[i] ?? 0)) return false;
  }
  const remainder = bits % 8;
  if (remainder === 0) return true;
  const mask = (0xff << (8 - remainder)) & 0xff;
  return ((bytes[fullBytes] ?? 0) & mask) === ((prefix[fullBytes] ?? 0) & mask);
}

/** IPv4 是否落在被阻止的网段内。 */
export function isBlockedIpv4(bytes: Ipv4Bytes): boolean {
  const value = ipv4ToInt(bytes);
  for (const [base, prefix] of BLOCKED_IPV4_CIDRS) {
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    if ((value & mask) >>> 0 === (ipv4ToInt(base) & mask) >>> 0) return true;
  }
  return false;
}

/**
 * IPv6 采用**白名单**而不是黑名单，这是刻意的。
 *
 * 公网可路由的 IPv6 单播**只可能**落在 `2000::/3`（IANA 的 Global Unicast 段）。
 * 其余全部是特殊用途：`::/8`（未指定 / loopback / IPv4-mapped / IPv4-compatible）、
 * `64:ff9b::/16`（NAT64）、`100::/64`（discard-only）、`fc00::/7`（ULA）、
 * `fe80::/10`（link-local）、`ff00::/8`（组播）……
 *
 * 早期版本用的是「枚举坏前缀」的黑名单。反证时暴露了两个问题：
 *   1. `::1:7f00:1` 这类落在保留段 `0000::/8`、又不符合任何已枚举前缀的地址，
 *      黑名单**管不着**；
 *   2. 「IPv6 内嵌 IPv4」的用例其实是靠 `::ffff:0:0/96` 前缀条目通过的，
 *      解码逻辑本身从未被真正触发 —— 测试给了虚假的覆盖感。
 * 换成白名单后，保留段一律 fail-closed，不再依赖「有没有枚举全」。
 */
const IPV6_GLOBAL_UNICAST_PREFIX: readonly number[] = [0x20];

/** `2000::/3` 之内仍需单独挡掉的段（6to4 / Teredo 会内嵌 IPv4）。 */
const BLOCKED_IPV6_PREFIXES: readonly (readonly [readonly number[], number])[] = [
  [[0x20, 0x01, 0x00, 0x02], 48], // 2001:2::/48   基准测试
  [[0x20, 0x01, 0x00, 0x00], 32], // 2001::/32     Teredo（内嵌 IPv4，已废弃）
  [[0x20, 0x01, 0x0d, 0xb8], 32], // 2001:db8::/32 文档用
  [[0x20, 0x02], 16], //             2002::/16     6to4（内嵌 IPv4，已废弃）
  // RFC 9637 新增的文档前缀。挡它的理由只是**一致性**：
  // 同样语义的 `2001:db8::/32` 已在列表里，只挡一个会让规则看起来像巧合。
  [[0x3f, 0xff], 20], //             3fff::/20     文档用
];

/** IPv6 是否**不允许**作为来源地址。 */
export function isBlockedIpv6(bytes: Ipv6Bytes): boolean {
  // ① 不在公网单播段内 → 一律拒绝（保留段 fail-closed）。
  if (!matchesPrefix(bytes, IPV6_GLOBAL_UNICAST_PREFIX, 3)) return true;

  // ② 公网单播段内仍需排除的特殊用途段。
  for (const [prefix, bits] of BLOCKED_IPV6_PREFIXES) {
    if (matchesPrefix(bytes, prefix, bits)) return true;
  }
  return false;
}

/**
 * 取出 IPv6 里**内嵌的 IPv4**（如果有）。
 *
 * ⚠ 这是**纵深防御，不是当前的主判定**。写清楚以免下游高估它：
 * 上面 ① 的 `2000::/3` 白名单已经挡掉了 `::ffff:127.0.0.1`（IPv4-mapped）、
 * `::127.0.0.1`（IPv4-compatible）、`64:ff9b::127.0.0.1`（NAT64）——
 * 它们都不在公网单播段；而 `2002:7f00:1::`（6to4）与 `2001::`（Teredo）
 * 由列表里的 `2002::/16` / `2001::/32` 挡掉。
 * 也就是说：**今天删掉这个函数，端到端行为不变**。
 *
 * 那为什么留着？因为它防的是「将来有人改动上面的前缀表」——
 * 一旦 `2002::/16` 被误删，`2002:7f00:1::` 依然会因为内嵌的是 127.0.0.1
 * 而被挡住。所以它由**直接单元测试**覆盖（而不是靠端到端用例间接覆盖，
 * 那种覆盖是假的 —— 这一点正是反证时发现的）。
 */
export function embeddedIpv4Of(bytes: Ipv6Bytes): Ipv4Bytes | null {
  const at = (index: number): number => bytes[index] ?? 0;

  const lastFour: Ipv4Bytes = [at(12), at(13), at(14), at(15)];

  // ::/96（IPv4-compatible）、::ffff:0:0/96（IPv4-mapped）、64:ff9b::/96（NAT64）
  // 三者的内嵌 IPv4 都在最后 32 位。
  const mappedPrefix: readonly number[] = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff];
  const compatiblePrefix: readonly number[] = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  const nat64Prefix: readonly number[] = [0x00, 0x64, 0xff, 0x9b, 0, 0, 0, 0, 0, 0, 0, 0];
  if (
    matchesPrefix(bytes, mappedPrefix, 96) ||
    matchesPrefix(bytes, compatiblePrefix, 96) ||
    matchesPrefix(bytes, nat64Prefix, 96)
  ) {
    return lastFour;
  }

  // 2002::/16（6to4）：内嵌 IPv4 在 `2002` 之后的 32 位。
  if (matchesPrefix(bytes, [0x20, 0x02], 16)) {
    return [at(2), at(3), at(4), at(5)];
  }

  // 2001::/32（Teredo）：内嵌 IPv4 在最后 32 位，且按位取反。
  if (matchesPrefix(bytes, [0x20, 0x01, 0, 0], 32)) {
    return [at(12) ^ 0xff, at(13) ^ 0xff, at(14) ^ 0xff, at(15) ^ 0xff];
  }

  return null;
}

/**
 * 一个 IP 字面量是否**不允许**作为来源地址。
 *
 * 非 IP 字符串（`isIP()` 返回 0）一律返回 `true` —— fail-closed。
 * 调用方若需要「是不是 IP」的判断，请直接用 `node:net` 的 `isIP()`。
 */
export function isBlockedIpAddress(ip: string): boolean {
  const version = isIP(ip);

  if (version === 4) {
    const bytes = parseIpv4Bytes(ip);
    return bytes === null || isBlockedIpv4(bytes);
  }

  if (version === 6) {
    const bytes = parseIpv6ToBytes(ip);
    // 解析不出来也 fail-closed：说明我们对这个写法的理解有缺口。
    if (bytes === null) return true;
    if (isBlockedIpv6(bytes)) return true;
    const embedded = embeddedIpv4Of(bytes);
    return embedded !== null && isBlockedIpv4(embedded);
  }

  return true;
}
