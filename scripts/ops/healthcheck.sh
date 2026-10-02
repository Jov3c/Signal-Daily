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

# ⚠⚠ **默认打的是 nginx 那一层，不是 api 容器的 3001** —— 2026-10-02 修。
#
# 原来默认是 `http://127.0.0.1:3001`，而 **3001 刻意不对宿主暴露**
#（`docs/16`：nginx 是唯一入口，api/web 都不映射端口）。于是这个脚本在
# **部署机上必然失败**：curl 连不上 → `000` → 健康检查不过 → 部署被判失败 → 回滚。
# 本机之所以看起来正常，是因为开发形态下 api 常常是直接跑在 3001 上的。
#
# 检查唯一对外的入口也更符合它想回答的问题：「站点现在能不能被访问」。
#
# ⚠ `CURL_INSECURE`：首次部署用的是**自签占位证书**（`infra/nginx/README.md`），
# 不加 `-k` 会因证书不可信而失败 —— 那会把「证书是自签的」误报成「服务挂了」。
# 换成真证书之后可以 `CURL_INSECURE=` 关掉它，让证书问题重新变成一个真失败。
BASE="${API_BASE:-https://127.0.0.1}"
CURL_INSECURE="${CURL_INSECURE:--k}"

check() {
  local path="$1" label="$2"
  local code
  code="$(curl -s $CURL_INSECURE -o /dev/null -w '%{http_code}' --max-time 5 "$BASE$path" || echo 000)"
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
