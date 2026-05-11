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

# ── 4. Register MCP server with Claude Code ──────────────────────────────────
echo ""
echo "Registering MCP server with Claude Code..."

if ! command -v claude &>/dev/null; then
    echo "ERROR: 'claude' CLI not found on PATH."
    echo "Install Claude Code from https://claude.ai/claude-code and reopen this terminal."
    exit 1
fi

# Remove any prior user-scope entry so re-running setup is idempotent.
# 'claude mcp remove' exits non-zero when the entry is absent — that's fine.
claude mcp remove wood-fired-bugs --scope user >/dev/null 2>&1 || true

if ! claude mcp add wood-fired-bugs \
    --scope user \
    -e "WFB_API_URL=$SERVER_URL" \
    -e "WFB_API_KEY=$API_KEY" \
    -- node "$MCP_ENTRY_POINT"; then
    echo "ERROR: 'claude mcp add' failed."
    exit 1
fi

echo "OK: Registered wood-fired-bugs at user scope (~/.claude.json)"

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
