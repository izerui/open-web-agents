#!/usr/bin/env bash
#
# 在本机按 .github/workflows/ci.yml 的步骤顺序实跑一遍。
#
# 为什么需要它:YAML 语法正确 ≠ 里面的命令能跑通,这两件事经常被混为一谈。
# 本地没法跑 GitHub Actions,但【每一条 run: 里的命令本身】是可以先验的 ——
# 剩下真正只能靠推一次才知道的,就只有 Actions 特有的那部分
# (服务容器健康检查时序、容器网络、action 缓存),见 README「已知限制」。
#
# 前置:本机跑着 MySQL 与 Redis。
#   OWA_CI_DB_URL 给一个有建库权限的连接串(库名部分会被忽略)。
#
# 用法:
#   OWA_CI_DB_URL='mysql://root:pw@127.0.0.1:3306/owa' bash scripts/ci-dryrun.sh
set -uo pipefail
cd "$(dirname "$0")/.."

DB_URL="${OWA_CI_DB_URL:-}"
if [ -z "$DB_URL" ]; then
  echo "需要 OWA_CI_DB_URL,例如:" >&2
  echo "  OWA_CI_DB_URL='mysql://root:pw@127.0.0.1:3306/owa' bash scripts/ci-dryrun.sh" >&2
  exit 1
fi
REDIS_URL="${OWA_CI_REDIS_URL:-redis://127.0.0.1:6379}"
BASE_DB="${DB_URL%/*}"

fail=0
step() { echo; echo "── $* ──"; }
ok()   { echo "  ✓ $*"; }
bad()  { echo "  ✗ $*"; fail=1; }

step "job:check — 建库(用 mysql2 而非 mysql CLI)"
OWA_DATABASE_URL="$DB_URL" node scripts/ensure-databases.mjs owa owa_test >/dev/null 2>&1 \
  && ok "ensure-databases" || bad "ensure-databases"

step "job:check — 迁移(两个库都迁)"
for db in owa owa_test; do
  OWA_DATABASE_URL="$BASE_DB/$db" \
  OWA_REDIS_URL="$REDIS_URL" \
  OWA_SESSION_SECRET=ci-session-secret \
  OWA_SECRET_KEY=ci-secret-key \
    pnpm db:migrate >/dev/null 2>&1 && ok "migrate $db" || bad "migrate $db"
done

export OWA_TEST_DATABASE_URL="$BASE_DB/owa_test"
export OWA_TEST_REDIS_URL="$REDIS_URL"

step "job:check — typecheck"
pnpm typecheck >/dev/null 2>&1 && ok typecheck || bad typecheck

step "job:check — lint"
pnpm lint >/dev/null 2>&1 && ok lint || bad lint

step "job:check — 单测(带真实依赖)"
# 与 CI 同款:pipefail 必须开,否则测试失败会被 tee 的成功退出码盖住
( set -eo pipefail; pnpm test 2>&1 | tee /tmp/owa-ci-unit.log >/dev/null )
[ "$?" = "0" ] && ok "测试通过(pipefail 生效)" || bad "测试失败"
grep -E "^ +Tests " /tmp/owa-ci-unit.log | sed 's/^/    /'

step "job:check — 跳过守卫(依赖齐全时不该触发)"
if grep -q "\[skip\]" /tmp/owa-ci-unit.log; then
  bad "有测试被跳过:$(grep '\[skip\]' /tmp/owa-ci-unit.log | head -1)"
else
  ok "无跳过"
fi

step "守卫本身有效吗?(故意抽掉依赖,应当触发)"
# 一条从不触发的守卫等于没有 —— 必须反向验一次
( unset OWA_TEST_DATABASE_URL OWA_TEST_REDIS_URL
  npx vitest run >/tmp/owa-ci-noenv.log 2>&1 )
if grep -q "\[skip\]" /tmp/owa-ci-noenv.log; then
  ok "缺依赖时守卫会拦下(不是摆设)"
else
  bad "缺依赖时守卫没反应"
fi

step "job:e2e — build"
export OWA_DATABASE_URL="$BASE_DB/owa"
export OWA_REDIS_URL="$REDIS_URL"
export OWA_SESSION_SECRET=ci-session-secret-not-for-production
export OWA_SECRET_KEY=ci-secret-key-not-for-production
export OWA_AUTH_REQUIRED=1 OWA_SANDBOX=0 OWA_DATA_DIR=./data
pnpm build >/dev/null 2>&1 && ok build || bad build

step "job:e2e — 跳过构建 + 自动起停"
OWA_E2E_SKIP_BUILD=1 pnpm test:e2e > /tmp/owa-ci-e2e.log 2>&1
rc=$?
grep -q "跳过构建" /tmp/owa-ci-e2e.log && ok "OWA_E2E_SKIP_BUILD 生效" || bad "跳过构建的开关没生效"
[ "$rc" = "0" ] && ok "e2e 通过" || bad "e2e 失败 rc=$rc"
grep -E "^ +Tests " /tmp/owa-ci-e2e.log | sed 's/^/    /'

step "job:e2e — 服务是否被拆干净"
sleep 1
if lsof -ti:"${OWA_E2E_PORT:-3100}" >/dev/null 2>&1; then
  bad "端口仍被占用,清理没生效"
else
  ok "端口已释放"
fi

echo
if [ "$fail" = "0" ]; then
  echo "全部步骤本地实跑通过"
else
  echo "有步骤失败,见上"
fi
exit $fail
