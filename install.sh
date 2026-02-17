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

# ============================================================================
# Cleanup and rollback handler
# ============================================================================

BACKUP_FILE=""
TEMP_FILES=()

cleanup() {
  local exit_code=$?

  # Clean up temporary files
  for temp_file in "${TEMP_FILES[@]}"; do
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
# Step 2: Prompt for API key
# ============================================================================

API_KEY=""

# Check for API key from command line flag
while [[ $# -gt 0 ]]; do
  case $1 in
    --api-key)
      API_KEY="$2"
      shift 2
      ;;
    *)
      echo "[ERROR] Unknown option: $1"
      echo "Usage: $0 [--api-key KEY]"
      exit 1
      ;;
  esac
done

# Check for API key from environment variable
if [ -z "$API_KEY" ] && [ -n "${WOOD_FIRED_BUGS_API_KEY:-}" ]; then
  API_KEY="$WOOD_FIRED_BUGS_API_KEY"
  echo "[INFO] Using API key from WOOD_FIRED_BUGS_API_KEY environment variable"
fi

# Prompt for API key if not provided
if [ -z "$API_KEY" ]; then
  echo ""
  read -sp "Enter Wood Fired Bugs API key: " API_KEY
  echo ""
fi

# Validate API key is non-empty
if [ -z "$API_KEY" ]; then
  echo "[ERROR] API key is required"
  exit 1
fi

# Show masked key confirmation
MASKED_KEY="${API_KEY:0:4}$(printf '*%.0s' {1..20})"
echo "[OK] API key set: $MASKED_KEY"

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
  echo '{}' > "$CONFIG_FILE"
else
  # Create timestamped backup
  TIMESTAMP=$(date +%Y%m%d_%H%M%S)
  BACKUP_FILE="${CONFIG_FILE}.backup.${TIMESTAMP}"
  cp "$CONFIG_FILE" "$BACKUP_FILE"
  echo "[OK] Backed up existing configuration to $BACKUP_FILE"
fi

# ============================================================================
# Step 5: Merge MCP server config (LINX-02, LINX-03, LINX-05)
# ============================================================================

echo "[INFO] Configuring MCP server..."

# Create temporary file for new server config
NEW_SERVER_CONFIG=$(mktemp)
TEMP_FILES+=("$NEW_SERVER_CONFIG")

# Build MCP server configuration
cat > "$NEW_SERVER_CONFIG" <<EOF
{
  "mcpServers": {
    "wood-fired-bugs": {
      "command": "node",
      "args": ["dist/mcp/index.js"],
      "cwd": "$SCRIPT_DIR",
      "env": {
        "WOOD_FIRED_BUGS_API_KEY": "$API_KEY",
        "DB_PATH": "./data/tasks.db"
      }
    }
  }
}
EOF

# Create temporary file for merged config
MERGED_CONFIG=$(mktemp)
TEMP_FILES+=("$MERGED_CONFIG")

# Deep merge: existing config + new server config
jq -s '.[0] * .[1]' "$CONFIG_FILE" "$NEW_SERVER_CONFIG" > "$MERGED_CONFIG"

# Atomic write: move merged config to final location
mv "$MERGED_CONFIG" "$CONFIG_FILE"

echo "[OK] MCP server 'wood-fired-bugs' configured in $CONFIG_FILE"

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
echo "  - $COPIED_COUNT skill files installed to $SKILLS_DEST"
echo "  - MCP server 'wood-fired-bugs' configured in $CONFIG_FILE"
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
