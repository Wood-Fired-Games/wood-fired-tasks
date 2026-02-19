#!/usr/bin/env bash
# Wood Fired Bugs - Client Setup Script (Linux/Mac)
#
# Configures Claude Code on this machine to connect to the Wood Fired Bugs
# task management system running on the local network.
#
# Usage:
#   ./setup.sh --api-key YOUR_API_KEY
#   ./setup.sh --server-url http://192.168.1.100:3000 --api-key YOUR_API_KEY
#
# Options:
#   --server-url URL    Backend server URL (default: http://192.168.69.69:3000)
#   --api-key KEY       API key for authentication (required)
#   --help              Show this help message

set -e

# ── Defaults ────────────────────────────────────────────────────────────────
SERVER_URL="http://192.168.69.69:3000"
API_KEY=""

# ── Parse arguments ──────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
    case "$1" in
        --server-url)
            SERVER_URL="$2"
            shift 2
            ;;
        --api-key)
            API_KEY="$2"
            shift 2
            ;;
        --help|-h)
            head -20 "$0" | tail -14 | sed 's/^# \?//'
            exit 0
            ;;
        *)
            echo "Unknown option: $1"
            echo "Run with --help for usage"
            exit 1
            ;;
    esac
done

if [[ -z "$API_KEY" ]]; then
    echo "ERROR: --api-key is required"
    echo "Usage: ./setup.sh --api-key YOUR_API_KEY"
    exit 1
fi

# ── Resolve paths ────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MCP_SERVER_DIR="$SCRIPT_DIR/mcp-server"
MCP_ENTRY_POINT="$MCP_SERVER_DIR/dist/mcp/remote/index.js"
SKILLS_SOURCE="$SCRIPT_DIR/commands/tasks"
CLAUDE_DIR="$HOME/.claude"
CLAUDE_COMMANDS_DIR="$CLAUDE_DIR/commands/tasks"
SETTINGS_FILE="$CLAUDE_DIR/settings.json"

echo ""
echo "Wood Fired Bugs - Client Setup"
echo "================================"
echo ""
echo "Package directory: $SCRIPT_DIR"
echo "MCP server path:   $MCP_SERVER_DIR"
echo ""

# ── 1. Check Node.js ─────────────────────────────────────────────────────────
echo "Checking Node.js installation..."

if ! command -v node &>/dev/null; then
    echo "ERROR: Node.js 18+ is required but was not found."
    echo "Download from https://nodejs.org/"
    exit 1
fi

NODE_VERSION=$(node --version)
MAJOR_VERSION=$(echo "$NODE_VERSION" | sed 's/v\([0-9]*\).*/\1/')

if [[ "$MAJOR_VERSION" -lt 18 ]]; then
    echo "ERROR: Node.js 18+ is required. Found: $NODE_VERSION"
    echo "Download from https://nodejs.org/"
    exit 1
fi

echo "OK: Node.js $NODE_VERSION"

# ── 2. Verify MCP server exists ──────────────────────────────────────────────
if [[ ! -f "$MCP_ENTRY_POINT" ]]; then
    echo "ERROR: MCP server not found at: $MCP_ENTRY_POINT"
    echo "The package may be corrupted. Please re-download it."
    exit 1
fi
echo "OK: MCP server found"

# ── 3. Copy skill files ───────────────────────────────────────────────────────
echo ""
echo "Installing /tasks: skill files..."

mkdir -p "$CLAUDE_COMMANDS_DIR"

SKILL_COUNT=0
for file in "$SKILLS_SOURCE"/*.md; do
    if [[ -f "$file" ]]; then
        cp "$file" "$CLAUDE_COMMANDS_DIR/"
        echo "  Installed: $(basename "$file")"
        SKILL_COUNT=$((SKILL_COUNT + 1))
    fi
done

echo "OK: Installed $SKILL_COUNT skill files"

# ── 4. Configure Claude Code settings ────────────────────────────────────────
echo ""
echo "Configuring Claude Code MCP server..."

mkdir -p "$CLAUDE_DIR"

# Build the MCP server config JSON snippet
MCP_CONFIG=$(cat <<EOF
{
  "command": "node",
  "args": ["$MCP_ENTRY_POINT"],
  "env": {
    "WFB_API_URL": "$SERVER_URL",
    "WFB_API_KEY": "$API_KEY"
  }
}
EOF
)

# Update or create settings.json
if [[ -f "$SETTINGS_FILE" ]]; then
    # Try jq first (cleaner)
    if command -v jq &>/dev/null; then
        UPDATED=$(jq --argjson mcpConfig "$MCP_CONFIG" \
            '.mcpServers["wood-fired-bugs"] = $mcpConfig' \
            "$SETTINGS_FILE" 2>/dev/null) || true

        if [[ -n "$UPDATED" ]]; then
            echo "$UPDATED" > "$SETTINGS_FILE"
        else
            echo "WARNING: Could not parse settings.json with jq, creating backup and replacing..."
            cp "$SETTINGS_FILE" "${SETTINGS_FILE}.bak"
            echo "{\"mcpServers\":{\"wood-fired-bugs\":$MCP_CONFIG}}" > "$SETTINGS_FILE"
        fi
    else
        # Fallback: Python one-liner
        python3 -c "
import json, sys
with open('$SETTINGS_FILE', 'r') as f:
    try:
        s = json.load(f)
    except:
        s = {}
if 'mcpServers' not in s:
    s['mcpServers'] = {}
s['mcpServers']['wood-fired-bugs'] = json.loads('''$MCP_CONFIG''')
with open('$SETTINGS_FILE', 'w') as f:
    json.dump(s, f, indent=2)
" 2>/dev/null || {
            # Last resort: overwrite
            echo "WARNING: Could not update existing settings.json, creating backup..."
            cp "$SETTINGS_FILE" "${SETTINGS_FILE}.bak"
            echo "{\"mcpServers\":{\"wood-fired-bugs\":$MCP_CONFIG}}" > "$SETTINGS_FILE"
        }
    fi
else
    # No existing settings file — create fresh
    echo "{\"mcpServers\":{\"wood-fired-bugs\":$MCP_CONFIG}}" > "$SETTINGS_FILE"
fi

echo "OK: Updated $SETTINGS_FILE"

# ── 5. Done ───────────────────────────────────────────────────────────────────
echo ""
echo "Setup complete!"
echo ""
echo "To verify the connection, run:"
echo "  WFB_API_URL=$SERVER_URL WFB_API_KEY=... node \"$MCP_ENTRY_POINT\""
echo ""
echo "Open Claude Code in any project and try:"
echo "  /tasks:my-work"
echo ""
echo "Available commands:"
echo "  /tasks:create-task    Create a new task"
echo "  /tasks:my-work        List your assigned tasks"
echo "  /tasks:pick-up        Pick up a task to work on"
echo "  /tasks:done           Mark a task as done"
echo "  /tasks:search         Search tasks by keyword"
echo "  /tasks:show-task      Show full task details"
echo "  /tasks:log-bug        Log a bug report"
echo "  /tasks:add-comment    Add a comment to a task"
echo "  /tasks:blocked        Mark a task as blocked"
echo "  /tasks:project-status View project status overview"
echo ""
