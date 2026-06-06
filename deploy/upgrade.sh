#!/usr/bin/env bash
set -euo pipefail

# Wood Fired Tasks - In-Place Application Upgrade
#
# Refreshes the deployed app artefacts at $WFT_INSTALL_DIR with the contents
# of the current source tree's dist/. Runs DB migrations. Restarts the
# systemd service. Polls /health. Prints an exact manual-rollback recipe if
# the health probe fails.
#
# Run as root or with sudo (the script re-execs with sudo if invoked
# unprivileged). Sudo is needed for systemctl stop|start and to write into
# $WFT_INSTALL_DIR when it is owned by the service user.
#
# Prerequisites:
#   - deploy/install.sh has already run on this host (service user exists,
#     $WFT_INSTALL_DIR exists, systemd unit installed)
#   - The source tree has been built (npm ci && npm run build) so dist/ is
#     present and newer than src/
#   - Node.js available on PATH (or set $WFT_NODE_BIN to an absolute path).
#     The script uses whichever node the invoking shell resolves so the
#     better-sqlite3 native binding ABI matches the systemd service.
#
# What this script does (in order, every step has a backup or pre-flight
# guard so the operator can recover from any failure point):
#   1. Pre-flight: refuse to run if ./dist/ is missing or older than ./src/
#   2. Back up data/tasks.db + .db-wal + .db-shm to
#      $WFT_INSTALL_DIR/backups/pre-deploy-<UTC>.db[*]
#   3. Back up the live dist/ to
#      $WFT_INSTALL_DIR/backups/dist-pre-deploy-<UTC>/
#   4. Stop the systemd service
#   5. Replace $WFT_INSTALL_DIR/dist with a clean copy of ./dist
#   6. Copy package.json + package-lock.json
#   7. npm ci --omit=dev in the install dir
#   8. node dist/db/migrate.js (NOT npm run migrate -- tsx is dev-only)
#   9. Start the service
#  10. Poll http://localhost:$PORT/health for up to 30 seconds
#  11. On failure: print exact rollback commands; exit non-zero. There is
#      no automatic rollback in v1 -- migrations make it risky.
#
# Configurable env vars:
#   WFT_INSTALL_DIR   Install path     (default: /opt/wood-fired-tasks)
#   WFT_SERVICE_NAME  systemd unit     (default: wood-fired-tasks)
#   WFT_NODE_BIN      Absolute node path; overrides PATH lookup and the
#                     systemd ExecStart fallback. Use only when neither
#                     `command -v node` nor `systemctl cat` resolves the
#                     right node (e.g. unusual nvm setups before the
#                     systemd unit is installed).

INSTALL_DIR="${WFT_INSTALL_DIR:-/opt/wood-fired-tasks}"
SERVICE_NAME="${WFT_SERVICE_NAME:-wood-fired-tasks}"
SOURCE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TS="$(date -u +%Y%m%dT%H%M%SZ)"

# --- Node binary discovery -------------------------------------------------
# The migrate step and npm ci must run under the same Node version the
# systemd service uses, or the better-sqlite3 native binding ABI mismatches
# and the service fails to boot. Priority:
#   1. $WFT_NODE_BIN (operator override).
#   2. `command -v node` from the invoking shell's PATH (the usual case --
#      sudo's PATH reset is handled by exporting WFT_NODE_BIN below before
#      the re-exec).
#   3. ExecStart= line of the installed systemd unit (only useful for in-
#      place upgrades where install.sh has already run).
NODE_BIN="${WFT_NODE_BIN:-$(command -v node 2>/dev/null || true)}"
if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
  NODE_BIN="$(systemctl cat "$SERVICE_NAME" 2>/dev/null \
    | awk -F= '/^ExecStart=/{split($2,a," "); print a[1]; exit}' || true)"
fi
if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
  echo "ERROR: no usable node binary found." >&2
  echo "Either install node so it's on PATH, or set WFT_NODE_BIN=/path/to/node." >&2
  exit 1
fi
export WFT_NODE_BIN="$NODE_BIN"
NODE_DIR="$(dirname "$NODE_BIN")"

# Re-exec under sudo if not root. Preserves env vars so WFT_* survive.
# WFT_NODE_BIN is preserved so the post-sudo run uses the same node the
# pre-sudo PATH lookup resolved (sudo strips PATH by default).
#
# WFT_SKIP_SUDO_REEXEC=1 suppresses the re-exec so the pre-flight checks below
# can be exercised unprivileged (used by deploy/__tests__/upgrade.test.ts to
# avoid blocking on sudo's TTY password prompt). It never grants privilege --
# with the re-exec skipped the script just runs as the calling user and fails
# at the first operation that genuinely needs root.
if [ "$(id -u)" -ne 0 ] && [ "${WFT_SKIP_SUDO_REEXEC:-}" != "1" ]; then
  exec sudo --preserve-env=WFT_INSTALL_DIR,WFT_SERVICE_NAME,WFT_NODE_BIN "$0" "$@"
fi

echo "=== Wood Fired Tasks Upgrade ==="
echo "Source dir  : $SOURCE_DIR"
echo "Install dir : $INSTALL_DIR"
echo "Service     : $SERVICE_NAME"
echo "Timestamp   : $TS"
echo ""

# --- Pre-flight: dist must exist and be newer than src ---------------------
if [ ! -d "$SOURCE_DIR/dist" ]; then
  echo "ERROR: $SOURCE_DIR/dist is missing." >&2
  echo "Run 'npm run build' before deploying." >&2
  exit 1
fi

if [ ! -d "$SOURCE_DIR/src" ]; then
  echo "ERROR: $SOURCE_DIR/src is missing -- is this the project root?" >&2
  exit 1
fi

# Compare against the newest FILE inside dist/, not the dist/ directory's
# mtime. tsc rewrites existing .js files in place; that doesn't bump the
# directory mtime, so a `find -newer dist/` check would falsely flag any
# src/ file touched since the dist/ was first populated even when the
# corresponding .js was just rebuilt.
NEWEST_DIST="$(find "$SOURCE_DIR/dist" -type f -printf '%T@ %p\n' 2>/dev/null \
  | sort -nr | awk 'NR==1{print $2}' || true)"
if [ -z "$NEWEST_DIST" ]; then
  echo "ERROR: $SOURCE_DIR/dist exists but is empty." >&2
  echo "Run 'npm run build' before deploying." >&2
  exit 1
fi
STALE="$(find "$SOURCE_DIR/src" -type f -newer "$NEWEST_DIST" -print -quit 2>/dev/null || true)"
if [ -n "$STALE" ]; then
  echo "ERROR: dist/ is older than src/ (e.g. $STALE)." >&2
  echo "Run 'npm run build' before deploying." >&2
  exit 1
fi

if [ ! -d "$INSTALL_DIR" ]; then
  echo "ERROR: $INSTALL_DIR does not exist." >&2
  echo "Run 'sudo ./deploy/install.sh' first to provision the host." >&2
  exit 1
fi

# Determine port from the installed .env so the health probe targets the
# right interface. Falls back to 3000 (the documented default).
PORT="3000"
if [ -f "$INSTALL_DIR/.env" ]; then
  ENV_PORT="$(grep -E '^PORT=' "$INSTALL_DIR/.env" | tail -n1 | cut -d= -f2- | tr -d '"' || true)"
  if [ -n "$ENV_PORT" ]; then
    PORT="$ENV_PORT"
  fi
fi
echo "Health port : $PORT"
echo ""

# --- Backups (BEFORE any destructive operation) ----------------------------
mkdir -p "$INSTALL_DIR/backups"

echo "[1/8] Backing up database..."
if [ -f "$INSTALL_DIR/data/tasks.db" ]; then
  cp "$INSTALL_DIR/data/tasks.db" "$INSTALL_DIR/backups/pre-deploy-${TS}.db"
  echo "      -> backups/pre-deploy-${TS}.db"
else
  echo "      (no tasks.db present -- skipping)"
fi
if [ -f "$INSTALL_DIR/data/tasks.db-wal" ]; then
  cp "$INSTALL_DIR/data/tasks.db-wal" "$INSTALL_DIR/backups/pre-deploy-${TS}.db-wal"
  echo "      -> backups/pre-deploy-${TS}.db-wal"
fi
if [ -f "$INSTALL_DIR/data/tasks.db-shm" ]; then
  cp "$INSTALL_DIR/data/tasks.db-shm" "$INSTALL_DIR/backups/pre-deploy-${TS}.db-shm"
  echo "      -> backups/pre-deploy-${TS}.db-shm"
fi

echo "[2/8] Backing up existing dist/..."
if [ -d "$INSTALL_DIR/dist" ]; then
  cp -a "$INSTALL_DIR/dist" "$INSTALL_DIR/backups/dist-pre-deploy-${TS}"
  echo "      -> backups/dist-pre-deploy-${TS}/"
else
  echo "      (no dist/ present -- skipping)"
fi

# --- Stop the service ------------------------------------------------------
echo "[3/8] Stopping ${SERVICE_NAME}..."
systemctl stop "$SERVICE_NAME"
# systemctl stop blocks until the unit reaches inactive (TimeoutStopSec
# enforces an upper bound), so an extra busy-wait would be redundant.

# --- Replace dist/ ---------------------------------------------------------
echo "[4/8] Replacing $INSTALL_DIR/dist..."
rm -rf "$INSTALL_DIR/dist"
mkdir -p "$INSTALL_DIR/dist"
cp -a "$SOURCE_DIR/dist/." "$INSTALL_DIR/dist/"

# --- Copy package files ----------------------------------------------------
echo "[5/8] Copying package.json + package-lock.json + scripts/..."
cp "$SOURCE_DIR/package.json" "$INSTALL_DIR/"
if [ -f "$SOURCE_DIR/package-lock.json" ]; then
  cp "$SOURCE_DIR/package-lock.json" "$INSTALL_DIR/"
fi
# package.json's `postinstall` lifecycle hook runs `node scripts/postinstall.cjs`
# during the `npm ci` below. Without scripts/ in the install dir, npm ci aborts
# with MODULE_NOT_FOUND and the deploy fails AFTER the service is already
# stopped (regression introduced by the 1.18 postinstall notice, #752). Refresh
# scripts/ from source so every install-time lifecycle hook resolves. Dev-only
# scripts come along but are inert (only postinstall.cjs runs under npm ci).
rm -rf "$INSTALL_DIR/scripts"
cp -a "$SOURCE_DIR/scripts" "$INSTALL_DIR/"

# --- Install production dependencies ---------------------------------------
# Prepend the node binary's directory to PATH so the npm bundled with this
# node is the one that runs (and better-sqlite3 gets compiled against the
# matching ABI). Sudo's reset PATH otherwise leaves us with /usr/bin/npm
# which may be a different Node version.
echo "[6/8] Installing production dependencies (npm ci --omit=dev)..."
(cd "$INSTALL_DIR" && PATH="$NODE_DIR:$PATH" npm ci --omit=dev)

# --- Re-chown so the service user owns the new files -----------------------
# install.sh has already established the service user. Re-derive it from the
# data/ directory's owner so this script does not need to be told.
SERVICE_USER="$(stat -c '%U' "$INSTALL_DIR/data" 2>/dev/null || echo root)"
SERVICE_GROUP="$(stat -c '%G' "$INSTALL_DIR/data" 2>/dev/null || echo root)"
chown -R "${SERVICE_USER}:${SERVICE_GROUP}" "$INSTALL_DIR/dist" "$INSTALL_DIR/node_modules" "$INSTALL_DIR/scripts" "$INSTALL_DIR/package.json" "$INSTALL_DIR/package-lock.json" 2>/dev/null || true

# --- Run migrations --------------------------------------------------------
# Use the resolved $NODE_BIN (not the system /usr/bin/node, which may be a
# different major version). Mismatched node here would crash on first
# `require('better-sqlite3')` with NODE_MODULE_VERSION.
echo "[7/8] Running database migrations..."
(cd "$INSTALL_DIR" && "$NODE_BIN" dist/db/migrate.js)

# --- Start + health-check --------------------------------------------------
echo "[8/8] Starting ${SERVICE_NAME} and polling health..."
systemctl start "$SERVICE_NAME"

HEALTH_URL="http://localhost:${PORT}/health"
HEALTHY=0
for _ in $(seq 1 30); do
  if curl -sf -m 1 "$HEALTH_URL" >/dev/null 2>&1; then
    HEALTHY=1
    break
  fi
  sleep 1
done

if [ "$HEALTHY" -ne 1 ]; then
  echo ""
  echo "ERROR: Health check failed after 30s against ${HEALTH_URL}." >&2
  echo ""
  echo "[ROLLBACK] To restore the previous deployment, run:" >&2
  echo "  sudo systemctl stop ${SERVICE_NAME}" >&2
  echo "  sudo rm -rf ${INSTALL_DIR}/dist" >&2
  echo "  sudo cp -a ${INSTALL_DIR}/backups/dist-pre-deploy-${TS} ${INSTALL_DIR}/dist" >&2
  echo "  sudo cp ${INSTALL_DIR}/backups/pre-deploy-${TS}.db ${INSTALL_DIR}/data/tasks.db" >&2
  echo "  [ -f ${INSTALL_DIR}/backups/pre-deploy-${TS}.db-wal ] && sudo cp ${INSTALL_DIR}/backups/pre-deploy-${TS}.db-wal ${INSTALL_DIR}/data/tasks.db-wal" >&2
  echo "  [ -f ${INSTALL_DIR}/backups/pre-deploy-${TS}.db-shm ] && sudo cp ${INSTALL_DIR}/backups/pre-deploy-${TS}.db-shm ${INSTALL_DIR}/data/tasks.db-shm" >&2
  echo "  sudo systemctl start ${SERVICE_NAME}" >&2
  echo "" >&2
  echo "Then inspect 'sudo journalctl -u ${SERVICE_NAME} -n 200' to diagnose the failure." >&2
  exit 1
fi

echo ""
echo "=== Upgrade Complete ==="
echo "Service     : ${SERVICE_NAME} (running)"
echo "Health URL  : ${HEALTH_URL} (200 OK)"
echo "DB backup   : ${INSTALL_DIR}/backups/pre-deploy-${TS}.db*"
echo "dist backup : ${INSTALL_DIR}/backups/dist-pre-deploy-${TS}/"
echo ""
echo "Backups are kept indefinitely -- prune ${INSTALL_DIR}/backups/ manually when no longer needed."
