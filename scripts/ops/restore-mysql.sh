#!/usr/bin/env bash
# 从备份恢复 —— docs/16 的九步
#
# ```text
# 1. 新 MySQL          5. 启 API
# 2. 恢复最近 full dump 6. 启 Worker
# 3. replay binlog     7. 清建 Redis cache
# 4. migrate status    8. health check
#                      9. 核对最近 Daily / Featured
# ```
#
# ⚠ 第 7 步（清 Redis）不是可选的：Redis 里有限流计数器与 BullMQ 队列，
# 不清的话旧队列里的 job 会带着**指向已不存在的行**的载荷重新跑起来。
# `docs/13` 说「Redis 不是业务数据库」—— 所以清它是安全的。
#
# 用法：
#   ./restore-mysql.sh /var/backups/signal/daily/signal-20260930T030000Z.sql.gz.enc
#   ./restore-mysql.sh <dump> [binlog 起始位置]
set -euo pipefail

DUMP_FILE="${1:?用法: restore-mysql.sh <dump.sql.gz.enc> [mysql-bin.000123:4567]}"
BINLOG_STOP="${2:-}"

: "${MYSQL_HOST:=127.0.0.1}"
: "${MYSQL_PORT:=3306}"
: "${MYSQL_DATABASE:=signal}"
: "${MYSQL_USER:=signal}"
: "${MYSQL_PASSWORD:?MYSQL_PASSWORD 必填}"
: "${BACKUP_ENCRYPTION_KEY:?BACKUP_ENCRYPTION_KEY 必填}"
: "${REDIS_URL:?REDIS_URL 必填（第 7 步要清缓存）}"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "== 2. 解密并恢复全量 dump =="
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 \
  -pass env:BACKUP_ENCRYPTION_KEY -in "$DUMP_FILE" -out "$WORK/dump.sql.gz"
gunzip -f "$WORK/dump.sql.gz"

# ⚠ 恢复前先把库清干净：dump 里只有 CREATE TABLE，不会删掉多出来的表
mysql --host="$MYSQL_HOST" --port="$MYSQL_PORT" --user="$MYSQL_USER" --password="$MYSQL_PASSWORD" \
  -e "DROP DATABASE IF EXISTS \`$MYSQL_DATABASE\`; CREATE DATABASE \`$MYSQL_DATABASE\`
      CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;"

mysql --host="$MYSQL_HOST" --port="$MYSQL_PORT" --user="$MYSQL_USER" --password="$MYSQL_PASSWORD" \
  "$MYSQL_DATABASE" < "$WORK/dump.sql"

echo "== 3. replay binlog =="
if [ -n "$BINLOG_STOP" ]; then
  # 从 R2 拉下需要的 binlog 再 replay（脚本只负责调用，不负责猜文件名）
  echo "   binlog 到 $BINLOG_STOP 为止：请先把 binlog 文件放到 $WORK/binlog/"
  mkdir -p "$WORK/binlog"
  rclone copy "$R2_REMOTE/binlog/" "$WORK/binlog/" 2>/dev/null || true
  for enc in "$WORK/binlog"/*.enc; do
    [ -e "$enc" ] || continue
    openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 \
      -pass env:BACKUP_ENCRYPTION_KEY -in "$enc" -out "${enc%.enc}"
  done
  mysqlbinlog --stop-position="$BINLOG_STOP" "$WORK"/binlog/mysql-bin.* \
    | mysql --host="$MYSQL_HOST" --port="$MYSQL_PORT" \
            --user="$MYSQL_USER" --password="$MYSQL_PASSWORD" "$MYSQL_DATABASE"
else
  echo "   （未给 binlog 位置 → 跳到 dump 那一刻；RPO 会退化为 24 小时）"
fi

echo "== 4. migration status（docs/16 第 4 步）=="
npx prisma migrate status || {
  echo "迁移状态不一致 —— 先跑 prisma migrate deploy 再启应用" >&2
  exit 1
}

echo "== 5/6. 启 API 与 Worker =="
docker compose up -d api worker

echo "== 7. 清 Redis（缓存 + 队列 + 限流计数器）=="
redis-cli -u "$REDIS_URL" FLUSHALL

echo "== 8. health check =="
./scripts/ops/healthcheck.sh

echo "== 9. 核对最近 Daily / Featured =="
mysql --host="$MYSQL_HOST" --port="$MYSQL_PORT" --user="$MYSQL_USER" --password="$MYSQL_PASSWORD" \
  "$MYSQL_DATABASE" -e "
    SELECT business_date, status, edition_no, published_at
      FROM daily_editions ORDER BY business_date DESC LIMIT 5;
    SELECT COUNT(*) AS featured_items FROM featured_items WHERE active = 1;"

echo "恢复完成 —— 请人工核对上面两行数字是否与备份时刻相符。"
