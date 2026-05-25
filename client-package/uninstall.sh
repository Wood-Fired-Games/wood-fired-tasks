#!/usr/bin/env bash
# Wood Fired Tasks - Client Uninstall Script (Linux/Mac)
#
# Reverses everything setup.sh installed:
#   - /tasks: skill files from ~/.claude/commands/tasks
#   - wood-fired-tasks MCP server entry from Claude Code (user scope)
#   - the generated tasks CLI wrapper (<package>/bin/tasks)
#   - the guarded PATH block added to the user's shell rc
#   - the per-user secret/credential file (~/.config/wood-fired-tasks/api-key)
#
# Conservative by design: it only removes what setup.sh created. It never
# runs `rm -rf` against a user directory it did not author, and every step is
# a no-op (with a friendly message) when the artifact is already gone.
#
# Usage:
#   ./uninstall.sh
#   ./uninstall.sh --help

set -e

# ── Parse arguments ───────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
    case "$1" in
        --help|-h)
            sed -n '2,12p' "$0" | sed 's/^# \?//'
            exit 0
            ;;
        *)
            echo "Unknown option: $1"
            echo "Run with --help for usage"
            exit 1
            ;;
    esac
done

# ── Resolve paths (must match setup.sh) ───────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN_DIR="$SCRIPT_DIR/bin"
TASKS_WRAPPER="$BIN_DIR/tasks"

CLAUDE_COMMANDS_DIR="$HOME/.claude/commands/tasks"

SECRET_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/wood-fired-tasks"
SECRET_FILE="$SECRET_DIR/api-key"

PATH_MARKER_BEGIN="# >>> wood-fired-tasks PATH >>>"
PATH_MARKER_END="# <<< wood-fired-tasks PATH <<<"

echo ""
echo "Wood Fired Tasks - Uninstall"
echo "============================"
echo ""

# ── 1. Remove skill files ─────────────────────────────────────────────────────
echo "Removing /tasks: skill files..."

if [[ -d "$CLAUDE_COMMANDS_DIR" ]]; then
    rm -rf "$CLAUDE_COMMANDS_DIR"
    echo "OK: Removed $CLAUDE_COMMANDS_DIR"
else
    echo "OK: Skills directory not found (already removed)"
fi

# ── 2. Remove MCP server from Claude Code ─────────────────────────────────────
echo ""
echo "Removing MCP server from Claude Code..."

if command -v claude &>/dev/null; then
    if claude mcp remove wood-fired-tasks --scope user >/dev/null 2>&1; then
        echo "OK: Removed wood-fired-tasks (user scope)"
    else
        echo "OK: MCP server entry not found (already removed)"
    fi
else
    echo "WARNING: 'claude' CLI not found on PATH; skipping MCP removal."
    echo "         If installed previously, run: claude mcp remove wood-fired-tasks --scope user"
fi

# ── 3. Remove the tasks CLI wrapper ───────────────────────────────────────────
echo ""
echo "Removing tasks CLI..."

if [[ -f "$TASKS_WRAPPER" ]]; then
    rm -f "$TASKS_WRAPPER"
    echo "OK: Removed $TASKS_WRAPPER"
else
    echo "OK: tasks wrapper not found (already removed)"
fi

# Best-effort: remove the bin dir only if WE created it and it is now empty.
if [[ -d "$BIN_DIR" ]] && [[ -z "$(ls -A "$BIN_DIR" 2>/dev/null)" ]]; then
    rmdir "$BIN_DIR" 2>/dev/null || true
fi

# ── 4. Remove the PATH block from the user's shell rc ─────────────────────────
echo ""
echo "Cleaning up PATH..."

removed_path=0
for SHELL_RC in "$HOME/.bashrc" "$HOME/.zshrc"; do
    if [[ -f "$SHELL_RC" ]] && grep -qF "$PATH_MARKER_BEGIN" "$SHELL_RC"; then
        # Delete the guarded block (markers inclusive). sed handles the literal
        # markers; the '/' in the comment text is not a delimiter conflict here
        # because we anchor on the full literal lines.
        tmp_rc="$(mktemp)"
        sed "\|$PATH_MARKER_BEGIN|,\|$PATH_MARKER_END|d" "$SHELL_RC" > "$tmp_rc"
        cat "$tmp_rc" > "$SHELL_RC"
        rm -f "$tmp_rc"
        echo "OK: Removed PATH block from $SHELL_RC"
        removed_path=1
    fi
done
if [[ "$removed_path" -eq 0 ]]; then
    echo "OK: No PATH block found (already removed)"
fi

# ── 5. Remove the per-user secret file ────────────────────────────────────────
echo ""
echo "Removing cached API key..."

if [[ -f "$SECRET_FILE" ]]; then
    rm -f "$SECRET_FILE"
    echo "OK: Removed $SECRET_FILE"
    # Best-effort: remove the secret dir if it is now empty.
    if [[ -d "$SECRET_DIR" ]] && [[ -z "$(ls -A "$SECRET_DIR" 2>/dev/null)" ]]; then
        rmdir "$SECRET_DIR" 2>/dev/null || true
    fi
else
    echo "OK: No cached API key found (already removed)"
fi

# ── 6. Done ───────────────────────────────────────────────────────────────────
echo ""
echo "Uninstall complete!"
echo ""
echo "You can now safely delete this folder."
echo "Restart Claude Code for MCP changes to take effect."
echo ""
