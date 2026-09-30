#!/usr/bin/env bash
# 每 15 分钟把新产生的 binlog 同步到 R2 —— docs/16 的 RPO <= 15min
#
# ⚠ MySQL 的 binlog 是**服务端文件**，不能像普通文件那样直接读 ——
# 除非容器把 `/var/lib/mysql` 挂到宿主机（本仓库的 compose **没有**这么做，
# 因为它会把数据目录暴露给宿主机上的一切进程）。
#
# 所以这里用 `mysqlbinlog --read-from-remote-server` 从服务端拉，
# 这也是官方推荐的「备份 binlog」姿势。
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/var/backups/signal}"
: "${MYSQL_HOST:=127.0.0.1}"
: "${MYSQL_PORT:=3306}"
: "${MYSQL_USER:=signal}"
: "${MYSQL_PASSWORD:?MYSQL_PASSWORD 必填}"
: "${BACKUP_ENCRYPTION_KEY:?BACKUP_ENCRYPTION_KEY 必填}"
: "${R2_REMOTE:?R2_REMOTE 必填}"

mkdir -p "$BACKUP_DIR/binlog"

# 已经拉过的就不再拉（文件名即 binlog 名，稳定且唯一）
mysqlbinlog \
  --read-from-remote-server \
  --host="$MYSQL_HOST" --port="$MYSQL_PORT" \
  --user="$MYSQL_USER" --password="$MYSQL_PASSWORD" \
  --raw --stop-never --result-file="$BACKUP_DIR/binlog/" \
  --connection-server-id=99 &
PID=$!
# 让它跑一小会再收工：`--stop-never` 是流式的，cron 里不该常驻。
sleep 20
kill "$PID" 2>/dev/null || true
wait "$PID" 2>/dev/null || true

for file in "$BACKUP_DIR/binlog"/mysql-bin.*; do
  [ -e "$file" ] || continue
  case "$file" in *.enc) continue ;; esac
  openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt \
    -pass env:BACKUP_ENCRYPTION_KEY -in "$file" -out "$file.enc"
  rclone copy "$file.enc" "$R2_REMOTE/binlog/"
  rm -f "$file" "$file.enc"
done

echo "binlog sync ok"
