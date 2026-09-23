/**
 * NestJS 依赖注入的接线守卫。
 *
 * ── 为什么需要这个文件 ────────────────────────────────────────────────
 * 交付前实测发现一个**只在编译产物里出现**的缺陷：
 * `pnpm lint` 的 `consistent-type-imports` 自动修复把
 *   `import { AdminGuard }` → `import { type AuthGuard }`
 * 于是 `emitDecoratorMetadata` 生成的 `design:paramtypes` 从
 *   `[auth_guard_1.AuthGuard]` 退化成 `[Function]`，
 * `AdminGuard` 在生产构建里解析不到 `AuthGuard`。
 *
 * **而所有测试仍然是绿的** —— 测试跑的是另一套 transform（oxc），
 * 它按源码即时生成元数据，掩盖了 tsc 的产物差异。
 *
 * 修法是给每个类类型的构造参数加**显式 `@Inject(...)`**：DI 不再依赖
 * 元数据，`import type` 与否都无所谓。本文件就是防止它再退回去：
 *   1. 静态扫描：类类型的构造参数必须有 `@Inject(...)`；
 *   2. 真解析：从模块里取出实例，断言依赖不是 `undefined`。
 */

import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { AdminGuard, AuthGuard } from '../src/common/guards';
import { AccessTokenService } from '../src/modules/auth/access-token.service';
import { AuthService } from '../src/modules/auth/auth.service';
import { OtpService } from '../src/modules/auth/otp.service';
import { RateLimitService } from '../src/modules/auth/rate-limit.service';
import { SessionService } from '../src/modules/auth/session.service';
import { AUTH_REPOSITORY } from '../src/modules/auth/repository';
import { USER_REPOSITORY } from '../src/modules/users/user.repository';
import { UsersService } from '../src/modules/users/users.service';
import { createAuthTestApp, type AuthTestApp } from './support/test-app';
import { readSourceFiles } from './support/source-scan';

const API_SRC = fileURLToPath(new URL('../src', import.meta.url));

/* ------------------------------------------------------------------ */
/* 1. 静态扫描                                                         */
/* ------------------------------------------------------------------ */

/** 从 `constructor(` 开始找到配对的右括号。 */
function constructorParams(source: string): string[] {
  const blocks: string[] = [];
  let searchFrom = 0;

  for (;;) {
    const start = source.indexOf('constructor(', searchFrom);
    if (start === -1) break;

    let depth = 0;
    let index = start + 'constructor'.length;
    for (; index < source.length; index += 1) {
      const char = source[index];
      if (char === '(') depth += 1;
      else if (char === ')') {
        depth -= 1;
        if (depth === 0) break;
      }
    }

    const body = source.slice(start + 'constructor('.length, index);
    blocks.push(...splitTopLevel(body));
    searchFrom = index;
  }

  return blocks;
}

/** 按顶层逗号切分参数列表（忽略泛型 / 对象字面量里的逗号）。 */
function splitTopLevel(input: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of input) {
    if ('(<{['.includes(char)) depth += 1;
    if (')>}]'.includes(char)) depth -= 1;
    if (char === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  if (current.trim() !== '') parts.push(current);
  return parts.map((part) => part.trim()).filter((part) => part !== '');
}

/** 形如 `Something` / `Something[]` 的构造参数类型（类或接口）。 */
const CLASS_LIKE_TYPE = /^[A-Z][A-Za-z0-9_]*$/;

/** 参数的类型注解（取最后一个顶层冒号之后的部分）。 */
function parameterType(parameter: string): string | null {
  const colon = parameter.lastIndexOf(':');
  if (colon === -1) return null;
  return parameter
    .slice(colon + 1)
    .replace(/^\s*(readonly\s+)?/, '')
    .replace(/\s*=[\s\S]*$/, '')
    .trim();
}

describe('构造参数必须显式声明 @Inject（防 emitDecoratorMetadata 退化）', () => {
  const files = readSourceFiles(API_SRC);

  it('扫描到了 app 源码（防止空跑）', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it('每个「类 / 接口类型」的构造参数都带 @Inject(...)', () => {
    const offenders: string[] = [];

    for (const file of files) {
      for (const parameter of constructorParams(file.code)) {
        if (parameter.includes('@Inject(')) continue;

        const type = parameterType(parameter);
        if (type === null) continue;
        if (!CLASS_LIKE_TYPE.test(type)) continue;

        offenders.push(`${file.relativePath}: ${parameter.replace(/\s+/g, ' ')}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('读到的确实是 `@Injectable()` 的类（确认扫描有效）', () => {
    const authService = files.find((file) => file.relativePath.endsWith('auth.service.ts'));
    expect(authService?.code).toContain('@Injectable()');
    expect(constructorParams(authService?.code ?? '').length).toBeGreaterThan(5);
  });
});

/* ------------------------------------------------------------------ */
/* 2. 真解析                                                           */
/* ------------------------------------------------------------------ */

describe('DI 真解析：依赖不是 undefined', () => {
  let app: AuthTestApp;

  beforeEach(async () => {
    app = await createAuthTestApp();
  });

  /** 读私有字段（只用于接线断言）。 */
  function internals(instance: unknown): Record<string, unknown> {
    return instance as Record<string, unknown>;
  }

  it('AdminGuard 拿到了 AuthGuard 实例', () => {
    const guard = app.app.get(AdminGuard);
    expect(guard).toBeInstanceOf(AdminGuard);
    expect(internals(guard)['authGuard']).toBeInstanceOf(AuthGuard);
  });

  it('AuthGuard 拿到了 token 校验器与会话查询', () => {
    const guard = app.app.get(AuthGuard);
    expect(internals(guard)['tokens']).toBeDefined();
    expect(internals(guard)['sessions']).toBeDefined();
  });

  it('AuthService 的每个依赖都已注入', () => {
    const service = internals(app.app.get(AuthService));
    for (const field of ['accounts', 'users', 'config', 'clock', 'mail', 'github', 'logger']) {
      expect(service[field], field).toBeDefined();
    }
    expect(service['otp']).toBeInstanceOf(OtpService);
    expect(service['sessions']).toBeInstanceOf(SessionService);
    expect(service['rateLimit']).toBeInstanceOf(RateLimitService);
  });

  it('SessionService / AccessTokenService / UsersService / 仓储都已注入', () => {
    expect(internals(app.app.get(SessionService))['accessTokens']).toBeInstanceOf(
      AccessTokenService,
    );
    expect(internals(app.app.get(UsersService))['users']).toBeDefined();
    // 用 token 解析：测试里两个仓储都被内存替身 override 了，
    // 这里要确认的是「装配能解析出实例」而不是「恰好是 Prisma 实现」。
    expect(app.app.get(USER_REPOSITORY)).toBeDefined();
    expect(app.app.get(AUTH_REPOSITORY)).toBeDefined();
    expect(app.app.get(OtpService)).toBeInstanceOf(OtpService);
  });
});
