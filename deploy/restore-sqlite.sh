#!/usr/bin/env bash
set -euo pipefail

# Wood Fired Tasks - SQLite Database Restore
# Restores a gzipped backup to the database path
#
# Usage: ./restore-sqlite.sh <backup_file.db.gz> [db_path]
# Default db_path: ${WFT_INSTALL_DIR}/data/tasks.db (default install dir: /opt/wood-fired-tasks)
#
# Configurable env vars (see deploy/README.md):
#   WFT_INSTALL_DIR   Install path  (default: /opt/wood-fired-tasks)
#   WFT_SERVICE_USER  Service user  (default: wood-fired-tasks)
#
# IMPORTANT: Stop the service before restoring!
#   sudo systemctl stop wood-fired-tasks
#   ./restore-sqlite.sh backups/tasks-2026-02-13_020000.db.gz
#   sudo systemctl start wood-fired-tasks

INSTALL_DIR="${WFT_INSTALL_DIR:-/opt/wood-fired-tasks}"
SERVICE_USER="${WFT_SERVICE_USER:-wood-fired-tasks}"

if [ $# -lt 1 ]; then
  echo "Usage: $0 <backup_file.db.gz> [db_path]" >&2
  echo "" >&2
  echo "Available backups:" >&2
  ls -lh "${INSTALL_DIR}"/backups/tasks-*.db.gz 2>/dev/null || echo "  (none found in default location)" >&2
  exit 1
fi

BACKUP_FILE="$1"
DB_PATH="${2:-${INSTALL_DIR}/data/tasks.db}"
DB_DIR=$(dirname "$DB_PATH")

# Validate backup file exists
if [ ! -f "$BACKUP_FILE" ]; then
  echo "ERROR: Backup file not found: $BACKUP_FILE" >&2
  exit 1
fi

# Check if service is running (warn but don't block)
if systemctl is-active --quiet wood-fired-tasks 2>/dev/null; then
  echo "WARNING: wood-fired-tasks service is still running!" >&2
  echo "Stop it first: sudo systemctl stop wood-fired-tasks" >&2
  exit 1
fi

# Create temp file for decompressed backup
TEMP_DB=$(mktemp "${DB_DIR}/restore-XXXXXX.db")
# shellcheck disable=SC2064  # intentional: expand $TEMP_DB now so trap fires with the right path
trap "rm -f '$TEMP_DB'" EXIT

echo "Decompressing backup: $BACKUP_FILE"
gunzip -c "$BACKUP_FILE" > "$TEMP_DB"

# Verify integrity of decompressed backup
INTEGRITY=$(sqlite3 "$TEMP_DB" "PRAGMA integrity_check;")
if [ "$INTEGRITY" != "ok" ]; then
  echo "ERROR: Backup integrity check failed: $INTEGRITY" >&2
  exit 1
fi

# Create safety backup of current database before overwriting
if [ -f "$DB_PATH" ]; then
  SAFETY_BACKUP="${DB_PATH}.pre-restore"
  echo "Creating safety backup: $SAFETY_BACKUP"
  cp "$DB_PATH" "$SAFETY_BACKUP"
  # Also copy WAL and SHM files if they exist
  cp "${DB_PATH}-wal" "${SAFETY_BACKUP}-wal" 2>/dev/null || true
  cp "${DB_PATH}-shm" "${SAFETY_BACKUP}-shm" 2>/dev/null || true
fi

# Replace database (remove WAL/SHM files -- they belong to the old database)
echo "Restoring database to: $DB_PATH"
mv "$TEMP_DB" "$DB_PATH"
rm -f "${DB_PATH}-wal" "${DB_PATH}-shm"

# Set ownership (if we can detect the service user)
if id "$SERVICE_USER" &>/dev/null; then
  chown "$SERVICE_USER:$SERVICE_USER" "$DB_PATH"
fi

echo "Restore complete. Start the service:"
echo "  sudo systemctl start wood-fired-tasks"
