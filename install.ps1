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

# Emit on the pipeline/Output stream (stream 1), NOT Write-Host (stream 6,
# Information). Callers capture this notice with `./install.ps1 2>&1 | Out-String`
# (e.g. the CI smoke), and `2>&1` only merges Error into Output — it does NOT
# capture the Information stream. Using Write-Output keeps the notice visible to
# the console AND capturable by redirection, matching install.sh's stdout echo.
Write-Output $notice

# Attempt to delegate if the published binary is already installed.
$bin = Get-Command wood-fired-tasks -ErrorAction SilentlyContinue
if ($null -ne $bin) {
    Write-Output "Detected 'wood-fired-tasks' on PATH - delegating to 'wood-fired-tasks setup'..."
    Write-Output ""
    if ($Args) {
        & wood-fired-tasks setup @Args
    } else {
        & wood-fired-tasks setup
    }
    exit $LASTEXITCODE
}

Write-Output "'wood-fired-tasks' is not on PATH yet. Install it first:"
Write-Output ""
Write-Output "    npm i -g wood-fired-tasks"
Write-Output "    wood-fired-tasks setup"
Write-Output ""

exit 0
