#!/usr/bin/env bash
set -euo pipefail

# Wood Fired Bugs - SQLite Database Backup
# Uses sqlite3 .backup command (transaction-safe, handles WAL mode correctly)
# Do NOT use file copy (cp) -- risks corruption in WAL mode (see research pitfall #2)
#
# Usage: ./backup-sqlite.sh [db_path] [backup_dir]
# Defaults: ${WFB_INSTALL_DIR}/data/tasks.db -> ${WFB_INSTALL_DIR}/backups/
#
# Configurable env vars (see deploy/README.md):
#   WFB_INSTALL_DIR   Install path  (default: /opt/wood-fired-bugs)

INSTALL_DIR="${WFB_INSTALL_DIR:-/opt/wood-fired-bugs}"
DB_PATH="${1:-${INSTALL_DIR}/data/tasks.db}"
BACKUP_DIR="${2:-${INSTALL_DIR}/backups}"
RETENTION_DAYS=30
TIMESTAMP=$(date +%Y-%m-%d_%H%M%S)
BACKUP_FILE="${BACKUP_DIR}/tasks-${TIMESTAMP}.db"

# Validate source database exists
if [ ! -f "$DB_PATH" ]; then
  echo "ERROR: Database not found at $DB_PATH" >&2
  exit 1
fi

# Ensure backup directory exists
mkdir -p "$BACKUP_DIR"

echo "Starting backup: $DB_PATH -> $BACKUP_FILE"

# Create backup using sqlite3 .backup command
# This uses the SQLite Online Backup API -- transaction-safe, handles WAL mode
sqlite3 "$DB_PATH" ".backup '$BACKUP_FILE'"

# Verify backup integrity before compressing
INTEGRITY=$(sqlite3 "$BACKUP_FILE" "PRAGMA integrity_check;")
if [ "$INTEGRITY" != "ok" ]; then
  echo "ERROR: Backup integrity check failed: $INTEGRITY" >&2
  rm -f "$BACKUP_FILE"
  exit 1
fi

# Compress backup (SQLite databases compress well -- typically 60-70% reduction)
gzip "$BACKUP_FILE"

# Report success with file size
BACKUP_SIZE=$(du -h "${BACKUP_FILE}.gz" | cut -f1)
echo "Backup complete: ${BACKUP_FILE}.gz ($BACKUP_SIZE)"

# Delete backups older than retention period
DELETED=$(find "$BACKUP_DIR" -name "tasks-*.db.gz" -mtime +${RETENTION_DAYS} -delete -print | wc -l)
if [ "$DELETED" -gt 0 ]; then
  echo "Cleaned up $DELETED backup(s) older than $RETENTION_DAYS days"
fi
