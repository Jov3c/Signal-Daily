#!/usr/bin/env bash
# 健康检查 —— docs/15
#
# ```text
# /health/live  ：进程存活
# /health/ready ：MySQL + Redis 可用（**外部** AI/X/GitHub 不影响 readiness）
# ```
#
# ⚠ 两个端点分开是有意义的：只查 ready 会把「进程活着但依赖挂了」
# 与「进程根本没起来」混成一种告警。
set -euo pipefail

BASE="${API_BASE:-http://127.0.0.1:3001}"

check() {
  local path="$1" label="$2"
  local code
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$BASE$path" || echo 000)"
  if [ "$code" = "200" ]; then
    echo "ok   $label ($path)"
  else
    echo "FAIL $label ($path) -> HTTP $code" >&2
    return 1
  fi
}

fail=0
check /health/live  "进程存活" || fail=1
check /health/ready "MySQL + Redis 可用" || fail=1

if [ "$fail" -ne 0 ]; then
  echo "健康检查未通过" >&2
  exit 1
fi
echo "健康检查通过"
