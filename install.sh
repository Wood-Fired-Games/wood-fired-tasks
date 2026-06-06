#!/usr/bin/env sh
# Wood Fired Tasks - DEPRECATED git-clone installer (Linux/macOS)
#
# This script used to wire up Claude Code skills + an MCP server entry from a
# local git checkout. That path is retired. The supported install flow is now
# the published npm package plus its `setup` subcommand:
#
#     npm i -g wood-fired-tasks && wood-fired-tasks setup
#
# This shim prints the notice above and, if the `wood-fired-tasks` binary is
# already on PATH, delegates to `wood-fired-tasks setup` so an existing user
# who runs the old command still lands in the right place. It never requires
# sudo and always exits cleanly.

set -eu

printf '%s\n' \
  "" \
  "============================================================" \
  "  wood-fired-tasks: install.sh is DEPRECATED" \
  "============================================================" \
  "" \
  "  The git-clone installer has been retired." \
  "" \
  "  Supported install path:" \
  "" \
  "      npm i -g wood-fired-tasks && wood-fired-tasks setup" \
  "" \
  "  'wood-fired-tasks setup' merges the MCP server entry into" \
  "  ~/.claude.json and copies the /tasks:* skill commands." \
  "============================================================" \
  "" >&2

# Attempt to delegate if the published binary is already installed.
if command -v wood-fired-tasks >/dev/null 2>&1; then
  printf '%s\n' "Detected 'wood-fired-tasks' on PATH — delegating to 'wood-fired-tasks setup'..." >&2
  printf '%s\n' "" >&2
  exec wood-fired-tasks setup "$@"
fi

printf '%s\n' \
  "'wood-fired-tasks' is not on PATH yet. Install it first:" \
  "" \
  "    npm i -g wood-fired-tasks" \
  "    wood-fired-tasks setup" \
  "" >&2

exit 0
