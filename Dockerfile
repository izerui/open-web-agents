# 多阶段构建。分开的理由:构建期依赖(devDependencies、源码)不该进最终镜像。
FROM node:22-slim AS base
ENV PNPM_HOME=/pnpm PATH="/pnpm:$PATH"
RUN corepack enable

# ---- 依赖层:只在 lockfile 变化时才重装 ----
FROM base AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm install --frozen-lockfile

# ---- 构建层 ----
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# 构建期不连数据库,给占位值让 env 校验通过
ENV OWA_DATABASE_URL=mysql://build:build@localhost:3306/build \
    OWA_REDIS_URL=redis://localhost:6379 \
    NEXT_TELEMETRY_DISABLED=1
RUN pnpm build

# ---- 运行层 ----
FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1

# claude-agent-sdk 会 spawn Bash 子进程执行工具,基础镜像需要这些命令
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git python3 \
    && rm -rf /var/lib/apt/lists/*

# 非 root 运行。agent 在容器里跑任意命令,给它 root 等于放弃容器这层隔离
RUN groupadd -g 1001 owa && useradd -u 1001 -g owa -m owa

COPY --from=builder --chown=owa:owa /app/.next/standalone ./
COPY --from=builder --chown=owa:owa /app/.next/static ./.next/static
COPY --from=builder --chown=owa:owa /app/public ./public
# worker 入口与迁移脚本要跑源码,连同其依赖一并带上
COPY --from=builder --chown=owa:owa /app/src ./src
COPY --from=builder --chown=owa:owa /app/drizzle ./drizzle
COPY --from=builder --chown=owa:owa /app/node_modules ./node_modules
COPY --from=builder --chown=owa:owa /app/package.json ./package.json
COPY --from=builder --chown=owa:owa /app/tsconfig.json ./tsconfig.json

# 会话工作空间:必须挂卷,否则容器重建就丢产物
RUN mkdir -p /app/data && chown -R owa:owa /app/data
VOLUME ["/app/data"]

USER owa
EXPOSE 5678
ENV PORT=5678 HOSTNAME=0.0.0.0 OWA_DATA_DIR=/app/data

# 存活探针用极轻的 ?probe=live —— 依赖挂了不该导致进程被反复重启
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:5678/api/health?probe=live" || exit 1

CMD ["node", "server.js"]
