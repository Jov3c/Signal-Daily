#!/usr/bin/env bash
# MySQL 每日全量备份 + binlog 位置 + 加密 + 上传 R2 —— docs/16
#
# ```text
# RPO <= 15min = 每日全量（本脚本） + binlog 补齐（03:00 之后每 15 分钟同步 binlog）
# 保留：7 daily / 4 weekly / 6 monthly
# ```
#
# cron（宿主机）：
#   0 3 * * *  /opt/signal/scripts/ops/backup-mysql.sh >> /var/log/signal-backup.log 2>&1
#   */15 * * * * /opt/signal/scripts/ops/sync-binlog.sh >> /var/log/signal-backup.log 2>&1
#
# ⚠ 依赖：mysqldump / openssl / rclone。缺任何一个就**立刻失败**，
# 不要降级成「备份了但没加密」或「加密了但没上传」——
# 那种备份在真正需要恢复的那天才知道没用。
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/var/backups/signal}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
KEEP_DAILY=7
KEEP_WEEKLY=4
KEEP_MONTHLY=6

: "${MYSQL_HOST:=127.0.0.1}"
: "${MYSQL_PORT:=3306}"
: "${MYSQL_DATABASE:=signal}"
: "${MYSQL_USER:=signal}"
: "${MYSQL_PASSWORD:?MYSQL_PASSWORD 必填}"
: "${BACKUP_ENCRYPTION_KEY:?BACKUP_ENCRYPTION_KEY 必填（docs/16：备份加密后上传）}"
: "${R2_REMOTE:?R2_REMOTE 必填，例如 r2:signal-backups}"

for bin in mysqldump openssl rclone; do
  command -v "$bin" >/dev/null 2>&1 || { echo "缺少 $bin" >&2; exit 1; }
done

mkdir -p "$BACKUP_DIR/daily" "$BACKUP_DIR/binlog"

DUMP="$BACKUP_DIR/daily/signal-$STAMP.sql"

# ⚠ `--single-transaction`：不锁表（InnoDB 一致性快照）。
# `--master-data=2` 会把 binlog 位置**写成注释**塞进 dump ——
# 恢复时先灌 dump、再从那个位置 replay binlog，这就是 RPO<=15min 的实现。
# （MySQL 8.4 用 `--source-data=2`，旧名仍兼容。）
mysqldump \
  --host="$MYSQL_HOST" --port="$MYSQL_PORT" \
  --user="$MYSQL_USER" --password="$MYSQL_PASSWORD" \
  --single-transaction --routines --triggers --events \
  --source-data=2 \
  --set-gtid-purged=OFF \
  --default-character-set=utf8mb4 \
  "$MYSQL_DATABASE" > "$DUMP"

# 记一份独立的 binlog 位置（不依赖 dump 里的注释 —— 恢复脚本两个都看）
mysql --host="$MYSQL_HOST" --port="$MYSQL_PORT" \
      --user="$MYSQL_USER" --password="$MYSQL_PASSWORD" \
      -e 'SHOW MASTER STATUS\G' > "$DUMP.master-status" || \
mysql --host="$MYSQL_HOST" --port="$MYSQL_PORT" \
      --user="$MYSQL_USER" --password="$MYSQL_PASSWORD" \
      -e 'SHOW BINARY LOG STATUS\G' > "$DUMP.master-status"

gzip -9 "$DUMP"
# ⚠ 加密在**压缩之后**：先压缩再加密，密文不可压缩
openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt \
  -pass env:BACKUP_ENCRYPTION_KEY \
  -in "$DUMP.gz" -out "$DUMP.gz.enc"
rm -f "$DUMP.gz"

rclone copy "$DUMP.gz.enc" "$R2_REMOTE/daily/" --s3-no-check-bucket
rclone copy "$DUMP.master-status" "$R2_REMOTE/daily/"

# ── 保留策略：7 daily / 4 weekly / 6 monthly ──────────────────────────
# weekly：周日的那份复制到 weekly/；monthly：每月 1 号的那份复制到 monthly/。
DOW="$(date -u +%u)"
DOM="$(date -u +%d)"
if [ "$DOW" = "7" ]; then rclone copy "$DUMP.gz.enc" "$R2_REMOTE/weekly/"; fi
if [ "$DOM" = "01" ]; then rclone copy "$DUMP.gz.enc" "$R2_REMOTE/monthly/"; fi

prune() {
  local dir="$1" keep="$2"
  # shellcheck disable=SC2012
  ls -1t "$dir"/signal-*.sql.gz.enc 2>/dev/null | tail -n "+$((keep + 1))" | while read -r old; do
    rm -f "$old" "$old.master-status"
  done
}
prune "$BACKUP_DIR/daily" "$KEEP_DAILY"

# 远端也按同样规则裁（rclone 的 --min-age 不够精确，用列表 + delete）
rclone lsf "$R2_REMOTE/daily/" | sort -r | tail -n "+$((KEEP_DAILY + 1))" | while read -r old; do
  rclone deletefile "$R2_REMOTE/daily/$old"
done
rclone lsf "$R2_REMOTE/weekly/" | sort -r | tail -n "+$((KEEP_WEEKLY + 1))" | while read -r old; do
  rclone deletefile "$R2_REMOTE/weekly/$old"
done
rclone lsf "$R2_REMOTE/monthly/" | sort -r | tail -n "+$((KEEP_MONTHLY + 1))" | while read -r old; do
  rclone deletefile "$R2_REMOTE/monthly/$old"
done

echo "backup ok: $DUMP.gz.enc (binlog 位置见 $DUMP.master-status)"
