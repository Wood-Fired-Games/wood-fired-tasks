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
    echo "ERROR: Node.js 22+ is required but was not found."
    echo "Download from https://nodejs.org/"
    exit 1
fi

NODE_VERSION=$(node --version)
MAJOR_VERSION=$(echo "$NODE_VERSION" | sed 's/v\([0-9]*\).*/\1/')

if [[ "$MAJOR_VERSION" -lt 22 ]]; then
    echo "ERROR: Node.js 22+ is required. Found: $NODE_VERSION"
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

# ── 5. Install tasks CLI to PATH ──────────────────────────────────────────────
# Parity with setup.ps1's tasks.cmd wrapper. We generate a small POSIX wrapper
# at <package>/bin/tasks that reads the API key from the per-user secret file
# at runtime (never embeds it) and execs node against the bundled CLI entry
# point. Then we add <package>/bin to the user's PATH via a guarded block in
# their shell rc file so a new shell picks up the `tasks` command.
echo ""
echo "Installing tasks CLI..."

BIN_DIR="$SCRIPT_DIR/bin"
CLI_ENTRY_POINT="$MCP_SERVER_DIR/dist/cli/bin/tasks-client.js"
TASKS_WRAPPER="$BIN_DIR/tasks"

mkdir -p "$BIN_DIR"

# Generate the wrapper.
# IMPORTANT: do NOT embed the API key in this file. The wrapper reads it from
# the per-user secret file at runtime. The secret file has mode 600, and the
# wrapper itself contains no secrets and is safe to leave on PATH.
cat > "$TASKS_WRAPPER" <<WRAPPER
#!/usr/bin/env bash
# Wood Fired Tasks CLI wrapper (generated by setup.sh — do not edit by hand).
# Reads the API key from the per-user secret file at runtime; embeds no secret.
set -euo pipefail

SECRET_FILE="$SECRET_FILE"
export WFT_API_URL="\${WFT_API_URL:-$SERVER_URL}"
export API_BASE_URL="\$WFT_API_URL"

if [[ -z "\${WFT_API_KEY:-}" && -r "\$SECRET_FILE" ]]; then
    WFT_API_KEY="\$(tr -d '\r\n' < "\$SECRET_FILE")"
    export WFT_API_KEY
fi

if [[ -z "\${WFT_API_KEY:-}" ]]; then
    echo "ERROR: Wood Fired Tasks API key not found." >&2
    echo "Set WFT_API_KEY, populate \$SECRET_FILE, or re-run setup.sh." >&2
    exit 1
fi

export API_KEY="\$WFT_API_KEY"
exec node "$CLI_ENTRY_POINT" "\$@"
WRAPPER

chmod 755 "$TASKS_WRAPPER"
echo "OK: tasks CLI wrapper written to $TASKS_WRAPPER (reads key from $SECRET_FILE at runtime)"

# Add the bin dir to PATH via a guarded block in the user's shell rc.
# Guard markers keep this idempotent across re-runs and let uninstall.sh
# remove exactly what we added.
PATH_MARKER_BEGIN="# >>> wood-fired-tasks PATH >>>"
PATH_MARKER_END="# <<< wood-fired-tasks PATH <<<"

# Pick the rc file for the user's login shell, defaulting to ~/.bashrc.
case "$(basename "${SHELL:-/bin/bash}")" in
    zsh) SHELL_RC="$HOME/.zshrc" ;;
    *)   SHELL_RC="$HOME/.bashrc" ;;
esac

if [[ -f "$SHELL_RC" ]] && grep -qF "$PATH_MARKER_BEGIN" "$SHELL_RC"; then
    echo "OK: $BIN_DIR already on PATH via $SHELL_RC"
elif command -v tasks &>/dev/null && [[ "$(command -v tasks)" == "$TASKS_WRAPPER" ]]; then
    echo "OK: tasks already resolves to $TASKS_WRAPPER on PATH"
else
    {
        printf '\n%s\n' "$PATH_MARKER_BEGIN"
        # shellcheck disable=SC2016  # $PATH must stay literal — it expands when the rc is sourced, not now.
        printf 'export PATH="%s:$PATH"\n' "$BIN_DIR"
        printf '%s\n' "$PATH_MARKER_END"
    } >> "$SHELL_RC"
    echo "OK: Added $BIN_DIR to PATH in $SHELL_RC"
    echo "    (Open a new terminal, or run: source \"$SHELL_RC\")"
fi

# ── 6. Done ───────────────────────────────────────────────────────────────────
echo ""
echo "Setup complete!"
echo ""
echo "API key cached at: $SECRET_FILE (mode 600)"
echo ""
echo "Open a NEW terminal (or source your shell rc), then try:"
echo "  tasks list             List all tasks"
echo "  tasks show 1           Show task details"
echo "  tasks create           Create a task interactively"
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
