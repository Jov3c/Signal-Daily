/**
 * SSRF 防护的测试（`modules/sources/url-safety`）。
 *
 * 这批用例的取材原则：**不写「我以为的攻击手法」，写实测过的绕过写法。**
 * 下面的伪装形式全部先由 `work/_agent03/probe-url-normalization.mjs`
 * 在真实 WHATWG 解析器上跑过一遍，确认了它们的归一化结果，再据此断言。
 *
 * 其中最关键的三条（也是最容易被漏掉的）：
 *   1. `::ffff:127.0.0.1` 归一化后变成 `[::ffff:7f00:1]` ——
 *      点分四段没了，必须自己解出内嵌 IPv4；
 *   2. `localhost.` 的**尾点会被保留** —— 不做去除就会漏；
 *   3. DNS 解析可能返回**多个**地址（`localhost` 同时给 `::1` 和 `127.0.0.1`）——
 *      只校验第一条就是漏洞。
 */

import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_MAX_REDIRECTS,
  SourceFetchError,
  UrlSafetyError,
  assertHostResolvesToPublicAddress,
  assertSafeSourceUrl,
  charsetOf,
  decodeChunks,
  embeddedIpv4Of,
  isBlockedHostname,
  isBlockedIpAddress,
  isBlockedIpv6,
  normalizeHostname,
  parseIpv6ToBytes,
  redactUrlForDisplay,
  safeFetchText,
  type DnsAddress,
} from '../src/modules/sources/url-safety';

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/** 断言某个 URL 被拒绝，且原因是预期的那个。 */
function expectRejected(raw: string, reason: string): void {
  try {
    assertSafeSourceUrl(raw);
    throw new Error(`本应拒绝但被放行：${raw}`);
  } catch (error) {
    expect(error, `拒绝 ${raw} 时抛出的不是 UrlSafetyError`).toBeInstanceOf(UrlSafetyError);
    expect((error as UrlSafetyError).reason, `拒绝 ${raw} 的原因不符`).toBe(reason);
  }
}

/** 解析固定地址的 DNS 替身。 */
function stubLookup(addresses: DnsAddress[] | Error) {
  return async (): Promise<DnsAddress[]> => {
    if (addresses instanceof Error) throw addresses;
    return addresses;
  };
}

/** 构造一个分片流式响应，并记录**实际被读取的分片数**。 */
function streamingResponse(options: {
  status?: number;
  headers?: Record<string, string>;
  chunkSize: number;
  chunkCount: number;
  pulled: { count: number };
}): Response {
  const { chunkSize, chunkCount, pulled } = options;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled.count >= chunkCount) {
        controller.close();
        return;
      }
      pulled.count += 1;
      controller.enqueue(new Uint8Array(chunkSize).fill(0x61));
    },
  });
  return new Response(stream, {
    status: options.status ?? 200,
    headers: options.headers ?? { 'content-type': 'text/plain' },
  });
}

const ALLOW_ALL_DNS = stubLookup([{ address: '93.184.216.34', family: 4 }]);

/* ------------------------------------------------------------------ */
/* 1. 语法层：伪装写法                                                 */
/* ------------------------------------------------------------------ */

describe('URL 校验 —— 伪装成公网的 loopback 写法（全部实测过归一化结果）', () => {
  it.each([
    ['十进制', 'http://2130706433/'],
    ['十六进制', 'http://0x7f000001/'],
    ['十六进制分段', 'http://0x7f.0.0.1/'],
    ['八进制', 'http://017700000001/'],
    ['短写', 'http://127.1/'],
    ['标准', 'http://127.0.0.1/'],
    ['带端口', 'http://127.0.0.1:8080/'],
  ])('%s 形式的 loopback 一律拒绝', (_label, raw) => {
    expectRejected(raw, 'BLOCKED_IP');
  });

  it.each([
    ['IPv4-mapped', 'http://[::ffff:127.0.0.1]/'],
    ['IPv4-mapped（十六进制组）', 'http://[::ffff:7f00:1]/'],
    ['IPv4-mapped（完整写法）', 'http://[0:0:0:0:0:ffff:127.0.0.1]/'],
    ['IPv4-compatible', 'http://[::127.0.0.1]/'],
    ['NAT64', 'http://[64:ff9b::127.0.0.1]/'],
    ['6to4 内嵌 127.0.0.1', 'http://[2002:7f00:0001::]/'],
    ['Teredo', 'http://[2001::]/'],
    ['loopback', 'http://[::1]/'],
    ['链路本地', 'http://[fe80::1]/'],
    ['ULA', 'http://[fd00::1]/'],
    ['未指定', 'http://[::]/'],
    // ★ 反证时发现的缺口：这个地址落在保留段 `0000::/8`，
    //   但既不符合任何已枚举的坏前缀，也不在任何内嵌 IPv4 形态里。
    //   旧的「枚举坏前缀」黑名单放行了它；白名单式判定才挡得住。
    ['保留段 0000::/8 里的地址', 'http://[::1:7f00:1]/'],
    // `2000::/3` 之外的一切都不是公网单播。
    ['0000::/8 里的普通地址', 'http://[::abcd]/'],
    ['4000::/3 之外的地址', 'http://[4000::1]/'],
    ['组播', 'http://[ff02::1]/'],
  ])('%s 形式的 IPv6 内网地址一律拒绝', (_label, raw) => {
    expectRejected(raw, 'BLOCKED_IP');
  });

  it.each([
    ['RFC1918 /8', 'http://10.0.0.1/'],
    ['RFC1918 /12', 'http://172.16.0.1/'],
    ['RFC1918 /16', 'http://192.168.1.1/'],
    ['CGNAT', 'http://100.64.0.1/'],
    ['云 metadata（link-local）', 'http://169.254.169.254/latest/meta-data/'],
    ['组播', 'http://224.0.0.1/'],
    ['保留段', 'http://240.0.0.1/'],
    ['本网络', 'http://0.0.0.0/'],
  ])('%s 一律拒绝', (_label, raw) => {
    expectRejected(raw, 'BLOCKED_IP');
  });
});

describe('URL 校验 —— 域名伪装', () => {
  it.each([
    ['小写', 'http://localhost/'],
    ['大写', 'http://LOCALHOST/'],
    ['带尾点', 'http://localhost./'],
    ['子域', 'http://foo.localhost/'],
    ['带圈字符', 'http://ⓛocalhost/'],
    ['百分号编码', 'http://local%68ost/'],
    ['mDNS .local', 'http://foo.local/'],
    ['云内网 .internal', 'http://metadata.google.internal/'],
    ['单标签主机名', 'http://intranet/'],
  ])('%s 一律拒绝', (_label, raw) => {
    expectRejected(raw, 'BLOCKED_HOST');
  });

  it('尾点不会让 `localhost.` 绕过（这条不做去尾点就一定漏）', () => {
    expect(normalizeHostname('localhost.')).toBe('localhost');
    expect(isBlockedHostname(normalizeHostname('localhost.'))).toBe(true);
  });

  it('IPv6 的方括号会被去掉', () => {
    expect(normalizeHostname('[::1]')).toBe('::1');
  });
});

describe('URL 校验 —— scheme / 凭据 / 端口', () => {
  it.each([
    ['file', 'file:///etc/passwd'],
    ['gopher', 'gopher://example.com/'],
    ['data', 'data:text/html,<script>'],
    ['ftp', 'ftp://example.com/'],
  ])('%s: 一律拒绝', (_label, raw) => {
    expectRejected(raw, 'UNSUPPORTED_SCHEME');
  });

  it.each([
    ['用户名+密码', 'http://user:pass@example.com/'],
    ['仅用户名', 'http://user@example.com/'],
  ])('URL 内嵌凭据（%s）一律拒绝', (_label, raw) => {
    expectRejected(raw, 'CREDENTIALS_IN_URL');
  });

  it('端口 0 一律拒绝', () => {
    expectRejected('http://example.com:0/', 'BLOCKED_PORT');
  });

  it('空串与畸形 URL 一律拒绝', () => {
    expectRejected('', 'INVALID_URL');
    expectRejected('   ', 'INVALID_URL');
    expectRejected('not a url', 'INVALID_URL');
    expectRejected('/relative/path', 'INVALID_URL');
  });
});

describe('URL 校验 —— 正常的公网来源必须放行（对照组）', () => {
  it.each([
    'https://www.anthropic.com/news/rss.xml',
    'http://openai.com/news/rss.xml',
    'https://example.com:8443/path?q=1#frag',
    'https://blog.example.co.uk/feed',
    // 公网 IPv6 应当放行 —— 只挡内网前缀，不是「见到 IPv6 就拒」
    'https://[2606:4700:4700::1111]/dns-query',
    // 公网字面量 IPv4
    'http://93.184.216.34/',
  ])('放行 %s', (url) => {
    expect(assertSafeSourceUrl(url).toString()).not.toBe('');
  });

  it('返回的是**归一化后**的 URL（调用方应当拿它去连接）', () => {
    expect(assertSafeSourceUrl('HTTP://EXAMPLE.COM/Feed').toString()).toBe('http://example.com/Feed');
  });
});

describe('redactUrlForDisplay —— 查询串与凭据不得外泄', () => {
  it('去掉查询串与 hash', () => {
    expect(redactUrlForDisplay('https://example.com/feed?token=SECRET#frag')).toBe(
      'https://example.com/feed',
    );
  });

  it('去掉凭据', () => {
    expect(redactUrlForDisplay('http://user:pass@example.com/x')).toBe('http://example.com/x');
  });

  it('保留端口', () => {
    expect(redactUrlForDisplay('https://example.com:8443/a/b?q=1')).toBe(
      'https://example.com:8443/a/b',
    );
  });

  it('路径为空时补根斜杠', () => {
    expect(redactUrlForDisplay('https://example.com?q=1')).toBe('https://example.com/');
  });

  it('畸形输入不回显原文', () => {
    expect(redactUrlForDisplay('%%%not-a-url%%%')).toBe('(invalid url)');
  });
});

describe('IP 黑名单', () => {
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.31.255.255',
    '192.168.0.1',
    '169.254.169.254',
    '100.100.100.100',
    '::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    'fe80::1',
    'fd00::1',
    '2002:7f00:1::',
    '64:ff9b::7f00:1',
  ])('%s 被阻止', (ip) => {
    expect(isBlockedIpAddress(ip)).toBe(true);
  });

  it.each(['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:4700:4700::1111', '2001:4860:4860::8888'])(
    '%s 放行',
    (ip) => {
      expect(isBlockedIpAddress(ip)).toBe(false);
    },
  );

  it('不是 IP 的输入 fail-closed（返回 true，而不是放行）', () => {
    expect(isBlockedIpAddress('not-an-ip')).toBe(true);
    expect(isBlockedIpAddress('')).toBe(true);
  });
});

/**
 * 直接测内嵌 IPv4 的解码。
 *
 * ★ 为什么要单独测：反证时发现，原先那批「IPv6 伪装」的端到端用例
 * 其实是靠 `::ffff:0:0/96` **前缀条目**通过的，解码逻辑一次都没被执行到 ——
 * 也就是说那些用例给了它虚假的覆盖。改成直接断言函数输出，
 * 它才真的被测住（它是防「将来有人误删前缀表」的最后一道防线）。
 */
describe('IPv6 解析与内嵌 IPv4 解码（直接单测，不经由前缀表）', () => {
  it('parseIpv6ToBytes 展开 `::` 缩写', () => {
    expect(parseIpv6ToBytes('::1')).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
    expect(parseIpv6ToBytes('2001:db8::1')).toEqual([
      0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1,
    ]);
  });

  it('parseIpv6ToBytes 支持末尾点分四段（DNS 会返回这种形态）', () => {
    expect(parseIpv6ToBytes('::ffff:127.0.0.1')).toEqual([
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, 0x7f, 0, 0, 1,
    ]);
  });

  it('parseIpv6ToBytes 拒绝畸形输入', () => {
    expect(parseIpv6ToBytes('1::2::3')).toBeNull(); // 两个 `::`
    expect(parseIpv6ToBytes('gggg::1')).toBeNull(); // 非十六进制
    expect(parseIpv6ToBytes('1:2:3')).toBeNull(); // 组数不足且无 `::`
    expect(parseIpv6ToBytes('')).toBeNull();
  });

  it.each([
    ['IPv4-mapped', '::ffff:127.0.0.1', [127, 0, 0, 1]],
    ['IPv4-compatible', '::127.0.0.1', [127, 0, 0, 1]],
    ['NAT64', '64:ff9b::10.0.0.1', [10, 0, 0, 1]],
    ['6to4（内嵌在 2002 之后）', '2002:a00:1::1', [10, 0, 0, 1]],
    ['6to4 内嵌 loopback', '2002:7f00:1::', [127, 0, 0, 1]],
  ])('embeddedIpv4Of 解出 %s 的内嵌地址', (_label, ip, expected) => {
    const bytes = parseIpv6ToBytes(ip);
    expect(bytes).not.toBeNull();
    expect(embeddedIpv4Of(bytes ?? [])).toEqual(expected);
  });

  it('Teredo 的内嵌 IPv4 按位取反（RFC 4380）', () => {
    // 2001:0000:4136:e378:8000:63bf:3fff:fdd2 里最后 32 位是取反后的客户端 IPv4。
    const bytes = parseIpv6ToBytes('2001:0000:4136:e378:8000:63bf:3fff:fdd2');
    expect(bytes).not.toBeNull();
    expect(embeddedIpv4Of(bytes ?? [])).toEqual([
      0x3f ^ 0xff,
      0xff ^ 0xff,
      0xfd ^ 0xff,
      0xd2 ^ 0xff,
    ]);
  });

  it('不含内嵌 IPv4 的普通公网地址返回 null', () => {
    const bytes = parseIpv6ToBytes('2606:4700:4700::1111');
    expect(bytes).not.toBeNull();
    expect(embeddedIpv4Of(bytes ?? [])).toBeNull();
  });
});

/**
 * 直接断言 `isBlockedIpv6` 的**白名单语义**。
 *
 * ★ 为什么必须单独测这一层：反证时把 `::1` 从 `2000::/3` 白名单里刻意放行，
 * 所有端到端用例**依然全绿** —— 因为 `embeddedIpv4Of()` 又把 `::1` 解成内嵌的
 * `0.0.0.1`（落在被阻止的 `0.0.0.0/8`）挡住了。
 *
 * 这是纵深防御在正常工作，**不是**缺陷；但它意味着白名单这条规则
 * 自己没有独立的牙齿。少了下面这些断言，将来有人把白名单误删，
 * 只有「恰好还能被内嵌判定兜住」的地址会报错，其余的会静默放行。
 */
describe('isBlockedIpv6 的白名单语义（不经由内嵌 IPv4 判定）', () => {
  const blocked = (ip: string): boolean => {
    const bytes = parseIpv6ToBytes(ip);
    if (bytes === null) throw new Error(`解析失败：${ip}`);
    return isBlockedIpv6(bytes);
  };

  it.each([
    ['loopback `::1` —— 不在 2000::/3 内', '::1'],
    ['未指定 `::`', '::'],
    ['保留段 `0000::/8`', '::abcd'],
    ['IPv4-mapped', '::ffff:127.0.0.1'],
    ['NAT64', '64:ff9b::1'],
    ['discard-only', '100::1'],
    ['ULA', 'fd00::1'],
    ['link-local', 'fe80::1'],
    ['组播', 'ff02::1'],
    ['2000::/3 之外的 `4000::1`', '4000::1'],
    ['白名单内的 Teredo', '2001::1'],
    ['白名单内的 6to4', '2002:7f00:1::'],
    ['白名单内的文档段', '2001:db8::1'],
    ['白名单内的基准测试段', '2001:2::1'],
  ])('%s 被阻止', (_label, ip) => {
    expect(blocked(ip)).toBe(true);
  });

  it.each([
    ['Cloudflare DNS', '2606:4700:4700::1111'],
    ['Google DNS', '2001:4860:4860::8888'],
    ['3fff 边界（仍在 /3 内）', '3fff::1'],
  ])('%s 放行', (_label, ip) => {
    expect(blocked(ip)).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* 2. DNS 层：公网域名指向内网                                         */
/* ------------------------------------------------------------------ */

describe('DNS 校验 —— 公网域名解析到内网地址必须被挡', () => {
  it('解析到 127.0.0.1 → 拒绝（这是最典型的 SSRF）', async () => {
    const url = assertSafeSourceUrl('http://evil.example/');
    await expect(
      assertHostResolvesToPublicAddress(url, stubLookup([{ address: '127.0.0.1', family: 4 }])),
    ).rejects.toBeInstanceOf(UrlSafetyError);
  });

  it('解析出多个地址时，**只要有一个**是内网就拒绝', async () => {
    const url = assertSafeSourceUrl('http://evil.example/');
    // 第一条是公网、第二条是内网 —— 只看第一条就会漏。这里刻意把公网放前面。
    await expect(
      assertHostResolvesToPublicAddress(
        url,
        stubLookup([
          { address: '93.184.216.34', family: 4 },
          { address: '169.254.169.254', family: 4 },
        ]),
      ),
    ).rejects.toBeInstanceOf(UrlSafetyError);
  });

  it('全部是公网地址时放行', async () => {
    const url = assertSafeSourceUrl('http://good.example/');
    await expect(
      assertHostResolvesToPublicAddress(
        url,
        stubLookup([
          { address: '93.184.216.34', family: 4 },
          { address: '2606:4700:4700::1111', family: 6 },
        ]),
      ),
    ).resolves.toBeUndefined();
  });

  it('DNS 查不到 → SourceFetchError(DNS_RESOLUTION_FAILED)，不是 URL 非法', async () => {
    const url = assertSafeSourceUrl('http://nx.example/');
    await expect(
      assertHostResolvesToPublicAddress(url, stubLookup(new Error('ENOTFOUND'))),
    ).rejects.toMatchObject({ name: 'SourceFetchError', reason: 'DNS_RESOLUTION_FAILED' });
  });

  it('解析结果为空 → 拒绝（fail-closed）', async () => {
    const url = assertSafeSourceUrl('http://empty.example/');
    await expect(assertHostResolvesToPublicAddress(url, stubLookup([]))).rejects.toMatchObject({
      reason: 'DNS_RESOLUTION_FAILED',
    });
  });

  it('字面量 IP 不走 DNS（已在语法层校验过）', async () => {
    const lookup = vi.fn(stubLookup([{ address: '127.0.0.1', family: 4 }]));
    const url = assertSafeSourceUrl('http://93.184.216.34/');
    await assertHostResolvesToPublicAddress(url, lookup);
    expect(lookup).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ */
/* 3. safeFetchText：重定向重新校验、超时、大小上限                     */
/* ------------------------------------------------------------------ */

describe('safeFetchText —— 正常路径', () => {
  it('200 + 正文 + content-type', async () => {
    const result = await safeFetchText(
      'https://feed.example/rss',
      { timeoutMs: 1000, maxBytes: 1000 },
      {
        lookup: ALLOW_ALL_DNS,
        fetchImpl: async () =>
          new Response('<rss>hi</rss>', {
            status: 200,
            headers: { 'content-type': 'application/rss+xml' },
          }),
      },
    );

    expect(result.status).toBe(200);
    expect(result.body).toBe('<rss>hi</rss>');
    expect(result.contentType).toBe('application/rss+xml');
    expect(result.truncated).toBe(false);
    expect(result.redirects).toEqual([]);
  });

  it('最终 URL 同时给出「真值」与「可安全展示」两种形式', async () => {
    const result = await safeFetchText(
      'https://feed.example/rss?api_key=SECRET',
      { timeoutMs: 1000, maxBytes: 100 },
      { lookup: ALLOW_ALL_DNS, fetchImpl: async () => new Response('ok') },
    );

    // 采集器需要真值来解析相对链接……
    expect(result.finalUrl).toContain('api_key=SECRET');
    // ……但日志 / 响应只能用这个。
    expect(result.displayUrl).toBe('https://feed.example/rss');
  });

  it('按 content-type 的 charset 解码（中文 RSS 常见 GBK）', async () => {
    const gbkBytes = new Uint8Array([0xd6, 0xd0, 0xce, 0xc4]); // “中文”
    const result = await safeFetchText(
      'https://feed.example/rss',
      { timeoutMs: 1000, maxBytes: 1000 },
      {
        lookup: ALLOW_ALL_DNS,
        fetchImpl: async () =>
          new Response(gbkBytes, {
            status: 200,
            headers: { 'content-type': 'text/xml; charset=gbk' },
          }),
      },
    );

    expect(result.body).toBe('中文');
  });

  it('HEAD 请求没有正文', async () => {
    const result = await safeFetchText(
      'https://example.com/',
      { method: 'HEAD', timeoutMs: 1000, maxBytes: 1000 },
      { lookup: ALLOW_ALL_DNS, fetchImpl: async () => new Response(null, { status: 204 }) },
    );
    expect(result.status).toBe(204);
    expect(result.body).toBe('');
    expect(result.bytes).toBe(0);
  });
});

describe('safeFetchText —— 重定向必须逐跳重新校验（docs/06）', () => {
  it('公网 → 云 metadata 的重定向被挡下', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.startsWith('https://feed.example/')) {
        return new Response(null, {
          status: 302,
          headers: { location: 'http://169.254.169.254/latest/meta-data/' },
        });
      }
      throw new Error(`不该请求到这里：${url}`);
    });

    await expect(
      safeFetchText(
        'https://feed.example/rss',
        { timeoutMs: 1000, maxBytes: 1000 },
        { lookup: ALLOW_ALL_DNS, fetchImpl: fetchImpl as unknown as typeof fetch },
      ),
    ).rejects.toBeInstanceOf(UrlSafetyError);

    // 而且**第二跳根本没发出去** —— 被挡在请求之前。
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('公网 → localhost 域名的重定向被挡下', async () => {
    await expect(
      safeFetchText(
        'https://feed.example/rss',
        { timeoutMs: 1000, maxBytes: 1000 },
        {
          lookup: ALLOW_ALL_DNS,
          fetchImpl: (async () =>
            new Response(null, {
              status: 301,
              headers: { location: 'http://localhost:8080/admin' },
            })) as unknown as typeof fetch,
        },
      ),
    ).rejects.toBeInstanceOf(UrlSafetyError);
  });

  it('重定向到**解析结果为内网**的域名也被挡下（DNS 层同样逐跳生效）', async () => {
    const lookup = async (hostname: string): Promise<DnsAddress[]> => {
      if (hostname === 'internal.example') return [{ address: '10.0.0.5', family: 4 }];
      return [{ address: '93.184.216.34', family: 4 }];
    };

    await expect(
      safeFetchText(
        'https://feed.example/rss',
        { timeoutMs: 1000, maxBytes: 1000 },
        {
          lookup,
          fetchImpl: (async () =>
            new Response(null, {
              status: 302,
              headers: { location: 'https://internal.example/secret' },
            })) as unknown as typeof fetch,
        },
      ),
    ).rejects.toBeInstanceOf(UrlSafetyError);
  });

  it('合法的多跳重定向能走完，并记录每一跳（展示形式）', async () => {
    let hop = 0;
    const fetchImpl = async (): Promise<Response> => {
      hop += 1;
      if (hop === 1) {
        return new Response(null, { status: 301, headers: { location: 'https://a.example/1?x=1' } });
      }
      if (hop === 2) {
        return new Response(null, { status: 302, headers: { location: 'https://b.example/2' } });
      }
      return new Response('done', { status: 200 });
    };

    const result = await safeFetchText(
      'https://feed.example/rss',
      { timeoutMs: 5000, maxBytes: 100 },
      { lookup: ALLOW_ALL_DNS, fetchImpl: fetchImpl as unknown as typeof fetch },
    );

    expect(result.status).toBe(200);
    expect(result.body).toBe('done');
    expect(result.redirects).toEqual(['https://a.example/1', 'https://b.example/2']);
    expect(result.displayUrl).toBe('https://b.example/2');
  });

  it('超过重定向上限 → SourceFetchError(TOO_MANY_REDIRECTS)', async () => {
    let hop = 0;
    await expect(
      safeFetchText(
        'https://feed.example/rss',
        { timeoutMs: 5000, maxBytes: 100 },
        {
          lookup: ALLOW_ALL_DNS,
          fetchImpl: (async () => {
            hop += 1;
            return new Response(null, {
              status: 302,
              headers: { location: `https://hop${hop}.example/` },
            });
          }) as unknown as typeof fetch,
        },
      ),
    ).rejects.toMatchObject({ reason: 'TOO_MANY_REDIRECTS' });

    // 初次请求 + maxRedirects 次跟随，一个不多。
    expect(hop).toBe(DEFAULT_MAX_REDIRECTS + 1);
  });

  it('重定向没有 Location → SourceFetchError(REDIRECT_WITHOUT_LOCATION)', async () => {
    await expect(
      safeFetchText(
        'https://feed.example/rss',
        { timeoutMs: 1000, maxBytes: 100 },
        {
          lookup: ALLOW_ALL_DNS,
          fetchImpl: (async () => new Response(null, { status: 302 })) as unknown as typeof fetch,
        },
      ),
    ).rejects.toMatchObject({ reason: 'REDIRECT_WITHOUT_LOCATION' });
  });
});

describe('safeFetchText —— 超时与体积上限', () => {
  it('请求抛 TimeoutError → SourceFetchError(TIMEOUT)', async () => {
    await expect(
      safeFetchText(
        'https://slow.example/',
        { timeoutMs: 1000, maxBytes: 100 },
        {
          lookup: ALLOW_ALL_DNS,
          fetchImpl: (async () => {
            const error = new Error('aborted');
            error.name = 'TimeoutError';
            throw error;
          }) as unknown as typeof fetch,
        },
      ),
    ).rejects.toMatchObject({ reason: 'TIMEOUT' });
  });

  it('网络异常 → SourceFetchError(NETWORK)', async () => {
    await expect(
      safeFetchText(
        'https://down.example/',
        { timeoutMs: 1000, maxBytes: 100 },
        {
          lookup: ALLOW_ALL_DNS,
          fetchImpl: (async () => {
            throw new Error('ECONNREFUSED');
          }) as unknown as typeof fetch,
        },
      ),
    ).rejects.toMatchObject({ reason: 'NETWORK' });
  });

  it('总超时预算是**整条重定向链共享**的 —— 预算耗尽后不再发新请求', async () => {
    let clock = 0;
    const fetchImpl = vi.fn(async () => {
      clock += 600; // 每一跳花 600ms
      return new Response(null, { status: 302, headers: { location: 'https://next.example/' } });
    });

    await expect(
      safeFetchText(
        'https://feed.example/rss',
        { timeoutMs: 1000, maxBytes: 100 },
        { lookup: ALLOW_ALL_DNS, fetchImpl: fetchImpl as unknown as typeof fetch, now: () => clock },
      ),
    ).rejects.toMatchObject({ reason: 'TIMEOUT' });

    // 预算 1000ms / 每跳 600ms → 只允许发出 2 次（第 3 次前预算已耗尽）。
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('超过体积上限时**边读边停**，而不是读完再截断', async () => {
    const pulled = { count: 0 };
    const result = await safeFetchText(
      'https://big.example/',
      { timeoutMs: 5000, maxBytes: 2500 },
      {
        lookup: ALLOW_ALL_DNS,
        fetchImpl: (async () =>
          streamingResponse({
            chunkSize: 1000,
            chunkCount: 100,
            pulled,
          })) as unknown as typeof fetch,
      },
    );

    expect(result.bytes).toBe(2500);
    expect(result.truncated).toBe(true);
    expect(result.body).toHaveLength(2500);
    // ★ 这条断言才是「有牙齿」的地方：如果实现是 `await response.text()` 再 slice，
    //   这里是 100（整个 100KB 都进了内存）。
    expect(pulled.count).toBeLessThanOrEqual(4);
  });

  it('长度恰好等于上限时**不算**截断', async () => {
    const pulled = { count: 0 };
    const result = await safeFetchText(
      'https://exact.example/',
      { timeoutMs: 5000, maxBytes: 2000 },
      {
        lookup: ALLOW_ALL_DNS,
        fetchImpl: (async () =>
          streamingResponse({
            chunkSize: 1000,
            chunkCount: 2,
            pulled,
          })) as unknown as typeof fetch,
      },
    );

    expect(result.bytes).toBe(2000);
    expect(result.truncated).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* 4. 小工具                                                           */
/* ------------------------------------------------------------------ */

describe('charsetOf', () => {
  it.each([
    ['text/xml; charset=gbk', 'gbk'],
    ['text/html; charset="UTF-8"', 'UTF-8'],
    ['text/plain', 'utf-8'],
    [null, 'utf-8'],
  ])('%s → %s', (input, expected) => {
    expect(charsetOf(input)).toBe(expected);
  });
});

describe('decodeChunks', () => {
  it('未知 charset 回退 utf-8，不抛错', () => {
    expect(decodeChunks([new Uint8Array([0x68, 0x69])], 'text/plain; charset=x-unknown')).toBe('hi');
  });
});

describe('SourceFetchError', () => {
  it('保留 status 与 reason', () => {
    const error = new SourceFetchError('HTTP_STATUS', 'boom', { status: 503 });
    expect(error.reason).toBe('HTTP_STATUS');
    expect(error.status).toBe(503);
    expect(error).toBeInstanceOf(Error);
    // 刻意不是 AppError：它没有「该回什么状态码」的答案。
    expect(error.name).toBe('SourceFetchError');
  });
});
