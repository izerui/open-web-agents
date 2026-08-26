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

# claude-agent-sdk 会 spawn Bash 子进程执行工具,基础镜像需要这些命令。
#
# bubblewrap + socat:OS 内核沙箱(OWA_SANDBOX,默认开)在 Linux 下靠 bubblewrap
# 建命名空间隔离、socat 转发网络。它是 Bash 的【唯一】围栏 —— 路径守卫只能管
# Write/Edit/Read 这类参数里有结构化路径的工具;命令文本里的路径它管不了
# (引号/变量/拼接都能绕)。接口调用又是无人值守、不走审批的 ——
# 少了沙箱就等于给 agent 一个无限制的 shell。
#
# ⚠ bubblewrap 需要 user namespaces。若运行环境(k8s / 受限 seccomp / 无特权 userns)
#   禁用了它,沙箱起不来 → 所有 agent 运行硬失败(failIfUnavailable: true,
#   刻意没有“降级裸跑”这一档)。只有两条路:① 放开 userns 让沙箱能起(推荐);
#   ② 显式 OWA_SANDBOX=0 彻底不用沙箱。部署后先跑一条任务确认沙箱真的生效。
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git python3 \
      bubblewrap socat \
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
