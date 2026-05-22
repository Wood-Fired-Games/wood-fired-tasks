#!/usr/bin/env bash
set -euo pipefail

# Wood Fired Bugs - Linux/macOS Installer
# Installs Claude Code skills and MCP server configuration

# ============================================================================
# Constants
# ============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="$HOME/.claude.json"
SKILLS_SOURCE="$SCRIPT_DIR/skills/tasks"
SKILLS_DEST="$HOME/.claude/commands/tasks"
SERVICE_URL="${WOOD_FIRED_BUGS_URL:-http://localhost:3000}"

# Per-user secret file for the API key. Strict 0600 permissions.
SECRET_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/wood-fired-bugs"
SECRET_FILE="$SECRET_DIR/api-key"

# chmod helper — silent if file is missing so we never block install on it.
secure_file() {
  local target="$1"
  if [ -f "$target" ]; then
    chmod 600 "$target" 2>/dev/null || true
  fi
}

# ============================================================================
# Cleanup and rollback handler
# ============================================================================

BACKUP_FILE=""
TEMP_FILES=()

cleanup() {
  local exit_code=$?

  # Clean up temporary files.
  # Guard the expansion with "${VAR[@]+...}" so an empty array does not
  # trip `set -u` on bash 3.2 (macOS default).
  for temp_file in ${TEMP_FILES[@]+"${TEMP_FILES[@]}"}; do
    if [ -f "$temp_file" ]; then
      rm -f "$temp_file"
    fi
  done

  # Rollback on failure
  if [ $exit_code -ne 0 ]; then
    echo "[ERROR] Installation failed"
    if [ -n "$BACKUP_FILE" ] && [ -f "$BACKUP_FILE" ]; then
      echo "[INFO] Restoring configuration from backup..."
      cp "$BACKUP_FILE" "$CONFIG_FILE"
      echo "[INFO] Configuration restored from $BACKUP_FILE"
    fi
  fi
}

trap cleanup EXIT

# ============================================================================
# Step 1: Check prerequisites
# ============================================================================

echo "[INFO] Checking prerequisites..."

# Check for jq
if ! command -v jq &> /dev/null; then
  echo "[ERROR] jq is required but not installed"
  echo ""
  echo "Install jq using your package manager:"
  echo "  Debian/Ubuntu:  sudo apt-get install jq"
  echo "  RHEL/CentOS:    sudo yum install jq"
  echo "  Fedora:         sudo dnf install jq"
  echo "  macOS:          brew install jq"
  echo ""
  exit 1
fi

# Check for curl
if ! command -v curl &> /dev/null; then
  echo "[ERROR] curl is required but not installed"
  echo ""
  echo "Install curl using your package manager:"
  echo "  Debian/Ubuntu:  sudo apt-get install curl"
  echo "  RHEL/CentOS:    sudo yum install curl"
  echo "  Fedora:         sudo dnf install curl"
  echo "  macOS:          brew install curl"
  echo ""
  exit 1
fi

# Verify skills source directory exists
if [ ! -d "$SKILLS_SOURCE" ]; then
  echo "[ERROR] Skills directory not found at $SKILLS_SOURCE"
  echo "[INFO] Make sure you are running this script from the wood-fired-bugs project directory"
  exit 1
fi

# Count skill files
SKILL_COUNT=$(find "$SKILLS_SOURCE" -maxdepth 1 -name "*.md" -type f | wc -l)
if [ "$SKILL_COUNT" -eq 0 ]; then
  echo "[ERROR] No skill files (.md) found in $SKILLS_SOURCE"
  exit 1
fi

echo "[OK] Found $SKILL_COUNT skill files"

# ============================================================================
# Step 2: Parse flags, resolve mode, optionally collect API key
# ============================================================================

# Install mode: 'local' (default) writes a stdio MCP server entry that opens
# the SQLite database directly and needs only DATABASE_PATH. 'remote' writes
# an MCP entry that talks to a deployed REST API and needs WFB_API_URL +
# WFB_API_KEY. Local mode does NOT touch the API key at all (no prompt, no
# argv flag, no env-var read, no secret-file write).
MODE="local"
API_KEY=""
API_KEY_FROM_ARGV=0

# Parse command line flags.
# --api-key is DEPRECATED — secrets on argv leak via shell history and `ps`.
# Prefer WOOD_FIRED_BUGS_API_KEY, the per-user secret file, or the interactive prompt.
while [[ $# -gt 0 ]]; do
  case $1 in
    --mode)
      MODE="$2"
      shift 2
      ;;
    --api-key)
      API_KEY="$2"
      API_KEY_FROM_ARGV=1
      shift 2
      ;;
    -h|--help)
      cat <<EOF
Usage: $0 [--mode local|remote] [--api-key KEY]

Modes:
  local  (default) Write an MCP entry that opens the SQLite database in-process.
                   Needs only DATABASE_PATH. No API key is collected, stored, or
                   written to ~/.claude.json — local MCP does not use one.
  remote           Write an MCP entry that proxies calls to a deployed REST API.
                   Requires an API key (WFB_API_KEY) and WFB_API_URL.

API key resolution order in --mode remote (most secure first):
  1. WOOD_FIRED_BUGS_API_KEY environment variable
  2. Secret file at \$XDG_CONFIG_HOME/wood-fired-bugs/api-key (default ~/.config/wood-fired-bugs/api-key)
  3. Masked interactive prompt
  4. --api-key KEY argument (DEPRECATED — leaks via shell history and process listings)
EOF
      exit 0
      ;;
    *)
      echo "[ERROR] Unknown option: $1"
      echo "Run '$0 --help' for usage."
      exit 1
      ;;
  esac
done

# Validate --mode value
case "$MODE" in
  local|remote) ;;
  *)
    echo "[ERROR] Invalid --mode: '$MODE' (expected 'local' or 'remote')"
    exit 1
    ;;
esac

echo "[INFO] Install mode: $MODE"

if [ "$MODE" = "local" ]; then
  # Local mode: silently ignore any API-key inputs. The local MCP server reads
  # DATABASE_PATH and never reads WFB_API_KEY / WOOD_FIRED_BUGS_API_KEY, so
  # keeping a key in ~/.claude.json would be dead weight (and a leak surface).
  if [ "$API_KEY_FROM_ARGV" -eq 1 ] || [ -n "${WOOD_FIRED_BUGS_API_KEY:-}" ]; then
    echo "[INFO] Ignoring API key input — local mode does not use one."
  fi
  API_KEY=""
else
  # Remote mode: same resolution order as before.
  if [ "$API_KEY_FROM_ARGV" -eq 1 ]; then
    echo "[WARN] --api-key on the command line is DEPRECATED."
    echo "[WARN] Command-line secrets leak via shell history and 'ps -ef'."
    echo "[WARN] Prefer WOOD_FIRED_BUGS_API_KEY env var, the secret file ($SECRET_FILE),"
    echo "[WARN] or the interactive prompt. This flag will be removed in a future release."
  fi

  # Check for API key from environment variable
  if [ -z "$API_KEY" ] && [ -n "${WOOD_FIRED_BUGS_API_KEY:-}" ]; then
    API_KEY="$WOOD_FIRED_BUGS_API_KEY"
    echo "[INFO] Using API key from WOOD_FIRED_BUGS_API_KEY environment variable"
  fi

  # Check for API key from per-user secret file
  if [ -z "$API_KEY" ] && [ -r "$SECRET_FILE" ]; then
    # Refuse to use the secret file if it is group/world readable.
    if [ "$(stat -c '%a' "$SECRET_FILE" 2>/dev/null || stat -f '%Lp' "$SECRET_FILE" 2>/dev/null)" = "600" ]; then
      API_KEY="$(tr -d '\r\n' < "$SECRET_FILE")"
      if [ -n "$API_KEY" ]; then
        echo "[INFO] Using API key from $SECRET_FILE"
      fi
    else
      echo "[WARN] Secret file $SECRET_FILE has loose permissions; ignoring."
      echo "[WARN] Run: chmod 600 \"$SECRET_FILE\" to fix."
    fi
  fi

  # Prompt for API key if still not provided
  if [ -z "$API_KEY" ]; then
    echo ""
    read -rsp "Enter Wood Fired Bugs API key: " API_KEY
    echo ""
  fi

  # Validate API key is non-empty
  if [ -z "$API_KEY" ]; then
    echo "[ERROR] API key is required in --mode remote"
    exit 1
  fi

  # Persist the API key to the per-user secret file with strict permissions
  # so subsequent runs (and any deprecation removal) keep working without argv.
  if [ ! -d "$SECRET_DIR" ]; then
    mkdir -p "$SECRET_DIR"
    chmod 700 "$SECRET_DIR" 2>/dev/null || true
  fi
  # Create the file with 0600 perms before writing the secret so a brief
  # world-readable window never exists.
  ( umask 077 && : > "$SECRET_FILE" )
  chmod 600 "$SECRET_FILE" 2>/dev/null || true
  printf '%s\n' "$API_KEY" > "$SECRET_FILE"
  chmod 600 "$SECRET_FILE" 2>/dev/null || true

  # Show masked key confirmation
  MASKED_KEY="${API_KEY:0:4}$(printf '*%.0s' {1..20})"
  echo "[OK] API key set: $MASKED_KEY"
  echo "[OK] API key cached at $SECRET_FILE (mode 600)"
fi

# ============================================================================
# Step 3: Copy skill files (LINX-01)
# ============================================================================

echo "[INFO] Installing skill files..."

# Create destination directory
mkdir -p "$SKILLS_DEST"

# Copy all .md files
COPIED_COUNT=0
for skill_file in "$SKILLS_SOURCE"/*.md; do
  if [ -f "$skill_file" ]; then
    cp -a "$skill_file" "$SKILLS_DEST/"
    COPIED_COUNT=$((COPIED_COUNT + 1))
  fi
done

echo "[OK] Copied $COPIED_COUNT skill files to $SKILLS_DEST"

# ============================================================================
# Step 4: Backup existing config (LINX-04)
# ============================================================================

echo "[INFO] Backing up configuration..."

# Create config file if it doesn't exist
if [ ! -f "$CONFIG_FILE" ]; then
  echo "[INFO] Creating new configuration file at $CONFIG_FILE"
  ( umask 077 && : > "$CONFIG_FILE" )
  echo '{}' > "$CONFIG_FILE"
  secure_file "$CONFIG_FILE"
else
  # Create timestamped backup with strict perms (0600) — backups contain the API key.
  TIMESTAMP=$(date +%Y%m%d_%H%M%S)
  BACKUP_FILE="${CONFIG_FILE}.backup.${TIMESTAMP}"
  ( umask 077 && cp "$CONFIG_FILE" "$BACKUP_FILE" )
  secure_file "$BACKUP_FILE"
  # Re-tighten the config itself in case a previous installer or hand-edit relaxed it.
  secure_file "$CONFIG_FILE"
  echo "[OK] Backed up existing configuration to $BACKUP_FILE (mode 600)"
fi

# ============================================================================
# Step 5: Merge MCP server config (LINX-02, LINX-03, LINX-05)
# ============================================================================

echo "[INFO] Configuring MCP server..."

# Create temporary file for new server config with strict perms. Even in
# local mode the merged config may contain pre-existing secrets, so keep 600.
NEW_SERVER_CONFIG=$(mktemp)
chmod 600 "$NEW_SERVER_CONFIG" 2>/dev/null || true
TEMP_FILES+=("$NEW_SERVER_CONFIG")

# Build MCP server configuration via jq so values are JSON-escaped safely. A
# raw heredoc would corrupt the file (or allow JSON injection) if any value
# contained an embedded `"`, `\`, or newline.
if [ "$MODE" = "local" ]; then
  # Local: stdio MCP server with direct SQLite access. Only DATABASE_PATH —
  # no API key (the local server never reads one; task #258).
  jq -n \
    --arg cwd "$SCRIPT_DIR" \
    '{
      mcpServers: {
        "wood-fired-bugs": {
          command: "node",
          args: ["dist/mcp/index.js"],
          cwd: $cwd,
          env: {
            DATABASE_PATH: "./data/tasks.db"
          }
        }
      }
    }' > "$NEW_SERVER_CONFIG"
else
  # Remote: stdio bridge that proxies tools to a REST backend. Requires
  # WFB_API_URL + WFB_API_KEY. Server name 'wood-fired-bugs-remote' matches
  # docs/MCP.md so both entries can coexist in ~/.claude.json.
  jq -n \
    --arg key "$API_KEY" \
    --arg url "$SERVICE_URL" \
    --arg cwd "$SCRIPT_DIR" \
    '{
      mcpServers: {
        "wood-fired-bugs-remote": {
          command: "node",
          args: ["dist/mcp/remote/index.js"],
          cwd: $cwd,
          env: {
            WFB_API_URL: $url,
            WFB_API_KEY: $key
          }
        }
      }
    }' > "$NEW_SERVER_CONFIG"
fi

# Create temporary file for merged config with strict perms — it will contain the API key.
MERGED_CONFIG=$(mktemp)
chmod 600 "$MERGED_CONFIG" 2>/dev/null || true
TEMP_FILES+=("$MERGED_CONFIG")

# Deep merge: existing config + new server config
jq -s '.[0] * .[1]' "$CONFIG_FILE" "$NEW_SERVER_CONFIG" > "$MERGED_CONFIG"

# Atomic write: move merged config to final location and re-tighten perms
# (mv from a 600 source preserves perms on most systems, but explicit chmod
# guards against filesystem quirks).
mv "$MERGED_CONFIG" "$CONFIG_FILE"
secure_file "$CONFIG_FILE"

if [ "$MODE" = "local" ]; then
  SERVER_NAME="wood-fired-bugs"
else
  SERVER_NAME="wood-fired-bugs-remote"
fi
echo "[OK] MCP server '$SERVER_NAME' configured in $CONFIG_FILE (mode 600)"

# ============================================================================
# Step 6: Validate connectivity (LINX-05)
# ============================================================================

echo "[INFO] Validating service connectivity..."

if curl --fail --silent --connect-timeout 5 "$SERVICE_URL/health" > /dev/null 2>&1; then
  echo "[OK] Service is reachable at $SERVICE_URL"
else
  echo "[WARN] Could not reach service at $SERVICE_URL"
  echo "[INFO] The service may not be running yet. Start it with: npm start"
  echo "[INFO] This is non-fatal - the MCP server is configured and will connect when the service starts"
fi

# ============================================================================
# Step 7: Summary
# ============================================================================

echo ""
echo "=========================================="
echo " Installation Complete"
echo "=========================================="
echo ""
echo "Summary:"
echo "  - Install mode: $MODE"
echo "  - $COPIED_COUNT skill files installed to $SKILLS_DEST"
echo "  - MCP server '$SERVER_NAME' configured in $CONFIG_FILE"
if [ -n "$BACKUP_FILE" ]; then
  echo "  - Backup saved to $BACKUP_FILE"
fi
echo "  - Service URL: $SERVICE_URL"
echo ""
echo "Next steps:"
echo "  1. Restart Claude Code to apply configuration changes"
echo "  2. Ensure the wood-fired-bugs service is running (npm start)"
echo "  3. Run /tasks: in Claude Code to get started"
echo ""
echo "[OK] Installation complete"
