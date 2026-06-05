#!/usr/bin/env pwsh
# Wood Fired Tasks - DEPRECATED git-clone installer (Windows PowerShell)
#
# This script used to wire up Claude Code skills + an MCP server entry from a
# local git checkout. That path is retired. The supported install flow is now
# the published npm package plus its `setup` subcommand:
#
#     npm i -g wood-fired-tasks ; wood-fired-tasks setup
#
# This shim prints the notice and, if the `wood-fired-tasks` binary is already
# on PATH, delegates to `wood-fired-tasks setup`. It never requires elevation
# and always exits cleanly.

[CmdletBinding()]
param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$Args
)

$ErrorActionPreference = 'Stop'

$notice = @'

============================================================
  wood-fired-tasks: install.ps1 is DEPRECATED
============================================================

  The git-clone installer has been retired.

  Supported install path:

      npm i -g wood-fired-tasks
      wood-fired-tasks setup

  'wood-fired-tasks setup' merges the MCP server entry into
  ~/.claude.json and copies the /tasks:* skill commands.
============================================================

'@

Write-Host $notice

# Attempt to delegate if the published binary is already installed.
$bin = Get-Command wood-fired-tasks -ErrorAction SilentlyContinue
if ($null -ne $bin) {
    Write-Host "Detected 'wood-fired-tasks' on PATH - delegating to 'wood-fired-tasks setup'..."
    Write-Host ""
    if ($Args) {
        & wood-fired-tasks setup @Args
    } else {
        & wood-fired-tasks setup
    }
    exit $LASTEXITCODE
}

Write-Host "'wood-fired-tasks' is not on PATH yet. Install it first:"
Write-Host ""
Write-Host "    npm i -g wood-fired-tasks"
Write-Host "    wood-fired-tasks setup"
Write-Host ""

exit 0
