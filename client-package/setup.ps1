#Requires -Version 5.1
<#
.SYNOPSIS
    Wood Fired Bugs client setup script for Windows.

.DESCRIPTION
    Configures Claude Code on this machine to connect to the Wood Fired Bugs
    task management system running on the local network.

    This script:
    - Copies the /tasks: skill files to your Claude Code commands directory
    - Configures the Wood Fired Bugs MCP server in Claude Code settings
    - Validates that Node.js 18+ is installed

.PARAMETER ServerUrl
    Base URL of the Wood Fired Bugs backend server.
    Default: http://192.168.69.69:3000

.PARAMETER ApiKey
    API key for authenticating with the Wood Fired Bugs backend.
    Required.

.EXAMPLE
    .\setup.ps1 -ApiKey "your-api-key-here"

.EXAMPLE
    .\setup.ps1 -ServerUrl "http://192.168.1.100:3000" -ApiKey "your-api-key-here"
#>

param(
    [string]$ServerUrl = "http://192.168.69.69:3000",
    [Parameter(Mandatory=$true)]
    [string]$ApiKey
)

$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "Wood Fired Bugs - Client Setup" -ForegroundColor Cyan
Write-Host "================================" -ForegroundColor Cyan
Write-Host ""

# Resolve the package directory (where this script lives)
$PackageDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$McpServerPath = Join-Path $PackageDir "mcp-server"

Write-Host "Package directory: $PackageDir"
Write-Host "MCP server path:   $McpServerPath"
Write-Host ""

# ── 1. Check Node.js ────────────────────────────────────────────────────────
Write-Host "Checking Node.js installation..." -ForegroundColor Yellow

try {
    $nodeVersion = & node --version 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "node command failed"
    }

    # Parse major version (e.g., "v20.11.0" -> 20)
    $majorVersion = [int]($nodeVersion -replace '^v(\d+)\..*', '$1')
    if ($majorVersion -lt 18) {
        Write-Host "ERROR: Node.js 18+ is required. Found: $nodeVersion" -ForegroundColor Red
        Write-Host "Download from https://nodejs.org/" -ForegroundColor Red
        exit 1
    }

    Write-Host "OK: Node.js $nodeVersion" -ForegroundColor Green
} catch {
    Write-Host "ERROR: Node.js 18+ is required but was not found." -ForegroundColor Red
    Write-Host "Download from https://nodejs.org/" -ForegroundColor Red
    exit 1
}

# ── 2. Verify MCP server exists ─────────────────────────────────────────────
$McpEntryPoint = Join-Path $McpServerPath "dist\mcp\remote\index.js"
if (-not (Test-Path $McpEntryPoint)) {
    Write-Host "ERROR: MCP server not found at: $McpEntryPoint" -ForegroundColor Red
    Write-Host "The package may be corrupted. Please re-download it." -ForegroundColor Red
    exit 1
}
Write-Host "OK: MCP server found" -ForegroundColor Green

# ── 3. Copy skill files ──────────────────────────────────────────────────────
Write-Host ""
Write-Host "Installing /tasks: skill files..." -ForegroundColor Yellow

$ClaudeCommandsDir = Join-Path $env:USERPROFILE ".claude\commands\tasks"
if (-not (Test-Path $ClaudeCommandsDir)) {
    New-Item -ItemType Directory -Path $ClaudeCommandsDir -Force | Out-Null
    Write-Host "Created directory: $ClaudeCommandsDir"
}

$SkillsSource = Join-Path $PackageDir "commands\tasks"
$SkillFiles = Get-ChildItem -Path $SkillsSource -Filter "*.md"
foreach ($file in $SkillFiles) {
    $dest = Join-Path $ClaudeCommandsDir $file.Name
    Copy-Item -Path $file.FullName -Destination $dest -Force
    Write-Host "  Installed: $($file.Name)" -ForegroundColor Green
}

Write-Host "OK: Installed $($SkillFiles.Count) skill files" -ForegroundColor Green

# ── 4. Register MCP server with Claude Code ─────────────────────────────────
Write-Host ""
Write-Host "Registering MCP server with Claude Code..." -ForegroundColor Yellow

if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
    Write-Host "ERROR: 'claude' CLI not found on PATH." -ForegroundColor Red
    Write-Host "Install Claude Code from https://claude.ai/claude-code and reopen this terminal." -ForegroundColor Red
    exit 1
}

# Remove any prior user-scope entry so re-running setup is idempotent.
# 'claude mcp remove' exits non-zero when the entry is absent — that's fine.
& claude mcp remove wood-fired-bugs --scope user 2>&1 | Out-Null

& claude mcp add wood-fired-bugs `
    --scope user `
    -e "WFB_API_URL=$ServerUrl" `
    -e "WFB_API_KEY=$ApiKey" `
    -- node $McpEntryPoint
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: 'claude mcp add' failed (exit code $LASTEXITCODE)." -ForegroundColor Red
    exit 1
}
Write-Host "OK: Registered wood-fired-bugs at user scope (~/.claude.json)" -ForegroundColor Green

# ── 5. Install tasks CLI to PATH ────────────────────────────────────────────
Write-Host ""
Write-Host "Installing tasks CLI..." -ForegroundColor Yellow

$BinDir = Join-Path $PackageDir "bin"
if (-not (Test-Path $BinDir)) {
    New-Item -ItemType Directory -Path $BinDir -Force | Out-Null
}

# Create tasks.cmd wrapper that sets env vars and runs the CLI
$CliEntryPoint = Join-Path $McpServerPath "dist\cli\bin\tasks-client.js"
$TasksCmd = Join-Path $BinDir "tasks.cmd"
@"
@echo off
set "API_BASE_URL=$ServerUrl"
set "API_KEY=$ApiKey"
node "$CliEntryPoint" %*
"@ | Set-Content -Path $TasksCmd -Encoding ASCII

# Add bin dir to user PATH if not already there
$UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($UserPath -notlike "*$BinDir*") {
    [Environment]::SetEnvironmentVariable("Path", "$UserPath;$BinDir", "User")
    Write-Host "OK: Added $BinDir to user PATH" -ForegroundColor Green
    Write-Host "    (Open a new terminal for PATH to take effect)" -ForegroundColor Yellow
} else {
    Write-Host "OK: $BinDir already in PATH" -ForegroundColor Green
}

Write-Host "OK: tasks CLI installed" -ForegroundColor Green

# ── 6. Done ─────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "Setup complete!" -ForegroundColor Green
Write-Host ""
Write-Host "Open a NEW terminal, then try:" -ForegroundColor Cyan
Write-Host "  tasks list             List all tasks" -ForegroundColor White
Write-Host "  tasks show 1           Show task details" -ForegroundColor White
Write-Host "  tasks create           Create a task interactively" -ForegroundColor White
Write-Host ""
Write-Host "In Claude Code, try:" -ForegroundColor Cyan
Write-Host "  /tasks:my-work" -ForegroundColor White
Write-Host ""
Write-Host "Available /tasks: commands:" -ForegroundColor Cyan
Write-Host "  /tasks:create-task    Create a new task"
Write-Host "  /tasks:my-work        List your assigned tasks"
Write-Host "  /tasks:pick-up        Pick up a task to work on"
Write-Host "  /tasks:done           Mark a task as done"
Write-Host "  /tasks:search         Search tasks by keyword"
Write-Host "  /tasks:show-task      Show full task details"
Write-Host "  /tasks:log-bug        Log a bug report"
Write-Host "  /tasks:add-comment    Add a comment to a task"
Write-Host "  /tasks:blocked        Mark a task as blocked"
Write-Host "  /tasks:project-status View project status overview"
Write-Host ""
