#!/usr/bin/env pwsh
# Wood Fired Bugs - Claude Code Skills Installer (Windows PowerShell)
# Installs skill files and configures MCP server integration

[CmdletBinding()]
param(
    [Parameter(Mandatory=$false)]
    [string]$ApiKey
)

$ErrorActionPreference = "Stop"

# Script-scoped variables
$script:BackupFile = $null
$script:ApiKeyFromArgv = $PSBoundParameters.ContainsKey('ApiKey') -and -not [string]::IsNullOrWhiteSpace($ApiKey)

# Constants
$ScriptDir = $PSScriptRoot
$ConfigFile = Join-Path $env:USERPROFILE ".claude.json"
$SkillsSource = Join-Path $ScriptDir "skills" "tasks"
$SkillsDest = Join-Path $env:USERPROFILE ".claude" "commands" "tasks"
$ServiceUrl = if ($env:WOOD_FIRED_BUGS_URL) { $env:WOOD_FIRED_BUGS_URL } else { "http://localhost:3000" }

# Per-user secret file for the API key. Stored under LOCALAPPDATA so it
# stays on the local machine (not roamed) and inherits a user-only ACL once
# we lock it down with icacls.
$SecretDir = if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA "wood-fired-bugs" } else { Join-Path $env:USERPROFILE ".wood-fired-bugs" }
$SecretFile = Join-Path $SecretDir "api-key"

# Restrict the ACL on a file to the current user only.
# Removes inheritance and grants Read+Write to the current SID.
function Set-UserOnlyAcl {
    param([string]$Path)
    if (-not (Test-Path $Path)) { return }
    try {
        # /inheritance:r — strip inherited ACEs
        # /grant:r — replace any existing user ACE with the new one
        # Wrap in stderr redirection so icacls output doesn't pollute the log.
        & icacls $Path /inheritance:r /grant:r "$($env:USERNAME):(R,W)" 2>$null | Out-Null
    } catch {
        Write-Host "[WARN] Could not tighten ACL on $Path : $_" -ForegroundColor Yellow
    }
}

try {
    Write-Host "`n[INFO] Wood Fired Bugs Claude Code Installer" -ForegroundColor Cyan
    Write-Host "=" * 60 -ForegroundColor Cyan

    # ============================================================================
    # Step 1: Check prerequisites
    # ============================================================================
    Write-Host "`n[INFO] Checking prerequisites..." -ForegroundColor Cyan

    # Check for node
    $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
    if (-not $nodeCmd) {
        Write-Error "Node.js is not installed or not in PATH. Please install Node.js and try again."
        exit 1
    }
    Write-Host "[OK] Node.js found: $($nodeCmd.Version)" -ForegroundColor Green

    # Verify skills source directory exists
    if (-not (Test-Path $SkillsSource)) {
        Write-Error "Skills directory not found at: $SkillsSource"
        exit 1
    }

    # Count skill files
    $skillFiles = Get-ChildItem -Path $SkillsSource -Filter "*.md"
    $skillCount = $skillFiles.Count
    Write-Host "[OK] Found $skillCount skill files" -ForegroundColor Green

    # ============================================================================
    # Step 2: Resolve API key
    # ============================================================================
    Write-Host "`n[INFO] API Key Configuration" -ForegroundColor Cyan

    if ($script:ApiKeyFromArgv) {
        Write-Host "[WARN] -ApiKey on the command line is DEPRECATED." -ForegroundColor Yellow
        Write-Host "[WARN] Command-line secrets leak via shell history and process listings (Get-Process,wmic)." -ForegroundColor Yellow
        Write-Host "[WARN] Prefer the WOOD_FIRED_BUGS_API_KEY env var, the secret file ($SecretFile)," -ForegroundColor Yellow
        Write-Host "[WARN] or the interactive prompt. This flag will be removed in a future release." -ForegroundColor Yellow
    }

    # Resolution order: -ApiKey > env > secret file > interactive prompt
    if (-not $ApiKey) {
        if ($env:WOOD_FIRED_BUGS_API_KEY) {
            $ApiKey = $env:WOOD_FIRED_BUGS_API_KEY
            Write-Host "[INFO] Using API key from WOOD_FIRED_BUGS_API_KEY environment variable" -ForegroundColor Yellow
        } elseif (Test-Path $SecretFile) {
            # Only honor the secret file if it isn't accessible to anyone except the current user.
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
            $secureKey = Read-Host "Enter Wood Fired Bugs API key" -AsSecureString
            $bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
            try {
                $ApiKey = [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
            } finally {
                [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
            }
        }
    }

    # Validate key is non-empty
    if ([string]::IsNullOrWhiteSpace($ApiKey)) {
        Write-Error "API key is required. Please provide a valid API key."
        exit 1
    }

    # Persist to per-user secret file with restrictive ACL so re-runs can drop argv.
    if (-not (Test-Path $SecretDir)) {
        New-Item -ItemType Directory -Path $SecretDir -Force | Out-Null
    }
    Set-Content -Path $SecretFile -Value $ApiKey -Encoding UTF8 -NoNewline
    Set-UserOnlyAcl -Path $SecretFile

    # Print masked confirmation
    $maskedKey = $ApiKey.Substring(0, [Math]::Min(4, $ApiKey.Length)) + ("*" * [Math]::Max(0, $ApiKey.Length - 4))
    Write-Host "[OK] API key configured: $maskedKey" -ForegroundColor Green
    Write-Host "[OK] API key cached at $SecretFile (user-only ACL)" -ForegroundColor Green

    # ============================================================================
    # Step 3: Copy skill files (WIN-01)
    # ============================================================================
    Write-Host "`n[INFO] Installing skill files..." -ForegroundColor Cyan

    # Create destination directory if it doesn't exist
    if (-not (Test-Path $SkillsDest)) {
        New-Item -ItemType Directory -Force -Path $SkillsDest | Out-Null
        Write-Host "[INFO] Created directory: $SkillsDest" -ForegroundColor Yellow
    }

    # Copy skill files (idempotent - only if newer or missing)
    $copiedCount = 0
    foreach ($file in $skillFiles) {
        $dest = Join-Path $SkillsDest $file.Name
        if (-not (Test-Path $dest) -or $file.LastWriteTime -gt (Get-Item $dest).LastWriteTime) {
            Copy-Item $file.FullName $dest -Force
            $copiedCount++
        }
    }

    if ($copiedCount -gt 0) {
        Write-Host "[OK] Copied $copiedCount skill file(s) to $SkillsDest" -ForegroundColor Green
    } else {
        Write-Host "[OK] All skill files are up to date" -ForegroundColor Green
    }

    # ============================================================================
    # Step 4: Backup existing config (WIN-04)
    # ============================================================================
    Write-Host "`n[INFO] Managing configuration..." -ForegroundColor Cyan

    if (Test-Path $ConfigFile) {
        # Create timestamped backup. Backup contains the API key in cleartext,
        # so lock the ACL down to the current user before anything else can read it.
        $timestamp = Get-Date -Format "yyyyMMdd_HHmmss"
        $script:BackupFile = "$ConfigFile.backup.$timestamp"
        Copy-Item $ConfigFile $script:BackupFile
        Set-UserOnlyAcl -Path $script:BackupFile
        # Re-tighten the config itself in case a previous installer or hand-edit relaxed it.
        Set-UserOnlyAcl -Path $ConfigFile
        Write-Host "[OK] Backed up existing config to: $script:BackupFile (user-only ACL)" -ForegroundColor Green
    } else {
        # Create new config file with empty JSON object, then lock its ACL.
        "{}" | Set-Content $ConfigFile -Encoding UTF8
        Set-UserOnlyAcl -Path $ConfigFile
        Write-Host "[INFO] Created new config file: $ConfigFile" -ForegroundColor Yellow
    }

    # ============================================================================
    # Step 5: Merge MCP server config (WIN-02, WIN-03)
    # ============================================================================
    Write-Host "[INFO] Configuring MCP server..." -ForegroundColor Cyan

    # Read existing config
    $config = Get-Content $ConfigFile -Raw | ConvertFrom-Json

    # Build new server config
    $newServer = [PSCustomObject]@{
        command = "node"
        args = @("dist/mcp/index.js")
        cwd = $ScriptDir
        env = [PSCustomObject]@{
            WOOD_FIRED_BUGS_API_KEY = $ApiKey
            DATABASE_PATH = "./data/tasks.db"
        }
    }

    # Ensure mcpServers property exists
    if (-not (Get-Member -InputObject $config -Name "mcpServers" -MemberType Properties)) {
        $config | Add-Member -MemberType NoteProperty -Name "mcpServers" -Value ([PSCustomObject]@{})
    }

    # Add or update wood-fired-bugs server (Add-Member -Force handles idempotency)
    $config.mcpServers | Add-Member -MemberType NoteProperty -Name "wood-fired-bugs" -Value $newServer -Force

    # Write back with proper depth (PowerShell defaults to depth 2, we need 10)
    $config | ConvertTo-Json -Depth 10 | Set-Content $ConfigFile -Encoding UTF8
    # The file now contains the API key — re-apply the user-only ACL after every write
    # (Set-Content can recreate the file and lose the previous ACL).
    Set-UserOnlyAcl -Path $ConfigFile

    Write-Host "[OK] MCP server 'wood-fired-bugs' configured (user-only ACL)" -ForegroundColor Green

    # ============================================================================
    # Step 6: Validate connectivity (WIN-05)
    # ============================================================================
    Write-Host "`n[INFO] Validating service connectivity..." -ForegroundColor Cyan

    try {
        $healthUrl = "$ServiceUrl/health"
        $null = Invoke-WebRequest -Uri $healthUrl -TimeoutSec 5 -ErrorAction Stop
        Write-Host "[OK] Service reachable at $ServiceUrl" -ForegroundColor Green
    } catch {
        Write-Host "[WARN] Could not reach service at $ServiceUrl" -ForegroundColor Yellow
        Write-Host "[WARN] The service may not be running yet. Start it with: npm start" -ForegroundColor Yellow
    }

    Write-Host "`n[INFO] Restart Claude Code to apply configuration changes" -ForegroundColor Yellow

    # ============================================================================
    # Step 7: Summary
    # ============================================================================
    Write-Host "`n" -NoNewline
    Write-Host "=" * 60 -ForegroundColor Green
    Write-Host "[OK] Installation Complete!" -ForegroundColor Green
    Write-Host "=" * 60 -ForegroundColor Green

    Write-Host "`nWhat was installed:" -ForegroundColor Cyan
    Write-Host "  - Skill files:  $skillCount file(s) -> $SkillsDest"
    Write-Host "  - MCP server:   wood-fired-bugs -> $ConfigFile"
    Write-Host "  - API key:      Configured in MCP environment"
    if ($script:BackupFile) {
        Write-Host "  - Backup:       $script:BackupFile"
    }

    Write-Host "`nNext steps:" -ForegroundColor Cyan
    Write-Host "  1. Restart Claude Code to load the new configuration"
    Write-Host "  2. Start the service: npm start"
    Write-Host "  3. Run /tasks: in Claude Code to get started"

    Write-Host "`n[OK] Installation complete. Happy bug hunting!" -ForegroundColor Green

} catch {
    Write-Host "`n[ERROR] Installation failed: $_" -ForegroundColor Red

    # Restore backup if it exists
    if ($script:BackupFile -and (Test-Path $script:BackupFile)) {
        Write-Host "[INFO] Restoring configuration from backup..." -ForegroundColor Yellow
        Copy-Item $script:BackupFile $ConfigFile -Force
        Write-Host "[OK] Configuration restored" -ForegroundColor Green
    }

    Write-Host "`nPlease review the error above and try again." -ForegroundColor Red
    exit 1
}
