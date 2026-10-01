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
  const next = rest.slice(1).search(/\n {2}[a-z][a-z0-9_-]*:/);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

/**
 * 取一个服务块里 **`healthcheck:` 那一段**。
 *
 * ⚠ 为什么不直接在服务块里找 URL：**注释和别的配置值里都会出现 URL**。
 * 2026-10-01 实测踩到（这一条真的误报过）：给 api 服务补
 * `APP_BASE_URL: ${PUBLIC_BASE_URL:-https://localhost}`（容器形态必需，
 * 否则 `AdminOriginGuard` 会把后台写操作全判成跨源）之后，
 * 「服务块里第一个 URL」就变成了它 —— 于是下面那条
 * 「healthcheck 打的是 /health/」**误报失败**，报的是 `https://localhost`。
 *
 * 断言要看的是 **healthcheck 里的那个 URL**，所以必须限定到这一段。
 * 服务块内部的一级键是 4 空格缩进，所以下一个同级键就是它的边界。
 */
function healthcheckBlock(serviceBlockText) {
  const start = serviceBlockText.indexOf('healthcheck:');
  if (start === -1) return '';
  const rest = serviceBlockText.slice(start);
  const next = rest.slice(1).search(/\n {4}[a-z][a-z0-9_-]*:/);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

/**
 * 取一个服务 `networks:` 里列出的网络名。两种写法都支持：
 * `networks: [a, b]` 与 `networks:\n  - a\n  - b`。
 */
function serviceNetworks(source, service) {
  const block = serviceBlock(source, service);
  const inline = /networks:\s*\[([^\]]*)\]/.exec(block)?.[1];
  if (inline !== undefined) {
    return inline
      .split(',')
      .map((name) => name.trim())
      .filter((name) => name !== '');
  }
  const list = /networks:\s*\n((?:\s*-\s*\S+\s*\n?)+)/.exec(block)?.[1];
  if (list === undefined) return [];
  return [...list.matchAll(/-\s*(\S+)/g)].map((match) => match[1]);
}

/**
 * 顶层 `networks:` 块里，哪些网络声明了 `internal: true`（= **没有出站路由**）。
 *
 * ⚠ 从网络定义**推导**，而不是写死 `internal` / `egress` 这些名字：
 * 将来换名字不会误报，而「某个网络被设成 internal」这件事一定被看见。
 */
function internalOnlyNetworks(source) {
  // 顶层那个是 `\nnetworks:`（顶格）；服务里的缩进 4 空格，不会误匹配。
  const start = source.indexOf('\nnetworks:');
  if (start === -1) return [];
  const rest = source.slice(start + 1);
  const end = rest.slice(1).search(/\n[a-z][a-z0-9_-]*:/);
  const block = end === -1 ? rest : rest.slice(0, end + 1);
  // 块内每个网络是 2 空格缩进的键
  return block
    .split(/\n {2}(?=[a-z][a-z0-9_-]*:)/)
    .slice(1)
    .filter((part) => /internal:\s*true/.test(part))
    .map((part) => part.slice(0, part.indexOf(':')));
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
    check(
      `compose: ${service} 有 healthcheck`,
      serviceBlock(compose, service).includes('healthcheck:'),
    );
    check(
      `compose: ${service} 有日志轮转`,
      serviceBlock(compose, service).includes('logging: *default-logging'),
    );
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
    serviceBlock(compose, 'nginx').includes('80:80') &&
      serviceBlock(compose, 'nginx').includes('443:443'),
  );

  check(
    'compose: internal 网络是 internal: true（没有出站路由）',
    /internal:[\s\S]{0,80}?internal: true/.test(compose),
  );

  /**
   * ⚠⚠ **worker 必须有出网能力** —— 本文件里最容易被「看起来对」骗过去的一条。
   *
   * 守的是一个真实事故（2026-10-01）：worker 原本只挂 `internal`，
   * 而 `internal: true` 掐断的**恰恰是出站**。于是**全栈唯一必须访问互联网的
   * 组件**（抓 RSS / X / GitHub / HN / HF，以及调 AI Provider）连 DNS 都出不去：
   *
   * ```text
   *   SOURCE_FETCH_FAILED: … Source host could not be resolved
   *                        (DNS_RESOLUTION_FAILED)
   * ```
   *
   * 而它的后果之所以恶劣，是因为**表面上一切正常**：
   * `docker compose ps` 显示 worker **healthy** —— 那个 healthcheck 只跑
   * `test -d /proc/1`，只能证明 PID 1 还活着，证明不了它有业务能力。
   * 采集全废，但没有任何一处报错。
   *
   * 所以必须有东西拦着它被改回去。判据是**性质**而不是名字：
   * worker 的 `networks:` 里至少要有一个不是 `internal: true` 的网络。
   */
  const workerNetworks = serviceNetworks(compose, 'worker');
  const noEgress = internalOnlyNetworks(compose);
  const outbound = workerNetworks.filter((name) => !noEgress.includes(name));
  check(
    'compose: worker 有出网能力（不能只挂 internal）',
    workerNetworks.length > 0 && outbound.length > 0,
    `worker 当前挂在 [${workerNetworks.join(', ')}]，其中没有一个是能出网的` +
      `（internal: true 的网络没有任何出站路由）。` +
      ' worker 要抓 RSS / X / GitHub / HN / HF 并调 AI Provider ——' +
      ' 没有出站能力时采集会永久失败，而 docker compose ps 仍然显示 healthy。',
  );

  /**
   * ⚠⚠ **三个 app 服务必须有 `image:`，且必须带 `${IMAGE_TAG}`。**
   *
   * 守的是 `docs/16` 那条设计有没有真的闭环：
   *
   * ```text
   *   CI 构建镜像 → VPS `docker compose pull` → `up`
   * ```
   *
   * 2026-10-01 查证时发现**它从来没闭环过**：三个 app 只有 `build:`，
   * 于是 `compose pull` 无物可拉，`up` 会在 VPS 上**从源码重建** ——
   * 「CI 构建的那个 SHA」与「VPS 实际跑的版本」再无关系，回滚也无从谈起。
   */
  const appServices = ['api', 'worker', 'web'];
  const imageLines = new Map(
    appServices.map((name) => [
      name,
      /\n {4}image:[^\n]*/.exec(serviceBlock(compose, name))?.[0] ?? '',
    ]),
  );

  check(
    'compose: api / worker / web 都有 image:',
    appServices.every((name) => imageLines.get(name) !== ''),
    '少了它，`docker compose pull` 无物可拉，VPS 会在本地从源码重建 ——' +
      ' CI 构建的镜像与实际运行的版本不闭环，回滚也无从谈起。',
  );

  check(
    'compose: 三个 app 的 image 都带 ${IMAGE_TAG}',
    appServices.every((name) => (imageLines.get(name) ?? '').includes('${IMAGE_TAG')),
    '少了它，部署时注入的 github.sha 与 .last-good-tag 落不到镜像上 ——' +
      ' 切版本与回滚都会变成空操作。',
  );

  check(
    'compose: 三个 app 的 image 各自指向对应的 target',
    appServices.every((name) => (imageLines.get(name) ?? '').includes(`/${name}:`)),
    '镜像名末尾应当是对应的服务名（api / worker / web），别是复制粘贴错的。',
  );

  /**
   * ⚠ 直接把**那条让流水线 13 次全失败的规矩**写成断言。
   *
   * `ghcr.io` 的引用名必须全小写。仓库叫 `Jov3c/Signal-Daily`（有大写），
   * 而 buildx 在这里报的不是「名字不合法」而是
   * `repository name must be lowercase` —— 挂在**打 tag** 那一步，
   * 三条 build 全部作废。此前每一次推送都死在这一行。
   */
  check(
    'compose: 镜像名前缀是全小写（GHCR 拒绝大写）',
    appServices.every((name) => {
      const path = /image:\s*([^\s:]+)/.exec(imageLines.get(name) ?? '')?.[1] ?? '';
      return path !== '' && path === path.toLowerCase();
    }),
    'GHCR 的引用名必须全小写 —— 含大写时 buildx 报 ' +
      '"repository name must be lowercase"，且挂在打 tag 那一步，三条 build 全部作废。',
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
      new RegExp(`location\\s+/\\s*\\{[\\s\\S]*?proxy_pass\\s+http://${upstreamForWeb}`).test(
        nginx,
      ),
  );
  check(
    'nginx: /api/ 转发到 api',
    upstreamForApi !== undefined &&
      new RegExp(`location\\s+/api/\\s*\\{[\\s\\S]*?proxy_pass\\s+http://${upstreamForApi}`).test(
        nginx,
      ),
  );
  check(
    'nginx: `X-Request-Id` 透传（docs/15：贯穿 Web → API → Queue → Worker）',
    /X-Request-Id/.test(nginx),
  );
  check('nginx: 只对外暴露 80/443', /listen\s+443/.test(nginx) && /listen\s+80/.test(nginx));
  check(
    'nginx: /health/ 也转发到 api（docs/04：健康检查不在 /api/v1 下）',
    upstreamForApi !== undefined &&
      new RegExp(
        `location\\s+/health/\\s*\\{[\\s\\S]*?proxy_pass\\s+http://${upstreamForApi}`,
      ).test(nginx),
  );
}

/* ------------------------------------------------------------------ */
/* 健康检查：路径必须与代码一致                                          */
/* ------------------------------------------------------------------ */

/**
 * `/health/live` 与 `/health/ready` 的路径散落在**四处**（`docs/04`）：
 * 控制器装饰器、`bootstrap.ts` 的 `exclude`、compose 的 healthcheck、
 * `scripts/ops/healthcheck.sh`。
 *
 * ⚠ **逐字比对不在这里** —— 那需要 import `routes.ts` 导出的常量
 * （`HEALTH_READY_PATH` 是模板字符串拼出来的，文本解析不可靠），
 * 而本脚本是裸 node 跑 `.mjs`、import 不了 TS。逐字比对在
 * `apps/api/test/health-routes.spec.ts` 里，那里能取到可执行的常量，
 * 还会真的对那条路径发一次 HTTP。
 *
 * 这里负责的是**部署形态**那一半：exclude 有没有接上、compose 打的是不是
 * `/health/` 而不是 `/api/v1/health/`、nginx 有没有把它转给 api。
 * 少任何一条，容器会永远停在 `starting`，而 `pnpm test` 全绿。
 */
const routesFile = 'apps/api/src/modules/health/routes.ts';
check(`${routesFile} 存在（健康检查路由的唯一真源）`, read(routesFile) !== null);

const bootstrap = read('apps/api/src/bootstrap.ts');
if (bootstrap !== null) {
  // ⚠ 第一版写成 `\([^)]*exclude` —— 那是错的：实参里就有 `API_PREFIX.slice(1)`
  // 这个括号，`[^)]*` 在它那里就停了，于是永远报失败。
  // 这里按「同一行内」匹配，够用且不会被跨行吞掉。
  check(
    'bootstrap: setGlobalPrefix 带了 exclude',
    /setGlobalPrefix\s*\([^\n]*exclude/.test(bootstrap),
  );
  check(
    'bootstrap: exclude 用的是健康模块导出的路由表（不是手写字面量）',
    /HEALTH_ROUTE_EXCLUSIONS/.test(bootstrap),
  );
}

if (compose !== null) {
  const apiBlock = serviceBlock(compose, 'api');
  const url = /https?:\/\/[^\s"'\\]+/.exec(healthcheckBlock(apiBlock))?.[0];
  check('compose: api healthcheck 里有一个 URL', url !== undefined);
  check(
    'compose: api healthcheck 打的是 /health/（**不在** /api/v1 下）',
    url !== undefined && url.includes('/health/') && !url.includes('/api/'),
    url ?? '（未找到 URL）',
  );
}

/* ------------------------------------------------------------------ */
/* Dockerfile：多阶段 + 不含 secret                                     */
/* ------------------------------------------------------------------ */

const dockerfile = read('infra/Dockerfile');
check('infra/Dockerfile 存在', dockerfile !== null);

/**
 * ⚠ TLS 指南必须真的存在。
 *
 * `docker-compose.yml` 与 `nginx.conf` **两处**都写着「见
 * `infra/nginx/README.md`」—— 第一版那份文件并不存在，于是文档里的人
 * 被指向一个 404。这类悬空引用不会让任何测试变红，所以在这里钉住：
 * 指南是任务书的「必须」项（compose / nginx same-origin / **TLS 指南**）。
 */
const nginxReadme = read('infra/nginx/README.md');
check('infra/nginx/README.md 存在（compose 与 nginx.conf 都指向它）', nginxReadme !== null);
if (nginxReadme !== null) {
  // 指南必须覆盖那个真正的坑：证书不存在时 nginx 起不来，而 ACME 又需要
  // nginx 提供 80。只写「用 certbot 签一张」是不够的。
  check(
    'TLS 指南讲了首次部署的自签占位（否则新机器起不来）',
    /openssl req -x509/.test(nginxReadme),
  );
  check('TLS 指南讲了续期', /renew/.test(nginxReadme));
}

// compose 与 nginx.conf 里提到的仓库内文件都必须存在（悬空引用守卫）。
for (const referenced of [
  'infra/nginx/README.md',
  'infra/nginx/nginx.conf',
  'infra/mysql/my.cnf',
]) {
  check(`compose 引用的 ${referenced} 存在`, read(referenced) !== null);
}

if (dockerfile !== null) {
  check('Dockerfile: 是多阶段构建（有 FROM ... AS）', /FROM\s+\S+\s+AS\s+\w+/i.test(dockerfile));
  check(
    'Dockerfile: 提供 api / worker / web 三个 target',
    ['api', 'worker', 'web'].every((target) =>
      new RegExp(`FROM\\s+\\S+\\s+AS\\s+${target}\\b`, 'i').test(dockerfile),
    ),
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
    check(
      `.dockerignore 排除了 ${pattern}`,
      dockerignore
        .split('\n')
        .some((line) => line.trim() === pattern || line.trim() === `${pattern}/`),
    );
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
    const executable = (() => {
      try {
        const out = execFileSync('git', ['ls-files', '-s', '--', script], {
          cwd: ROOT,
          encoding: 'utf8',
        });
        return out.trim().startsWith('100755');
      } catch {
        return (statSync(`${ROOT}${script}`).mode & 0o111) !== 0;
      }
    })();
    check(`${script} 在 git index 里是可执行的（mode 100755）`, executable);
  }
}

const backup = read('scripts/ops/backup-mysql.sh');
if (backup !== null) {
  check('backup: 用 mysqldump', /mysqldump/.test(backup));
  check(
    'backup: 备份前先记 binlog 位置（RPO 要靠它 replay）',
    /SHOW MASTER STATUS|SHOW BINARY LOG STATUS/.test(backup),
  );
  check('backup: 加密（docs/16：备份加密后上传）', /openssl enc|age |gpg /.test(backup));
  check(
    'backup: 保留策略 7 daily / 4 weekly / 6 monthly',
    /7[\s\S]{0,200}4[\s\S]{0,200}6/.test(backup),
  );
  check('backup: 上传 R2（rclone）', /rclone/.test(backup));
}

const restore = read('scripts/ops/restore-mysql.sh');
if (restore !== null) {
  check('restore: 解压/解密还原', /openssl enc|rclone|zcat|gunzip/.test(restore));
  check('restore: replay binlog', /mysqlbinlog/.test(restore));
  check(
    'restore: 之后核对 migrate status（docs/16 第 4 步）',
    /migrate\s+(status|deploy)/.test(restore),
  );
}

const healthcheck = read('scripts/ops/healthcheck.sh');
if (healthcheck !== null) {
  check(
    'healthcheck: 打 /health/live 与 /health/ready',
    /health\/live/.test(healthcheck) && /health\/ready/.test(healthcheck),
  );
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

  /**
   * ⚠ **只扫 `deploy` 这个 job，不扫整个文件** —— 2026-10-02 收窄。
   *
   * 原来扫全文，于是加 `integration` job（真实 MySQL + Redis 的 service container）
   * 时当场误报：那一节里有
   *
   * ```yaml
   *   MYSQL_ROOT_PASSWORD: root
   *   MYSQL_PASSWORD: signal
   * ```
   *
   * 而那是**CI 服务容器的临时凭据** —— 只存在于 runner 内部一个用完即弃的
   * MySQL 上，硬编码是标准做法，也从来不会离开这个 job。
   *
   * 收窄**不损失覆盖**：生产凭据（`VPS_HOST` / `VPS_SSH_KEY` 等）只会出现在
   * `deploy` job 里 —— 这正是这条断言名字里那个 `deploy:` 前缀的意思。
   * 其余 job 里唯一的「凭据」是 `${{ secrets.GITHUB_TOKEN }}`，那是上下文引用，
   * 本来就匹配不上这条正则。
   */
  const deployJob = serviceBlock(deploy, 'deploy');
  check(
    'deploy: 没有硬编码的 secret（值必须来自 secrets 上下文）',
    !/(password|token|secret|key):\s*(?!\$\{\{)[^\s$]\S*/i.test(deployJob),
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
