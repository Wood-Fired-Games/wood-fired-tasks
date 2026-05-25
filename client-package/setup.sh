#!/usr/bin/env bash
# Wood Fired Tasks - Client Setup Script (Linux/Mac)
#
# Configures Claude Code on this machine to connect to the Wood Fired Tasks
# task management system running on the local network.
#
# API key resolution (most secure first):
#   1. WFT_API_KEY environment variable
#   2. Per-user secret file (~/.config/wood-fired-tasks/api-key, mode 600)
#   3. Masked interactive prompt
#   4. --api-key KEY argument (DEPRECATED — leaks via shell history and ps)
#
# Usage:
#   WFT_API_KEY=... ./setup.sh
#   ./setup.sh                                 # prompts for the key
#   ./setup.sh --server-url http://192.0.2.100:3000
#   ./setup.sh --api-key YOUR_API_KEY          # deprecated, still works
#
# Options:
#   --server-url URL    Backend server URL (default: http://localhost:3000).
#                       Override this with --server-url or the WFT_API_URL env
#                       var when the backend runs on a different host.
#   --api-key KEY       API key (DEPRECATED — see resolution order above)
#   --help              Show this help message

set -e

# ── Defaults ────────────────────────────────────────────────────────────────
# Default to localhost; users must override via --server-url or WFT_API_URL
# when targeting a remote backend.
SERVER_URL="${WFT_API_URL:-http://localhost:3000}"
API_KEY=""
API_KEY_FROM_ARGV=0

# Per-user secret file. 0600 perms, owner-only access.
SECRET_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/wood-fired-tasks"
SECRET_FILE="$SECRET_DIR/api-key"

# ── Parse arguments ──────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
    case "$1" in
        --server-url)
            SERVER_URL="$2"
            shift 2
            ;;
        --api-key)
            API_KEY="$2"
            API_KEY_FROM_ARGV=1
            shift 2
            ;;
        --help|-h)
            sed -n '2,23p' "$0" | sed 's/^# \?//'
            exit 0
            ;;
        *)
            echo "Unknown option: $1"
            echo "Run with --help for usage"
            exit 1
            ;;
    esac
done

if [[ "$API_KEY_FROM_ARGV" -eq 1 ]]; then
    echo "[WARN] --api-key on the command line is DEPRECATED."
    echo "[WARN] Command-line secrets leak via shell history and 'ps -ef'."
    echo "[WARN] Prefer the WFT_API_KEY env var, the secret file ($SECRET_FILE),"
    echo "[WARN] or the interactive prompt. This flag will be removed in a future release."
fi

# Resolve API key from env var if not on argv
if [[ -z "$API_KEY" && -n "${WFT_API_KEY:-}" ]]; then
    API_KEY="$WFT_API_KEY"
    echo "[INFO] Using API key from WFT_API_KEY environment variable"
fi

# Resolve API key from secret file
if [[ -z "$API_KEY" && -r "$SECRET_FILE" ]]; then
    perms="$(stat -c '%a' "$SECRET_FILE" 2>/dev/null || stat -f '%Lp' "$SECRET_FILE" 2>/dev/null)"
    if [[ "$perms" == "600" ]]; then
        API_KEY="$(tr -d '\r\n' < "$SECRET_FILE")"
        if [[ -n "$API_KEY" ]]; then
            echo "[INFO] Using API key from $SECRET_FILE"
        fi
    else
        echo "[WARN] Secret file $SECRET_FILE has loose permissions ($perms); ignoring."
        echo "[WARN] Run: chmod 600 \"$SECRET_FILE\" to fix."
    fi
fi

# Final fallback: masked prompt
if [[ -z "$API_KEY" ]]; then
    echo ""
    read -rsp "Enter Wood Fired Tasks API key: " API_KEY
    echo ""
fi

if [[ -z "$API_KEY" ]]; then
    echo "ERROR: API key is required"
    echo "Set WFT_API_KEY, populate $SECRET_FILE (mode 600), or supply it at the prompt."
    exit 1
fi

# Cache the key in the per-user secret file so future re-runs don't need argv/env.
if [[ ! -d "$SECRET_DIR" ]]; then
    mkdir -p "$SECRET_DIR"
    chmod 700 "$SECRET_DIR" 2>/dev/null || true
fi
( umask 077 && : > "$SECRET_FILE" )
chmod 600 "$SECRET_FILE" 2>/dev/null || true
printf '%s\n' "$API_KEY" > "$SECRET_FILE"
chmod 600 "$SECRET_FILE" 2>/dev/null || true

# ── Resolve paths ────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MCP_SERVER_DIR="$SCRIPT_DIR/mcp-server"
MCP_ENTRY_POINT="$MCP_SERVER_DIR/dist/mcp/remote/index.js"
SKILLS_SOURCE="$SCRIPT_DIR/commands/tasks"
CLAUDE_DIR="$HOME/.claude"
CLAUDE_COMMANDS_DIR="$CLAUDE_DIR/commands/tasks"

echo ""
echo "Wood Fired Tasks - Client Setup"
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
claude mcp remove wood-fired-tasks --scope user >/dev/null 2>&1 || true

if ! claude mcp add wood-fired-tasks \
    --scope user \
    -e "WFT_API_URL=$SERVER_URL" \
    -e "WFT_API_KEY=$API_KEY" \
    -- node "$MCP_ENTRY_POINT"; then
    echo "ERROR: 'claude mcp add' failed."
    exit 1
fi

# claude mcp add embedded the API key in ~/.claude.json. Tighten perms now.
CLAUDE_CONFIG="$HOME/.claude.json"
if [[ -f "$CLAUDE_CONFIG" ]]; then
    chmod 600 "$CLAUDE_CONFIG" 2>/dev/null || true
fi

echo "OK: Registered wood-fired-tasks at user scope (~/.claude.json, mode 600)"

# ── 5. Done ───────────────────────────────────────────────────────────────────
echo ""
echo "Setup complete!"
echo ""
echo "API key cached at: $SECRET_FILE (mode 600)"
echo ""
echo "To verify the connection, run (key is read from the secret file):"
echo "  WFT_API_URL=$SERVER_URL WFT_API_KEY=\"\$(cat \"$SECRET_FILE\")\" node \"$MCP_ENTRY_POINT\""
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
