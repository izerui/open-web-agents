#!/usr/bin/env bash
#
# 端到端测试的起停编排:构建 → 起服务 → 等就绪 → 跑断言 → 无论成败都拆干净。
#
# 为什么需要它:这一轮审查里最严重的几个缺陷(越权、API Key 枚举、假的停止按钮)
# 单测全都是绿的,只有从 HTTP 打进去才暴露。而此前那些验证全靠我手工敲命令 ——
# 换句话说,下次谁把它们改坏了,不会有任何人知道。
#
# 用法:
#   pnpm test:e2e                     # 自己起停(默认端口 3100,不碰你正在跑的 3000)
#   OWA_E2E_BASE_URL=... pnpm test:e2e:run   # 打到一个已经起好的服务上
set -uo pipefail

PORT="${OWA_E2E_PORT:-3100}"
BASE="http://localhost:${PORT}"
LOG="${TMPDIR:-/tmp}/owa-e2e-server.log"
SERVER_PID=""

cleanup() {
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "[e2e] 关闭测试服务(pid=$SERVER_PID)"
    kill -TERM "$SERVER_PID" 2>/dev/null || true
    for _ in $(seq 1 20); do kill -0 "$SERVER_PID" 2>/dev/null || break; sleep 0.5; done
    kill -9 "$SERVER_PID" 2>/dev/null || true
  fi
}
# 无论测试成败、还是被 Ctrl-C,都要把服务拆掉 —— 留一个占着端口的僵尸进程
# 会让下一次运行以完全无关的方式失败
trap cleanup EXIT INT TERM

if [ -n "${OWA_E2E_BASE_URL:-}" ]; then
  echo "[e2e] 复用已有服务:$OWA_E2E_BASE_URL"
else
  # 端口被占就直接停,别让测试打到一个来路不明的进程上
  if lsof -ti:"$PORT" >/dev/null 2>&1; then
    echo "[e2e] 端口 $PORT 已被占用,先释放它或用 OWA_E2E_PORT 换一个" >&2
    exit 1
  fi

  # CI 里前一步已经构建过,没必要再来一遍(构建是这条流水线里最慢的一环)
  if [ "${OWA_E2E_SKIP_BUILD:-0}" = "1" ]; then
    echo "[e2e] 跳过构建(OWA_E2E_SKIP_BUILD=1)"
  else
    echo "[e2e] 构建…"
    pnpm build >/dev/null || { echo "[e2e] 构建失败" >&2; exit 1; }
  fi

  echo "[e2e] 起服务(端口 $PORT,日志 $LOG)…"
  PORT="$PORT" pnpm start >"$LOG" 2>&1 &
  SERVER_PID=$!

  ready=""
  for _ in $(seq 1 60); do
    if curl -sf "${BASE}/api/health?probe=live" >/dev/null 2>&1; then ready=1; break; fi
    # 服务自己先挂了就别再空等
    kill -0 "$SERVER_PID" 2>/dev/null || break
    sleep 1
  done
  if [ -z "$ready" ]; then
    echo "[e2e] 服务未能就绪,日志尾部:" >&2
    tail -30 "$LOG" >&2
    exit 1
  fi

  # 就绪探针要真的 ready —— 依赖没起来时早点失败,好过让断言以奇怪的方式红
  if ! curl -sf "${BASE}/api/health" >/dev/null 2>&1; then
    echo "[e2e] 服务活着但未就绪(MySQL / Redis 没起?):" >&2
    curl -s "${BASE}/api/health" >&2; echo >&2
    exit 1
  fi

  export OWA_E2E_BASE_URL="$BASE"
  echo "[e2e] 就绪:$BASE"
fi

echo "[e2e] 跑断言…"
npx vitest run --config vitest.e2e.config.ts
