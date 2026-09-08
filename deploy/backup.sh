#!/usr/bin/env bash
# Edge Todo SQLite 备份脚本：每日执行，保留 14 天
# 安装：chmod +x backup.sh && crontab -e 加入：
#   0 3 * * * DB_PATH=/var/lib/edgetodo/edgetodo.db /opt/edgetodo/backup.sh >> /var/log/edgetodo-backup.log 2>&1
set -euo pipefail

DB_PATH="${DB_PATH:-/var/lib/edgetodo/edgetodo.db}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/edgetodo}"
KEEP_DAYS="${KEEP_DAYS:-14}"

mkdir -p "$BACKUP_DIR"
TS="$(date +%Y%m%d-%H%M%S)"
RAW="$BACKUP_DIR/edgetodo-$TS.db"

# sqlite3 .backup 是在线备份 API，WAL 模式下读写不中断，无需停服
sqlite3 "$DB_PATH" ".backup '$RAW'"
gzip "$RAW"

# 清理过期备份
find "$BACKUP_DIR" -name 'edgetodo-*.db.gz' -mtime "+$KEEP_DAYS" -delete

echo "backup done: $RAW.gz"
