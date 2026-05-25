#Requires -Version 5.1
<#
.SYNOPSIS
    Wood Fired Tasks client setup script for Windows.

.DESCRIPTION
    Configures Claude Code on this machine to connect to the Wood Fired Tasks
    task management system running on the local network.

    API key resolution order (most secure first):
      1. -ApiKey parameter (DEPRECATED -- leaks via shell history and Get-Process)
      2. WFT_API_KEY environment variable
      3. Per-user secret file ($env:LOCALAPPDATA\wood-fired-tasks\api-key)
      4. Masked interactive prompt

    This script:
    - Copies the /tasks: skill files to your Claude Code commands directory
    - Configures the Wood Fired Tasks MCP server in Claude Code settings
    - Stores the API key in a per-user secret file (user-only ACL) so the
      generated tasks.cmd wrapper never embeds the key in cleartext
    - Validates that Node.js 18+ is installed

.PARAMETER ServerUrl
    Base URL of the Wood Fired Tasks backend server.
    Default: http://localhost:3000
    Override with -ServerUrl or the WFT_API_URL env var when the backend
    runs on a different host.

.PARAMETER ApiKey
    API key for authenticating with the Wood Fired Tasks backend.
    DEPRECATED -- prefer WFT_API_KEY env var, the secret file, or the prompt.

.EXAMPLE
    # Recommended: set the env var first, then run with no key on argv.
    $env:WFT_API_KEY = "your-api-key-here"
    .\setup.ps1

.EXAMPLE
    .\setup.ps1 -ServerUrl "http://192.0.2.100:3000"
#>

param(
    [string]$ServerUrl = $(if ($env:WFT_API_URL) { $env:WFT_API_URL } else { "http://localhost:3000" }),
    [string]$ApiKey
)

$ErrorActionPreference = "Stop"
$ApiKeyFromArgv = $PSBoundParameters.ContainsKey('ApiKey') -and -not [string]::IsNullOrWhiteSpace($ApiKey)

# Per-user secret file. Stored under LOCALAPPDATA (machine-local, not roamed)
# with a user-only ACL applied via icacls.
$SecretDir = if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA "wood-fired-tasks" } else { Join-Path $env:USERPROFILE ".wood-fired-tasks" }
$SecretFile = Join-Path $SecretDir "api-key"

function Set-UserOnlyAcl {
    param([string]$Path)
    if (-not (Test-Path $Path)) { return }
    try {
        & icacls $Path /inheritance:r /grant:r "$($env:USERNAME):(R,W)" 2>$null | Out-Null
    } catch {
        Write-Host "[WARN] Could not tighten ACL on $Path : $_" -ForegroundColor Yellow
    }
}

Write-Host ""
Write-Host "Wood Fired Tasks - Client Setup" -ForegroundColor Cyan
Write-Host "================================" -ForegroundColor Cyan
Write-Host ""

# Resolve the package directory (where this script lives)
$PackageDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$McpServerPath = Join-Path $PackageDir "mcp-server"

Write-Host "Package directory: $PackageDir"
Write-Host "MCP server path:   $McpServerPath"
Write-Host ""

# ── 0. Resolve API key ───────────────────────────────────────────────────────
if ($ApiKeyFromArgv) {
    Write-Host "[WARN] -ApiKey on the command line is DEPRECATED." -ForegroundColor Yellow
    Write-Host "[WARN] Command-line secrets leak via shell history and Get-Process." -ForegroundColor Yellow
    Write-Host "[WARN] Prefer the WFT_API_KEY env var, the secret file ($SecretFile)," -ForegroundColor Yellow
    Write-Host "[WARN] or the interactive prompt. This flag will be removed in a future release." -ForegroundColor Yellow
}

if (-not $ApiKey) {
    if ($env:WFT_API_KEY) {
        $ApiKey = $env:WFT_API_KEY
        Write-Host "[INFO] Using API key from WFT_API_KEY environment variable" -ForegroundColor Yellow
    } elseif (Test-Path $SecretFile) {
        $acl = Get-Acl $SecretFile
        $foreignAce = $acl.Access | Where-Object {
            $_.IdentityReference.Value -notmatch [Regex]::Escape($env:USERNAME) -and
            $_.IdentityReference.Value -notmatch 'SYSTEM' -and
            $_.IdentityReference.Value -notmatch 'Administrators'
        }
        if ($foreignAce) {
            Write-Host "[WARN] Secret file $SecretFile has loose ACL; ignoring." -ForegroundColor Yellow
            Write-Host "[WARN] Run: icacls `"$SecretFile`" /inheritance:r /grant:r `"$($env:USERNAME):(R,W)`"" -ForegroundColor Yellow
        } else {
            $ApiKey = (Get-Content -Path $SecretFile -Raw).Trim()
            if ($ApiKey) {
                Write-Host "[INFO] Using API key from $SecretFile" -ForegroundColor Yellow
            }
        }
    }
    if (-not $ApiKey) {
        $secureKey = Read-Host "Enter Wood Fired Tasks API key" -AsSecureString
        $bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
        try {
            $ApiKey = [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
        } finally {
            [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
        }
    }
}

if ([string]::IsNullOrWhiteSpace($ApiKey)) {
    Write-Host "ERROR: API key is required." -ForegroundColor Red
    Write-Host "Set WFT_API_KEY, populate $SecretFile, or supply it at the prompt." -ForegroundColor Red
    exit 1
}

# Cache the key in the per-user secret file (user-only ACL) so subsequent runs
# don't need argv/env, and so the generated tasks.cmd wrapper can read it at
# runtime instead of embedding the key in cleartext.
if (-not (Test-Path $SecretDir)) {
    New-Item -ItemType Directory -Path $SecretDir -Force | Out-Null
}
Set-Content -Path $SecretFile -Value $ApiKey -Encoding UTF8 -NoNewline
Set-UserOnlyAcl -Path $SecretFile

$maskedKey = $ApiKey.Substring(0, [Math]::Min(4, $ApiKey.Length)) + ("*" * [Math]::Max(0, $ApiKey.Length - 4))
Write-Host "OK: API key cached at $SecretFile ($maskedKey, user-only ACL)" -ForegroundColor Green
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
& claude mcp remove wood-fired-tasks --scope user 2>&1 | Out-Null

& claude mcp add wood-fired-tasks `
    --scope user `
    -e "WFT_API_URL=$ServerUrl" `
    -e "WFT_API_KEY=$ApiKey" `
    -- node $McpEntryPoint
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: 'claude mcp add' failed (exit code $LASTEXITCODE)." -ForegroundColor Red
    exit 1
}
# claude mcp add writes the API key into ~/.claude.json. Tighten its ACL.
$ClaudeConfig = Join-Path $env:USERPROFILE ".claude.json"
Set-UserOnlyAcl -Path $ClaudeConfig
Write-Host "OK: Registered wood-fired-tasks at user scope (~/.claude.json, user-only ACL)" -ForegroundColor Green

# ── 5. Install tasks CLI to PATH ────────────────────────────────────────────
Write-Host ""
Write-Host "Installing tasks CLI..." -ForegroundColor Yellow

$BinDir = Join-Path $PackageDir "bin"
if (-not (Test-Path $BinDir)) {
    New-Item -ItemType Directory -Path $BinDir -Force | Out-Null
}

# Create tasks.cmd wrapper.
# IMPORTANT: do NOT embed the API key in this file. The wrapper reads it from
# the per-user secret file at runtime. The secret file has a user-only ACL,
# and the wrapper itself contains no secrets and is safe to leave on PATH.
$CliEntryPoint = Join-Path $McpServerPath "dist\cli\bin\tasks-client.js"
$TasksCmd = Join-Path $BinDir "tasks.cmd"

# Use single-quoted here-string ($SecretFile expanded by PowerShell;
# %API_KEY%/%API_BASE_URL% are cmd.exe-time variables we never want to expand here).
$wrapper = @"
@echo off
setlocal
set "API_BASE_URL=$ServerUrl"
if not defined WFT_API_KEY (
    if exist "$SecretFile" (
        for /f "usebackq delims=" %%K in ("$SecretFile") do set "WFT_API_KEY=%%K"
    )
)
if not defined WFT_API_KEY (
    echo ERROR: Wood Fired Tasks API key not found.
    echo Set WFT_API_KEY, populate $SecretFile, or re-run setup.ps1.
    exit /b 1
)
set "API_KEY=%WFT_API_KEY%"
node "$CliEntryPoint" %*
"@
$wrapper | Set-Content -Path $TasksCmd -Encoding ASCII
# Wrapper carries no secrets, but lock down its ACL anyway so a hostile
# co-tenant can't modify it to exfiltrate the key it loads at runtime.
Set-UserOnlyAcl -Path $TasksCmd

# Add bin dir to user PATH if not already there
$UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($UserPath -notlike "*$BinDir*") {
    [Environment]::SetEnvironmentVariable("Path", "$UserPath;$BinDir", "User")
    Write-Host "OK: Added $BinDir to user PATH" -ForegroundColor Green
    Write-Host "    (Open a new terminal for PATH to take effect)" -ForegroundColor Yellow
} else {
    Write-Host "OK: $BinDir already in PATH" -ForegroundColor Green
}

Write-Host "OK: tasks CLI installed (reads key from $SecretFile at runtime)" -ForegroundColor Green

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
