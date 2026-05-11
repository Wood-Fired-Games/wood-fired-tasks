#Requires -Version 5.1
<#
.SYNOPSIS
    Uninstalls Wood Fired Bugs client configuration from this machine.

.DESCRIPTION
    Removes all configuration added by setup.ps1:
    - /tasks: skill files from Claude Code commands directory
    - wood-fired-bugs MCP server entry from Claude Code settings
    - tasks.cmd CLI wrapper
    - bin directory from user PATH
#>

$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "Wood Fired Bugs - Uninstall" -ForegroundColor Cyan
Write-Host "===========================" -ForegroundColor Cyan
Write-Host ""

$PackageDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$BinDir = Join-Path $PackageDir "bin"

# ── 1. Remove skill files ────────────────────────────────────────────────────
Write-Host "Removing /tasks: skill files..." -ForegroundColor Yellow

$ClaudeCommandsDir = Join-Path $env:USERPROFILE ".claude\commands\tasks"
if (Test-Path $ClaudeCommandsDir) {
    Remove-Item -Path $ClaudeCommandsDir -Recurse -Force
    Write-Host "OK: Removed $ClaudeCommandsDir" -ForegroundColor Green
} else {
    Write-Host "OK: Skills directory not found (already removed)" -ForegroundColor Green
}

# ── 2. Remove MCP server from Claude Code ────────────────────────────────────
Write-Host ""
Write-Host "Removing MCP server from Claude Code..." -ForegroundColor Yellow

if (Get-Command claude -ErrorAction SilentlyContinue) {
    $removeOutput = & claude mcp remove wood-fired-bugs --scope user 2>&1
    if ($LASTEXITCODE -eq 0) {
        Write-Host "OK: Removed wood-fired-bugs (user scope)" -ForegroundColor Green
    } else {
        Write-Host "OK: MCP server entry not found (already removed)" -ForegroundColor Green
    }
} else {
    Write-Host "WARNING: 'claude' CLI not found on PATH; skipping MCP removal." -ForegroundColor Yellow
    Write-Host "         If installed previously, run: claude mcp remove wood-fired-bugs --scope user" -ForegroundColor Yellow
}

# ── 3. Remove tasks.cmd ──────────────────────────────────────────────────────
Write-Host ""
Write-Host "Removing tasks CLI..." -ForegroundColor Yellow

$TasksCmd = Join-Path $BinDir "tasks.cmd"
if (Test-Path $TasksCmd) {
    Remove-Item -Path $TasksCmd -Force
    Write-Host "OK: Removed $TasksCmd" -ForegroundColor Green
} else {
    Write-Host "OK: tasks.cmd not found (already removed)" -ForegroundColor Green
}

# ── 4. Remove bin dir from user PATH ─────────────────────────────────────────
Write-Host ""
Write-Host "Cleaning up PATH..." -ForegroundColor Yellow

$UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($UserPath -like "*$BinDir*") {
    # Remove the bin dir entry (and any trailing/leading semicolons)
    $NewPath = ($UserPath -split ";" | Where-Object { $_ -ne $BinDir }) -join ";"
    [Environment]::SetEnvironmentVariable("Path", $NewPath, "User")
    Write-Host "OK: Removed $BinDir from user PATH" -ForegroundColor Green
} else {
    Write-Host "OK: bin directory not in PATH (already removed)" -ForegroundColor Green
}

# ── 5. Done ──────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "Uninstall complete!" -ForegroundColor Green
Write-Host ""
Write-Host "You can now safely delete this folder." -ForegroundColor Cyan
Write-Host "Restart Claude Code for MCP changes to take effect." -ForegroundColor Cyan
Write-Host ""
