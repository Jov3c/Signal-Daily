# Signal 镜像 —— 一个多阶段 Dockerfile，三个 target（api / worker / web）。
#
# 不拆成三个文件：三个 app 共享同一个 pnpm workspace 的锁与 packages/*，
# 拆开就要把 workspace 复制三遍，而层缓存对它们是一样的。
#
# 镜像里不含 secret：所有密钥在运行期通过 env_file 注入（见 .dockerignore）。

FROM node:22-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app

FROM base AS deps
# 先只复制清单：源码改动不该让依赖层失效
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
COPY packages/contracts/package.json packages/contracts/
COPY packages/config/package.json packages/config/
COPY packages/logger/package.json packages/logger/
COPY packages/source-core/package.json packages/source-core/
COPY packages/test-utils/package.json packages/test-utils/
# --frozen-lockfile：锁文件与清单不一致时构建失败，而不是悄悄换版本
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
# ⚠ **必须先生成 Prisma 客户端，否则 `pnpm build` 一定失败。**
#
# 机制（不是猜的，是 2026-10-01 修掉镜像 tag 之后暴露出来的）：
#   `deps` 阶段**只复制了各个 package.json**（见上，为了层缓存），
#   那时 `prisma/schema.prisma` 还不在镜像里 —— 于是 `@prisma/client` 安装时
#   的 postinstall 只能生成一个**没有模型/枚举的客户端**。
#   `deps` 的 node_modules 被本阶段继承，而**没有任何地方再跑过 generate**。
#
# 本地不会发现：开发机的 node_modules 里早就有一份生成好的客户端，
# 所以 `pnpm build` 一直是过的。**任何干净的机器上都构建不出来。**
#
# 实测报错（CI，修 tag 后的第一次运行）：
#   prisma/seed.ts: Module '"@prisma/client"' has no exported member 'SourceKind'
#   apps/api/…/prisma-admin-ops.repository.ts: … 'AiRunStatus' / 'Decimal' …
#
# 根 `package.json` **没有 postinstall**，所以不会有人替我们跑这一步 ——
# 它必须显式写在这里。
RUN pnpm db:generate
RUN pnpm build
RUN pnpm --filter @signal/web build

FROM base AS runtime
ENV NODE_ENV=production
# ⚠ **从 `build` 而不是 `deps` 拿 node_modules。** 两者的差别只有一处，但它是致命的：
#
# ```text
# prisma generate 在 build 阶段跑（见上），生成物落在
#   node_modules/.pnpm/@prisma+client@…/node_modules/.prisma/client
# 而 deps 阶段**没有**它 —— 那一步 schema.prisma 还不在镜像里。
# ```
#
# 从 deps 拷的后果是「**编译期绿、运行期炸**」：`tsc` 在 build 阶段看得到那些类型，
# 所以 `pnpm build` 通过；但运行镜像里没有生成物，`@prisma/client` 的枚举是 `undefined`。
#
# 2026-10-01 实测（容器启动即崩，API 与 worker 都是）：
#   /app/apps/api/dist/modules/admin-ops/prisma-admin-ops.repository.js:37
#       [client_1.JobRunStatus.QUEUED]: contracts_1.JobRunStatus.QUEUED,
#   TypeError: Cannot read properties of undefined (reading 'QUEUED')
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=build /app/apps/worker/node_modules ./apps/worker/node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/pnpm-workspace.yaml ./pnpm-workspace.yaml
COPY --from=build /app/packages ./packages
COPY --from=build /app/prisma ./prisma
# 不用 root 跑：容器被攻破时少一层
USER node

FROM runtime AS api
COPY --from=build /app/apps/api ./apps/api
EXPOSE 3001
CMD ["node", "apps/api/dist/main.js"]

FROM runtime AS worker
COPY --from=build /app/apps/worker ./apps/worker
CMD ["node", "apps/worker/dist/main.js"]

FROM runtime AS web
COPY --from=build /app/apps/web ./apps/web
EXPOSE 3000
# ⚠ **不要用 `pnpm --filter @signal/web start`。** pnpm 启动时会先做一次
# deps-status 校验（`runDepsStatusCheck`），而运行镜像里的 node_modules 是
# **部分拷贝**的（只有根 + api + worker，没有 web 那一份的完整 workspace 视图）
# → 校验直接失败，容器进入重启循环。2026-10-01 实测：
#   at runDepsStatusCheck (…/pnpm.mjs:250510:7)
#
# 直接用 node 跑 next，绕开包管理器 —— 运行容器本来也不需要 pnpm。
#
# ⚠ **必须把 WORKDIR 切到 `apps/web`**：`next start` 是按**当前工作目录**找
# `.next` 的，不是按 next 这个包的位置。留在 `/app` 会让它去找 `/app/.next`：
#   [Error: Could not find a production build in the '.next' directory.]
# 原来的 `pnpm --filter @signal/web start` 之所以没这问题，是 pnpm 会把 cwd
# 切到那个 package 的目录 —— 换成直接 node 就把这一步丢了。
# ⚠ 顺序要紧：WORKDIR 写在 COPY **之后**，否则 COPY 的相对目标也跟着变。
WORKDIR /app/apps/web
CMD ["node", "node_modules/next/dist/bin/next", "start", "-p", "3000"]
