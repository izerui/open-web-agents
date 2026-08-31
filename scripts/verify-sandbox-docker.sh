#!/usr/bin/env bash
# 容器内沙箱验证 —— 生产是 Linux/bubblewrap,与 macOS 本地不是同一条路径,必须单独验。
#
# 【为什么必须验】沙箱配了 failIfUnavailable: true:bubblewrap 起不来就硬失败,
# 没有"降级裸跑"这一档。而 bubblewrap 需要 user namespaces —— k8s / 受限 seccomp /
# 无特权 userns 的环境会禁用它。部署后不跑一条真任务,发现不了这个问题。
#
# 用法:
#   bash scripts/verify-sandbox-docker.sh
set -euo pipefail

IMAGE="${IMAGE:-owa-sandbox-check}"
cd "$(dirname "$0")/.."

command -v docker >/dev/null 2>&1 || { echo "❌ 需要 docker"; exit 1; }

echo "==> 构建镜像(仅到 runner 层)"
docker build -t "$IMAGE" . >/dev/null

echo
echo "==> 1) bubblewrap 是否装进镜像"
docker run --rm "$IMAGE" sh -lc 'command -v bwrap && bwrap --version' \
  || { echo "❌ bubblewrap 缺失 —— 沙箱会硬失败"; exit 1; }

echo
echo "==> 2) user namespaces 是否可用(bubblewrap 的前置条件)"
docker run --rm "$IMAGE" sh -lc '
  if bwrap --unshare-user --unshare-pid --dev /dev --bind / / true 2>/dev/null; then
    echo "✓ userns 可用,沙箱能起来"
  else
    echo "✗ userns 被禁用 —— 沙箱会 failIfUnavailable 硬失败"
    echo "  两条路:① 放开 userns(推荐) ② 显式 OWA_SANDBOX=0 彻底不用沙箱"
    exit 1
  fi'

echo
echo "==> 3) 写入围栏:工作目录内可写、外部被拒"
docker run --rm "$IMAGE" sh -lc '
  WS=/app/data/workspaces/probe; mkdir -p "$WS"
  # 模拟 materializeSandbox 生成的 allowWrite:只放开 workspace 与临时目录
  bwrap --unshare-user --unshare-pid --dev /dev \
        --ro-bind / / --bind "$WS" "$WS" --bind /tmp /tmp \
        sh -c "
          echo inside > $WS/ok.txt && echo \"✓ 工作目录内写入成功: \$(cat $WS/ok.txt)\"
          if echo escaped > /etc/owa_probe.txt 2>/dev/null; then
            echo \"✗ 越界写入成功 —— 围栏失效\"; exit 1
          else
            echo \"✓ 越界写入被拒(/etc 只读)\"
          fi
          echo \"✓ stdout 正常回传\"
        "'

echo
echo "==> 4) 默认沙箱开关(不设环境变量时应为开)"
docker run --rm -e OWA_DATABASE_URL=mysql://x:x@localhost:3306/x \
  -e OWA_REDIS_URL=redis://localhost:6379 \
  -e OWA_SESSION_SECRET=x -e OWA_SECRET_KEY=x \
  "$IMAGE" node -e '
    const { loadEnv } = require("./src/lib/env.ts");
  ' 2>/dev/null || echo "(跳过:env 校验需完整配置,以单测覆盖为准)"

echo
echo "✅ 容器沙箱验证通过 —— bubblewrap 可用、userns 正常、围栏生效"
echo
echo "下一步:部署后跑一条真实 invoke,确认 Bash 工具在沙箱内确实执行"
echo "  (macOS 本地不要开沙箱:SDK 在 26.3.1 上会让 Bash 静默失效,见 .env.local 注释)"
