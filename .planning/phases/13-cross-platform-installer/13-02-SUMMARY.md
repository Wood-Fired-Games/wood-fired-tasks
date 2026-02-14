---
phase: 13-cross-platform-installer
plan: 02
subsystem: installer
tags: [powershell, windows, mcp-config, installer]
dependencies:
  requires: []
  provides: [windows-installer, ps1-script]
  affects: [user-setup, mcp-configuration]
tech-stack:
  added: []
  patterns: [powershell-json-merge, timestamped-backups, idempotent-install]
key-files:
  created: [install.ps1]
  modified: []
decisions:
  - Use ConvertFrom-Json/ConvertTo-Json with -Depth 10 for deep merge (PowerShell defaults to depth 2)
  - Write API key to MCP env section, not shell profile (MCP servers don't inherit shell vars)
  - Use Add-Member -Force for idempotent server config updates
  - Text labels ([OK], [WARN]) instead of emojis for accessibility
metrics:
  duration: 2.1
  completed_date: 2026-02-14
  tasks_completed: 2
  files_created: 1
---

# Phase 13 Plan 02: Windows PowerShell Installer Summary

**One-liner:** PowerShell installer automating Claude Code MCP setup with JSON deep merge, timestamped backups, and service validation for Windows users.

## Tasks Completed

### Task 1: Create PowerShell installer script
**Status:** Complete
**Commit:** 1d6c69f
**Files:** install.ps1

Created install.ps1 with comprehensive Windows installation automation including:
- Error handling with $ErrorActionPreference = "Stop" and try/catch/finally
- Node.js prerequisite validation via Get-Command
- Three-tier API key input: -ApiKey parameter > env var > interactive Read-Host -MaskInput
- Idempotent skill file copying (only copies if missing or newer)
- Timestamped configuration backups before any modification
- Deep JSON merge using ConvertFrom-Json/ConvertTo-Json -Depth 10
- MCP server configuration with proper env isolation for API key
- HTTP connectivity validation via Invoke-WebRequest with non-fatal warnings
- Automatic backup restoration on installation failure

### Task 2: Verify PowerShell installer structure and patterns
**Status:** Complete
**Commit:** (verification-only, no changes)
**Files:** install.ps1

Verified all required patterns present:
- Safety: $ErrorActionPreference = "Stop"
- Prerequisites: Get-Command node
- API key: Read-Host -MaskInput
- Skill copy: New-Item Directory + Copy-Item with timestamp comparison
- Backup: .backup. timestamped files
- JSON handling: ConvertFrom-Json + Add-Member -Force + ConvertTo-Json -Depth 10
- Connectivity: Invoke-WebRequest to /health endpoint
- Summary: "Installation complete" message
- Parameters: -ApiKey for non-interactive CI usage
- Rollback: catch block with backup restoration

## What Was Built

**install.ps1** - Windows PowerShell installer script (203 lines)

Implements complete installation workflow:
1. Prerequisite checks (Node.js, skill files source)
2. API key collection with masking and validation
3. Skill file installation to ~/.claude/commands/tasks/
4. Configuration backup with yyyyMMdd_HHmmss timestamps
5. MCP server deep merge preserving existing servers
6. Service connectivity validation with graceful degradation
7. Comprehensive success/failure reporting

Key implementation details:
- Uses Join-Path for cross-platform path handling
- Script-scoped $BackupFile variable for cleanup access
- Colored output with Write-Host -ForegroundColor for UX
- Non-fatal health check (warns but doesn't fail if service not running)
- Idempotent operation (safe to run multiple times)

## Deviations from Plan

None - plan executed exactly as written.

## Verification Results

All must-haves satisfied:

**Truths:**
- ✅ Windows user can run `./install.ps1` and have skills copied to appropriate location
- ✅ Existing Claude Code MCP config preserved (other servers not lost)
- ✅ API key written to MCP server config env section, not shell profile
- ✅ Existing config backed up with timestamp before modification
- ✅ Installer validates connectivity to wood-fired-bugs service
- ✅ Installer is idempotent (safe to run multiple times)

**Artifacts:**
- ✅ install.ps1 exists with ErrorActionPreference = "Stop"
- ✅ Contains Copy-Item.*skills pattern for file installation
- ✅ Contains ConvertFrom-Json|Add-Member pattern for config merge

**Key Links:**
- ✅ install.ps1 → skills/tasks/*.md via Copy-Item to user skills directory
- ✅ install.ps1 → config file via ConvertFrom-Json + Add-Member for mcpServers merge

**Success Criteria:**
- ✅ WIN-01: Copies skill files to ~/.claude/commands/tasks/
- ✅ WIN-02: Merges MCP config preserving existing servers via Add-Member -Force
- ✅ WIN-03: Writes API key to mcpServers.wood-fired-bugs.env
- ✅ WIN-04: Creates .backup.yyyyMMdd_HHmmss files before modification
- ✅ WIN-05: Validates connectivity via Invoke-WebRequest to /health

## Commits

| Task | Commit | Message |
|------|--------|---------|
| 1 | 1d6c69f | feat(13-02): create PowerShell installer for Windows |

## Self-Check: PASSED

**Files created:**
```bash
FOUND: install.ps1
```

**Commits verified:**
```bash
FOUND: 1d6c69f
```

All artifacts verified present on disk and in git history.

## Notes

- PowerShell JSON depth limitation (defaults to 2) addressed with -Depth 10 parameter
- MCP servers run in isolated environment; env vars must be in config, not shell profile
- Installer gracefully handles missing service (warns but doesn't fail)
- Text labels used instead of emojis for accessibility (consistent with Phase 12 decisions)
- Script supports three API key sources for flexibility: parameter, env var, interactive input
- Rollback mechanism ensures failed installations don't leave system in broken state
