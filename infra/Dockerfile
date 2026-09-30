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
RUN pnpm build
RUN pnpm --filter @signal/web build

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=deps /app/apps/worker/node_modules ./apps/worker/node_modules
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
CMD ["pnpm", "--filter", "@signal/web", "start"]
