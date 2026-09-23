/**
 * 真实 MySQL 上的**仓储语义**测试。
 *
 * ── 为什么单独一个文件 ────────────────────────────────────────────────
 * 独立审查发现：`pnpm test` 里的仓储断言全部打在**内存替身**上，
 * 把真实实现里的条件更新（`consumeOtp` / `revokeSession` 的
 * `updateMany({ where: { ..., consumedAt: null } })`）删掉后，
 * 三种测试依然全绿 —— 也就是说「原子消费」这个最关键的安全不变量
 * **在真库上从未被验证过**。
 *
 * 这里直接打真实 Prisma + 真实 MySQL，验证：
 *   - 条件更新真的只允许改一次（第二次不生效、也不覆盖时间戳）
 *   - 并发下恰好一次成功
 *   - 并发 request-code 不再抛 P2034（写冲突）冒泡成 500
 *   - 外部来源的超长 / 多字节字段按列宽收敛
 *   - 会话过期与撤销都会让 `findAuthenticatedSession` 返回 null
 *
 * 连不上库就直接失败，绝不静默跳过。
 */

import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { PrismaAuthRepository } from '../src/modules/auth/prisma-auth.repository';
import { PrismaUserRepository } from '../src/modules/users/prisma-user.repository';
import { USER_FIELD_LIMITS } from '../src/modules/users/user.repository';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

function loadDotEnv(): void {
  let content: string;
  try {
    content = readFileSync(`${REPO_ROOT}/.env`, 'utf8');
  } catch {
    return;
  }
  for (const line of content.split('\n')) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match === null) continue;
    const [, key, value] = match as unknown as [string, string, string];
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadDotEnv();

const RUN = randomBytes(4).toString('hex');
const EMAIL = `agent02-sem-${RUN}@signal.test`;

let prisma: PrismaService;
let auth: PrismaAuthRepository;
let users: PrismaUserRepository;

beforeAll(async () => {
  prisma = new PrismaService();
  await prisma.$queryRaw`SELECT 1`;
  auth = new PrismaAuthRepository(prisma);
  users = new PrismaUserRepository(prisma);
});

afterAll(async () => {
  await prisma.emailOtpCode.deleteMany({ where: { email: { endsWith: `-${RUN}@signal.test` } } });
  await prisma.user.deleteMany({ where: { email: { endsWith: `-${RUN}@signal.test` } } });
  await prisma.session.deleteMany({ where: { user: { email: null, displayName: `sem-${RUN}` } } });
  await prisma.user.deleteMany({ where: { displayName: `sem-${RUN}` } });
  await prisma.$disconnect();
});

function otpInput(
  email: string,
  codeHash: string,
  now: Date,
): {
  email: string;
  codeHash: string;
  expiresAt: Date;
  requestIpHash: null;
} {
  return {
    email,
    codeHash,
    expiresAt: new Date(now.getTime() + 600_000),
    requestIpHash: null,
  };
}

const codeHash = (suffix: string): string =>
  suffix
    .padEnd(64, '0')
    .slice(0, 64)
    .replace(/[^0-9a-f]/g, 'a');

describe('真实 MySQL：验证码的条件消费', () => {
  it('★ 同一个验证码只能被消费一次；第二次不生效、也不覆盖首次的时间戳', async () => {
    const now = new Date();
    await auth.replaceActiveOtp(otpInput(EMAIL, codeHash('aaaa'), now), now);

    const row = await prisma.emailOtpCode.findFirst({
      where: { email: EMAIL, consumedAt: null },
      orderBy: { id: 'desc' },
    });
    expect(row).not.toBeNull();
    const id = String(row?.id);

    const first = new Date('2026-09-23T10:00:00.000Z');
    const second = new Date('2026-09-23T11:00:00.000Z');

    expect(await auth.consumeOtp(id, first)).toBe(true);
    // 若把实现里的 `where: { ..., consumedAt: null }` 去掉，这里会变成 true
    expect(await auth.consumeOtp(id, second)).toBe(false);

    const after = await prisma.emailOtpCode.findUnique({ where: { id: BigInt(id) } });
    expect(after?.consumedAt?.toISOString()).toBe(first.toISOString());
  });

  it('并发消费同一个码：恰好一次成功', async () => {
    const now = new Date();
    const email = `agent02-sem-conc-${RUN}@signal.test`;
    await auth.replaceActiveOtp(otpInput(email, codeHash('bbbb'), now), now);

    const row = await prisma.emailOtpCode.findFirst({
      where: { email, consumedAt: null },
      orderBy: { id: 'desc' },
    });
    const id = String(row?.id);

    const results = await Promise.all(
      Array.from({ length: 8 }, () => auth.consumeOtp(id, new Date())),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('★ 并发 request-code 不再抛 P2034 冒泡成 500，且只留一个可用码', async () => {
    const now = new Date();
    const email = `agent02-sem-race-${RUN}@signal.test`;

    // 修复前实测：8 并发里 7 个抛 P2034（写冲突），最终用户看到「服务器错误」
    const settled = await Promise.allSettled(
      Array.from({ length: 6 }, (_unused, index) =>
        auth.replaceActiveOtp(otpInput(email, codeHash(`c${index}${index}${index}`), now), now),
      ),
    );

    const rejected = settled.filter((r) => r.status === 'rejected');
    expect(rejected.map((r) => String((r as PromiseRejectedResult).reason))).toEqual([]);

    const unconsumed = await prisma.emailOtpCode.count({
      where: { email, consumedAt: null },
    });
    expect(unconsumed).toBe(1);
  });
});

describe('真实 MySQL：会话撤销的条件更新', () => {
  it('★ revokeSession 第二次返回 false（幂等但不重复计数）', async () => {
    const user = await users.createWithPreference({
      email: `agent02-sem-rev-${RUN}@signal.test`,
      displayName: null,
      avatarUrl: null,
    });
    const session = await auth.createSession({
      userId: user.id,
      refreshTokenHash: codeHash('dddd'),
      expiresAt: new Date(Date.now() + 86_400_000),
      userAgentHash: null,
      ipHash: null,
    });

    const first = new Date('2026-09-23T10:00:00.000Z');
    const second = new Date('2026-09-23T11:00:00.000Z');

    expect(await auth.revokeSession(session.id, first)).toBe(true);
    // 去掉实现里的 `revokedAt: null` 条件后这里会变成 true，撤销时间也会被覆盖
    expect(await auth.revokeSession(session.id, second)).toBe(false);

    const row = await prisma.session.findUnique({ where: { id: BigInt(session.id) } });
    expect(row?.revokedAt?.toISOString()).toBe(first.toISOString());

    // 撤销后认证主体必须查不到
    expect(await auth.findAuthenticatedSession(session.id)).toBeNull();
  });

  it('revokeAllSessionsForUser 只统计真正被改动的行', async () => {
    const user = await users.createWithPreference({
      email: `agent02-sem-all-${RUN}@signal.test`,
      displayName: null,
      avatarUrl: null,
    });
    for (const suffix of ['e1', 'e2']) {
      await auth.createSession({
        userId: user.id,
        refreshTokenHash: codeHash(suffix),
        expiresAt: new Date(Date.now() + 86_400_000),
        userAgentHash: null,
        ipHash: null,
      });
    }

    expect(await auth.revokeAllSessionsForUser(user.id, new Date())).toBe(2);
    // 第二次没有可撤销的行 → 0（而不是 again 2）
    expect(await auth.revokeAllSessionsForUser(user.id, new Date())).toBe(0);
  });

  it('会话过期后 findAuthenticatedSession 返回 null（过期也必须失效）', async () => {
    const user = await users.createWithPreference({
      email: `agent02-sem-exp-${RUN}@signal.test`,
      displayName: null,
      avatarUrl: null,
    });
    const session = await auth.createSession({
      userId: user.id,
      refreshTokenHash: codeHash('ffff'),
      // 已过期但未撤销
      expiresAt: new Date(Date.now() - 1000),
      userAgentHash: null,
      ipHash: null,
    });

    expect(await auth.findAuthenticatedSession(session.id)).toBeNull();
  });
});

describe('真实 MySQL：外部字段按列宽收敛', () => {
  it('★ 300 字符的 GitHub 昵称不会让建号失败（会被截断到列宽）', async () => {
    const longName = 'n'.repeat(USER_FIELD_LIMITS.displayName + 180);
    const user = await users.createWithPreference({
      email: `agent02-sem-long-${RUN}@signal.test`,
      displayName: longName,
      avatarUrl: `https://example.com/${'a'.repeat(1200)}.png`,
    });

    expect(user.displayName).toHaveLength(USER_FIELD_LIMITS.displayName);
    expect(user.avatarUrl).toHaveLength(USER_FIELD_LIMITS.avatarUrl);
  });

  it('中文 / 多字节昵称在 utf8mb4 上原样往返', async () => {
    const chinese = '张伟·工程师 🚀 模型评测';
    const user = await users.createWithPreference({
      email: `agent02-sem-cjk-${RUN}@signal.test`,
      displayName: chinese,
      avatarUrl: null,
    });

    const reloaded = await users.findById(user.id);
    expect(reloaded?.displayName).toBe(chinese);
  });

  it('建号时同时写入默认偏好（1:1 关系不留空）', async () => {
    const user = await users.createWithPreference({
      email: `agent02-sem-pref-${RUN}@signal.test`,
      displayName: null,
      avatarUrl: null,
    });

    const preference = await prisma.userPreference.findUnique({
      where: { userId: BigInt(user.id) },
    });
    expect(preference?.theme).toBe('SYSTEM');
  });

  it('按邮箱创建的第二次调用不会覆盖已有用户（含昵称与头像）', async () => {
    const email = `agent02-sem-keep-${RUN}@signal.test`;
    const created = await users.findOrCreateByEmail(email, {
      displayName: '初始昵称',
      avatarUrl: 'https://example.com/a.png',
    });
    const again = await users.findOrCreateByEmail(email, {
      displayName: '不应该生效',
      avatarUrl: 'https://example.com/b.png',
    });

    expect(again.id).toBe(created.id);
    expect(again.displayName).toBe('初始昵称');
    expect(again.avatarUrl).toBe('https://example.com/a.png');
  });
});
