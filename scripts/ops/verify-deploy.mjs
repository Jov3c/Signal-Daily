#!/usr/bin/env node
/**
 * 部署形态的结构校验 —— `docs/16` 的硬约束。
 *
 * ```bash
 * node scripts/ops/verify-deploy.mjs      # 或者 pnpm ops:verify
 * ```
 *
 * ── 为什么是一个脚本而不是 vitest 用例 ──────────────────────────────
 * 它校验的是**仓库根目录的部署产物**（compose / nginx / Dockerfile），
 * 而 `vitest.config.mts` 的 include 只有 `packages/*\/src`、`apps/*\/test`、
 * `prisma/__tests__` —— `infra/` 与 `scripts/` 都不在里面。
 * （本任务**允许修改**的目录不含根 `vitest.config.mts`，见 Agent 11 的 CCR。）
 *
 * 所以它做成一个**可独立运行**的脚本，并接进 `pnpm ops:verify`。
 * 需要 Docker 的那部分（`docker compose config`）在缺失时**跳过并打印**，
 * 而不是假装通过 —— 「跳过」与「通过」必须能分辨。
 *
 * ── 它检查什么（每一条都对应 `docs/16` 或 `docs/15` 的一句原文）──────
 *
 * 1. MySQL / Redis **没有宿主端口**（docs/16：不暴露公网）
 * 2. nginx **是唯一**映射宿主端口的服务
 * 3. 每个服务都有 `healthcheck`（任务书：container health）
 * 4. 每个服务都有日志轮转（docs/15：Docker log rotate）
 * 5. nginx 是**同域**：`/` → web、`/api/` → api（docs/16）
 * 6. Dockerfile 多阶段且**不含 secret**（任务书：镜像不含 secret）
 * 7. 备份/恢复脚本存在且**可执行位正确**
 * 8. `.dockerignore` 排除了 `.env` / `node_modules`（镜像不含 secret 的一半）
 */

import { readFileSync, existsSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

const failures = [];
const passes = [];
const skips = [];

function check(name, condition, detail) {
  if (condition) passes.push(name);
  else failures.push(`${name}${detail === undefined ? '' : ` — ${detail}`}`);
}

/**
 * 取某个服务在 compose 里的**那一块**文本。
 *
 * 第一版用 `/^  mysql:[\s\S]*?\n    ports:/m` —— 那是错的：
 * 惰性匹配会一路吃到**后面某个服务**的 `ports:`（nginx 的），
 * 于是「mysql 没有宿主端口」永远报失败。
 * 服务块必须**限定**在「本服务键」到「下一个顶层键」之间。
 */
function serviceBlock(source, service) {
  const start = source.indexOf(`\n  ${service}:`);
  if (start === -1) return '';
  const rest = source.slice(start + 1);
  const next = rest.slice(1).search(/\n  [a-z][a-z0-9_-]*:/);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

function read(relative) {
  const path = `${ROOT}${relative}`;
  if (!existsSync(path)) return null;
  return readFileSync(path, 'utf8');
}

/* ------------------------------------------------------------------ */
/* compose                                                             */
/* ------------------------------------------------------------------ */

const compose = read('docker-compose.yml');
check('docker-compose.yml 存在', compose !== null);

if (compose !== null) {
  const services = ['mysql', 'redis', 'api', 'worker', 'web', 'nginx'];
  for (const service of services) {
    check(`compose 里有 ${service} 服务`, new RegExp(`^  ${service}:`, 'm').test(compose));
    check(`compose: ${service} 有 healthcheck`, serviceBlock(compose, service).includes('healthcheck:'));
    check(`compose: ${service} 有日志轮转`, serviceBlock(compose, service).includes('logging: *default-logging'));
  }

  // ⚠ 这两条是 `docs/16` 的「不暴露公网」，也是本文件最要紧的断言。
  check(
    'compose: mysql 没有任何宿主端口映射',
    !serviceBlock(compose, 'mysql').includes('\n    ports:'),
    'MySQL 必须只在 internal 网络里',
  );
  check(
    'compose: redis 没有任何宿主端口映射',
    !serviceBlock(compose, 'redis').includes('\n    ports:'),
    'Redis 必须只在 internal 网络里',
  );
  check(
    'compose: api / worker / web 也不映射宿主端口',
    ['api', 'worker', 'web'].every((name) => !serviceBlock(compose, name).includes('\n    ports:')),
    '只有 nginx 对外',
  );
  check(
    'compose: nginx 映射了 80 与 443',
    serviceBlock(compose, 'nginx').includes('80:80') && serviceBlock(compose, 'nginx').includes('443:443'),
  );

  check(
    'compose: internal 网络是 internal: true（没有出站路由）',
    /internal:[\s\S]{0,80}?internal: true/.test(compose),
  );
}

/* ------------------------------------------------------------------ */
/* nginx：同域（docs/16）                                              */
/* ------------------------------------------------------------------ */

const nginx = read('infra/nginx/nginx.conf');
check('infra/nginx/nginx.conf 存在', nginx !== null);

if (nginx !== null) {
  // 配置里用的是 upstream 名（signal_web / signal_api），所以先认 upstream 定义，
  // 再认 location 引用的是哪一个。
  const upstreamForWeb = /upstream\s+(\w+)\s*\{\s*server\s+web:3000/.exec(nginx)?.[1];
  const upstreamForApi = /upstream\s+(\w+)\s*\{\s*server\s+api:3001/.exec(nginx)?.[1];
  check('nginx: 有指向 web:3000 的 upstream', upstreamForWeb !== undefined);
  check('nginx: 有指向 api:3001 的 upstream', upstreamForApi !== undefined);
  check(
    'nginx: / 转发到 web',
    upstreamForWeb !== undefined &&
      new RegExp(`location\\s+/\\s*\\{[\\s\\S]*?proxy_pass\\s+http://${upstreamForWeb}`).test(nginx),
  );
  check(
    'nginx: /api/ 转发到 api',
    upstreamForApi !== undefined &&
      new RegExp(`location\\s+/api/\\s*\\{[\\s\\S]*?proxy_pass\\s+http://${upstreamForApi}`).test(nginx),
  );
  check(
    'nginx: `X-Request-Id` 透传（docs/15：贯穿 Web → API → Queue → Worker）',
    /X-Request-Id/.test(nginx),
  );
  check('nginx: 只对外暴露 80/443', /listen\s+443/.test(nginx) && /listen\s+80/.test(nginx));
}

/* ------------------------------------------------------------------ */
/* Dockerfile：多阶段 + 不含 secret                                     */
/* ------------------------------------------------------------------ */

const dockerfile = read('infra/Dockerfile');
check('infra/Dockerfile 存在', dockerfile !== null);

if (dockerfile !== null) {
  check('Dockerfile: 是多阶段构建（有 FROM ... AS）', /FROM\s+\S+\s+AS\s+\w+/i.test(dockerfile));
  check(
    'Dockerfile: 提供 api / worker / web 三个 target',
    ['api', 'worker', 'web'].every((target) => new RegExp(`FROM\\s+\\S+\\s+AS\\s+${target}\\b`, 'i').test(dockerfile)),
  );
  // 镜像里不能有 secret：不许 COPY .env*，不许把 secret 写成 ENV/ARG 的默认值
  check('Dockerfile: 没有 COPY .env', !/COPY\s+[^\n]*\.env/i.test(dockerfile));
  check(
    'Dockerfile: 没有把 secret 写成 ARG/ENV 默认值',
    !/(ARG|ENV)\s+\w*(SECRET|PASSWORD|TOKEN|PEPPER|KEY)\w*\s*=\s*\S+/i.test(dockerfile),
  );
}

const dockerignore = read('.dockerignore');
check('.dockerignore 存在（镜像不含 secret 的另一半）', dockerignore !== null);
if (dockerignore !== null) {
  for (const pattern of ['.env', 'node_modules', '.git']) {
    check(`.dockerignore 排除了 ${pattern}`, dockerignore.split('\n').some((line) => line.trim() === pattern || line.trim() === `${pattern}/`));
  }
}

/* ------------------------------------------------------------------ */
/* 运维脚本                                                            */
/* ------------------------------------------------------------------ */

for (const script of [
  'scripts/ops/backup-mysql.sh',
  'scripts/ops/restore-mysql.sh',
  'scripts/ops/healthcheck.sh',
]) {
  const exists = existsSync(`${ROOT}${script}`);
  check(`${script} 存在`, exists);
  if (exists) {
    // ⚠ 「可执行」是硬要求：cron 与 docs/16 的恢复演练都靠它。
    //
    // 但**不能查文件系统**：Windows 的 NTFS 没有 unix 权限位，
    // `chmod +x` 在那里查出来永远是 0 —— 而仓库本身是正确的。
    // 真正该查的是 **git index 里的 mode**（100755）：
    // 那才是 clone 到 Linux 上之后文件会有的权限。
    // 所以优先用 `git ls-files -s`，非 git 环境才退回 stat。
    let executable = false;
    try {
      const out = execFileSync('git', ['ls-files', '-s', '--', script], {
        cwd: ROOT,
        encoding: 'utf8',
      });
      executable = out.trim().startsWith('100755');
    } catch {
      executable = (statSync(`${ROOT}${script}`).mode & 0o111) !== 0;
    }
    check(`${script} 在 git index 里是可执行的（mode 100755）`, executable);
  }
}

const backup = read('scripts/ops/backup-mysql.sh');
if (backup !== null) {
  check('backup: 用 mysqldump', /mysqldump/.test(backup));
  check('backup: 备份前先记 binlog 位置（RPO 要靠它 replay）', /SHOW MASTER STATUS|SHOW BINARY LOG STATUS/.test(backup));
  check('backup: 加密（docs/16：备份加密后上传）', /openssl enc|age |gpg /.test(backup));
  check('backup: 保留策略 7 daily / 4 weekly / 6 monthly', /7[\s\S]{0,200}4[\s\S]{0,200}6/.test(backup));
  check('backup: 上传 R2（rclone）', /rclone/.test(backup));
}

const restore = read('scripts/ops/restore-mysql.sh');
if (restore !== null) {
  check('restore: 解压/解密还原', /openssl enc|rclone|zcat|gunzip/.test(restore));
  check('restore: replay binlog', /mysqlbinlog/.test(restore));
  check('restore: 之后核对 migrate status（docs/16 第 4 步）', /migrate\s+(status|deploy)/.test(restore));
}

const healthcheck = read('scripts/ops/healthcheck.sh');
if (healthcheck !== null) {
  check('healthcheck: 打 /health/live 与 /health/ready', /health\/live/.test(healthcheck) && /health\/ready/.test(healthcheck));
}

/* ------------------------------------------------------------------ */
/* 部署 workflow：migration gate（docs/16）                            */
/* ------------------------------------------------------------------ */

const deploy = read('.github/workflows/deploy.yml');
check('.github/workflows/deploy.yml 存在', deploy !== null);
if (deploy !== null) {
  check('deploy: 迁移先于切 app（migration gate）', /migrate\s+deploy/.test(deploy));
  check('deploy: 保留上一镜像 tag 便于回滚', /ROLLBACK_TAG|previous_tag|LAST_TAG/.test(deploy));
  // `password: ${{ secrets.X }}` 是**正确**写法；要抓的是硬编码的值。
  // 第一版写成 `!/password:\s*\S+/` —— 把 secrets 引用也判成了违规。
  check('deploy: 用了 secrets 上下文', /secrets\./.test(deploy));
  check(
    'deploy: 没有硬编码的 secret（值必须来自 secrets 上下文）',
    !/(password|token|secret|key):\s*(?!\$\{\{)[^\s$]\S*/i.test(deploy),
  );
}

/* ------------------------------------------------------------------ */
/* Docker（可选）                                                      */
/* ------------------------------------------------------------------ */

let dockerSkipReason = null;
try {
  const envFile = `${ROOT}infra/ops-check.env`;
  execFileSync('docker', ['--version'], { stdio: 'ignore' });
  // 用一份**临时**的最小 env 做插值校验（真实 secret 不在仓库里）
  execFileSync('docker', ['compose', '--env-file', envFile, 'config', '--quiet'], {
    cwd: ROOT,
    stdio: 'pipe',
  });
  passes.push('docker compose config 通过（真实插值校验）');
} catch (error) {
  dockerSkipReason = error instanceof Error ? error.message.split('\n')[0] : String(error);
}

/* ------------------------------------------------------------------ */

process.stdout.write(`\n✅ 通过 ${String(passes.length)} 项\n`);
if (skips.length > 0) for (const skip of skips) process.stdout.write(`⏭  跳过 ${skip}\n`);

if (dockerSkipReason !== null) {
  // ⚠ **跳过要打印出来**：不能因为「没装 docker」就静默算通过
  process.stdout.write(
    `⏭  跳过 docker compose config（${dockerSkipReason}）\n` +
      '   → 这条不能算通过。装了 Docker 的机器上必须重跑。\n',
  );
}

if (failures.length > 0) {
  process.stdout.write(`\n❌ 失败 ${String(failures.length)} 项：\n`);
  for (const failure of failures) process.stdout.write(`   · ${failure}\n`);
  process.exit(1);
}

process.stdout.write('\n部署形态校验通过。\n');
