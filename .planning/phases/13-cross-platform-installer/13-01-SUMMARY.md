---
phase: 13-cross-platform-installer
plan: 01
subsystem: infra
tags: [bash, installer, jq, mcp, claude-code]

# Dependency graph
requires:
  - phase: 12-skill-file-authoring
    provides: Skill markdown files in skills/tasks/
provides:
  - Bash installer script (install.sh) for Linux/macOS
  - Automated skill file copying to ~/.claude/commands/tasks/
  - MCP server configuration merge into ~/.claude.json
  - API key secure input and storage in MCP env
  - Timestamped backup mechanism
  - Connectivity validation via curl
affects: [13-02-windows-installer, deployment, user-setup]

# Tech tracking
tech-stack:
  added: [jq for JSON deep merge]
  patterns: [Atomic config updates, trap-based rollback, idempotent installers]

key-files:
  created: [install.sh]
  modified: []

key-decisions:
  - "Use jq deep merge (jq -s '.[0] * .[1]') to preserve existing MCP servers"
  - "Write API key to MCP config env section (not shell profile) per MCP isolation requirements"
  - "Implement trap-based cleanup with automatic rollback on failure"
  - "Text labels ([OK], [WARN], [ERROR]) instead of emojis for accessibility"
  - "Absolute paths in MCP config cwd field for project location"

patterns-established:
  - "Pattern 1: Prerequisite checking with clear installation instructions per distro"
  - "Pattern 2: Timestamped backups (YYYYMMDD_HHMMSS) before any config modification"
  - "Pattern 3: API key priority: --api-key flag > env var > interactive prompt"
  - "Pattern 4: Non-fatal connectivity validation (service may not be running yet)"

# Metrics
duration: 2min
completed: 2026-02-14
---

# Phase 13 Plan 01: Cross-Platform Installer Summary

**Bash installer with jq deep merge, trap-based rollback, and idempotent skill/config setup for Linux/macOS**

## Performance

- **Duration:** 2 minutes
- **Started:** 2026-02-14T01:22:03Z
- **Completed:** 2026-02-14T01:24:09Z
- **Tasks:** 2
- **Files modified:** 1

## Accomplishments
- Complete Bash installer script with 7 sections (prerequisites, API key, copy skills, backup, merge config, validate, summary)
- Safe JSON configuration merge using jq preserving existing MCP servers
- Rollback mechanism via trap handler restoring backups on failure
- Idempotent execution (safe to run multiple times)
- Secure API key handling with multiple input methods

## Task Commits

Each task was committed atomically:

1. **Task 1: Create Bash installer script** - `1d6c69f` (feat)

Task 2 was verification-only (no file changes).

## Files Created/Modified
- `install.sh` - Bash installer for Linux/macOS with prerequisite checks, skill copying, MCP config merge, backup/rollback, and connectivity validation

## Decisions Made

1. **jq deep merge with * operator:** Using `jq -s '.[0] * .[1]'` for recursive merge ensures existing mcpServers entries are preserved while adding wood-fired-bugs server
2. **API key to MCP config env only:** MCP servers don't inherit shell environment variables; API key must be in the `env` property of the server config JSON
3. **Trap-based cleanup with rollback:** Using `trap cleanup EXIT` to automatically restore config backup if installation fails at any step
4. **Text labels over emojis:** Following Phase 12 decision for accessibility ([OK], [WARN], [ERROR], [INFO] instead of emojis)
5. **Absolute path in cwd:** Resolved `$SCRIPT_DIR` to absolute path for MCP server config `cwd` field so service runs from correct directory

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None - all verification checks passed on first attempt.

## User Setup Required

None - installer handles all setup automatically. Users must provide API key during installation.

## Next Phase Readiness

- Bash installer (install.sh) complete and verified
- Ready for Phase 13 Plan 02: Windows PowerShell installer
- install.ps1 already exists in project (created outside GSD workflow) - may need review/integration

**Self-Check:**

Verifying all claims:
- install.sh exists: /home/stuart/wood-fired-bugs/install.sh
- Commit 1d6c69f exists: verified
- Contains all required sections: verified via grep checks
- Passes bash -n syntax check: verified

## Self-Check: PASSED

---
*Phase: 13-cross-platform-installer*
*Completed: 2026-02-14*
