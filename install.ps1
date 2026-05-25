#!/usr/bin/env pwsh
# Wood Fired Tasks - Claude Code Skills Installer (Windows PowerShell)
# Installs skill files and configures MCP server integration

[CmdletBinding()]
param(
    [Parameter(Mandatory=$false)]
    [ValidateSet('local', 'remote')]
    [string]$Mode = 'local',

    [Parameter(Mandatory=$false)]
    [string]$ApiKey,

    # Skip the existing-config confirmation prompt and overwrite the MCP entry
    # unconditionally. Without -Force, a re-run that finds an existing MCP
    # entry is non-destructive: the installer preserves the entry untouched
    # unless explicit -Mode/-ApiKey/env-var input was supplied (in which case
    # the user is prompted to confirm).
    [Parameter(Mandatory=$false)]
    [switch]$Force
)

$ErrorActionPreference = "Stop"

# Script-scoped variables
$script:BackupFile = $null
$script:ApiKeyFromArgv = $PSBoundParameters.ContainsKey('ApiKey') -and -not [string]::IsNullOrWhiteSpace($ApiKey)
# Was -Mode supplied explicitly (vs. relying on the default 'local')? Used
# alongside env-var checks to decide whether the user signalled an intent to
# change the configuration.
$script:ModeExplicit = $PSBoundParameters.ContainsKey('Mode')

# Constants
$ScriptDir = $PSScriptRoot
$ConfigFile = Join-Path $env:USERPROFILE ".claude.json"
$SkillsSource = Join-Path $ScriptDir "skills" "tasks"
$SkillsDest = Join-Path $env:USERPROFILE ".claude" "commands" "tasks"
# Wave 2.1 (task #314): subagent definitions distributed alongside the
# /tasks:* slash commands. Mirrors the SKILLS_AGENT_SOURCE/DEST pair in
# install.sh. Missing or empty directory is logged + skipped, never fatal.
$SkillsAgentSource = Join-Path $ScriptDir "skills" "agents"
$SkillsAgentDest = Join-Path $env:USERPROFILE ".claude" "agents"
$ServiceUrl = if ($env:WOOD_FIRED_TASKS_URL) { $env:WOOD_FIRED_TASKS_URL } else { "http://localhost:3000" }

# Per-user secret file for the API key. Stored under LOCALAPPDATA so it
# stays on the local machine (not roamed) and inherits a user-only ACL once
# we lock it down with icacls.
$SecretDir = if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA "wood-fired-tasks" } else { Join-Path $env:USERPROFILE ".wood-fired-tasks" }
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
    Write-Host "`n[INFO] Wood Fired Tasks Claude Code Installer" -ForegroundColor Cyan
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
    # Step 2: Resolve install mode and (if remote) the API key
    # ============================================================================
    Write-Host "`n[INFO] Install mode: $Mode" -ForegroundColor Cyan

    # Determine the MCP server name we'd install under. Local and remote
    # modes use different keys so both can coexist in ~/.claude.json.
    if ($Mode -eq 'local') {
        $serverName = 'wood-fired-tasks'
    } else {
        $serverName = 'wood-fired-tasks-remote'
    }

    # Count any explicit user intent to change configuration. Presence (not
    # value) is what matters here — if the user supplied an env var or flag,
    # they are signalling "please reconfigure this".
    $urlFromEnv    = [bool]$env:WOOD_FIRED_TASKS_URL
    $apiKeyFromEnv = [bool]$env:WOOD_FIRED_TASKS_API_KEY
    $anyExplicit   = $script:ModeExplicit -or $urlFromEnv -or $script:ApiKeyFromArgv -or $apiKeyFromEnv

    # Inspect the existing config (if any) for an entry matching $serverName.
    $script:PreserveExisting = $false
    $existingEntry = $null
    if (Test-Path $ConfigFile) {
        try {
            $rawConfig = Get-Content -Path $ConfigFile -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
            if ($rawConfig -and (Get-Member -InputObject $rawConfig -Name 'mcpServers' -MemberType Properties)) {
                if (Get-Member -InputObject $rawConfig.mcpServers -Name $serverName -MemberType Properties -ErrorAction SilentlyContinue) {
                    $existingEntry = $rawConfig.mcpServers.$serverName
                }
            }
        } catch {
            # Treat unreadable / non-JSON config the same as "no existing entry"
            # — the merge step below will recreate it.
            $existingEntry = $null
        }
    }

    if ($existingEntry) {
        if ($Force) {
            Write-Host "[WARN] -Force specified — existing '$serverName' MCP entry will be overwritten." -ForegroundColor Yellow
        } elseif (-not $anyExplicit) {
            $script:PreserveExisting = $true
            Write-Host "[OK] Existing '$serverName' MCP entry detected — preserving it (no flags supplied)." -ForegroundColor Green
            Write-Host "[INFO] Re-run with -Force, or with explicit -Mode/-ApiKey/`$env:WOOD_FIRED_TASKS_URL/" -ForegroundColor Yellow
            Write-Host "       `$env:WOOD_FIRED_TASKS_API_KEY, to intentionally change the entry." -ForegroundColor Yellow
        } else {
            Write-Host ""
            Write-Host "[WARN] An MCP entry for '$serverName' is already configured in ${ConfigFile}:" -ForegroundColor Yellow
            Write-Host "----- existing entry -----" -ForegroundColor Yellow
            $existingEntry | ConvertTo-Json -Depth 10 | Write-Host
            Write-Host "--------------------------" -ForegroundColor Yellow
            Write-Host ""
            Write-Host "Explicit arguments or environment variables were supplied that would change" -ForegroundColor Yellow
            Write-Host "this entry. Continuing will overwrite the configuration shown above." -ForegroundColor Yellow

            # Try Read-Host; if PowerShell is running in -NonInteractive mode
            # or stdin is unavailable (service / unattended context), the call
            # throws — treat that as a refusal. We don't rely on
            # [Environment]::UserInteractive because it returns true under
            # pwsh -NonInteractive on Linux/macOS.
            $confirm = $null
            try {
                $confirm = Read-Host "Overwrite the existing '$serverName' configuration? [y/N]"
            } catch {
                Write-Host "[WARN] Non-interactive session — refusing to overwrite without -Force." -ForegroundColor Yellow
                $confirm = 'n'
            }
            if ($confirm -match '^(y|yes)$') {
                Write-Host "[INFO] Proceeding with overwrite." -ForegroundColor Yellow
            } else {
                $script:PreserveExisting = $true
                Write-Host "[INFO] Keeping existing configuration." -ForegroundColor Green
            }
        }
    }

    if ($script:PreserveExisting) {
        # Skip API key collection entirely — we are not going to write a new
        # MCP entry, so there is nothing to feed the key into.
        if ($script:ApiKeyFromArgv -or $apiKeyFromEnv) {
            Write-Host "[INFO] Ignoring supplied API key — preserving existing MCP entry, not rewriting." -ForegroundColor Yellow
        }
        $ApiKey = $null
    } elseif ($Mode -eq 'local') {
        # Local mode: silently ignore any API-key inputs. The local MCP server
        # reads DATABASE_PATH and never reads WFT_API_KEY /
        # WOOD_FIRED_TASKS_API_KEY, so keeping a key in ~/.claude.json would
        # be dead weight (and a leak surface). Task #258.
        if ($script:ApiKeyFromArgv -or $env:WOOD_FIRED_TASKS_API_KEY) {
            Write-Host "[INFO] Ignoring API key input — local mode does not use one." -ForegroundColor Yellow
        }
        $ApiKey = $null
    } else {
        Write-Host "`n[INFO] API Key Configuration (remote mode)" -ForegroundColor Cyan

        if ($script:ApiKeyFromArgv) {
            Write-Host "[WARN] -ApiKey on the command line is DEPRECATED." -ForegroundColor Yellow
            Write-Host "[WARN] Command-line secrets leak via shell history and process listings (Get-Process,wmic)." -ForegroundColor Yellow
            Write-Host "[WARN] Prefer the WOOD_FIRED_TASKS_API_KEY env var, the secret file ($SecretFile)," -ForegroundColor Yellow
            Write-Host "[WARN] or the interactive prompt. This flag will be removed in a future release." -ForegroundColor Yellow
        }

        # Resolution order: -ApiKey > env > secret file > interactive prompt
        if (-not $ApiKey) {
            if ($env:WOOD_FIRED_TASKS_API_KEY) {
                $ApiKey = $env:WOOD_FIRED_TASKS_API_KEY
                Write-Host "[INFO] Using API key from WOOD_FIRED_TASKS_API_KEY environment variable" -ForegroundColor Yellow
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
                $secureKey = Read-Host "Enter Wood Fired Tasks API key" -AsSecureString
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
            Write-Error "API key is required in -Mode remote. Please provide a valid API key."
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
    }

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

    # ----------------------------------------------------------------------------
    # Step 3b: Copy subagent definitions (task #314, Wave 2.1)
    # ----------------------------------------------------------------------------
    # Mirrors the skill-file loop above but targets ~/.claude/agents/.
    # Defensive: missing or empty directory is logged + skipped, never fatal.
    $agentCopiedCount = 0
    if (-not (Test-Path $SkillsAgentSource)) {
        Write-Host "`n[INFO] No subagent source directory at $SkillsAgentSource — skipping agent install" -ForegroundColor Yellow
    } else {
        $agentFiles = Get-ChildItem -Path $SkillsAgentSource -Filter "*.md" | Where-Object { $_.Name -ne "README.md" }
        if ($agentFiles.Count -eq 0) {
            Write-Host "`n[INFO] No subagent files (*.md) in $SkillsAgentSource — skipping agent install" -ForegroundColor Yellow
        } else {
            Write-Host "`n[INFO] Installing subagent definitions..." -ForegroundColor Cyan
            if (-not (Test-Path $SkillsAgentDest)) {
                New-Item -ItemType Directory -Force -Path $SkillsAgentDest | Out-Null
                Write-Host "[INFO] Created directory: $SkillsAgentDest" -ForegroundColor Yellow
            }
            foreach ($file in $agentFiles) {
                $dest = Join-Path $SkillsAgentDest $file.Name
                if (-not (Test-Path $dest) -or $file.LastWriteTime -gt (Get-Item $dest).LastWriteTime) {
                    Copy-Item $file.FullName $dest -Force
                    $agentCopiedCount++
                }
            }
            if ($agentCopiedCount -gt 0) {
                Write-Host "[OK] Copied $agentCopiedCount subagent definition(s) to $SkillsAgentDest" -ForegroundColor Green
            } else {
                Write-Host "[OK] All subagent definitions are up to date" -ForegroundColor Green
            }
        }
    }

    # ============================================================================
    # Step 4: Backup existing config (WIN-04)
    # ============================================================================
    if ($script:PreserveExisting) {
        Write-Host "`n[INFO] Skipping configuration backup — preserving existing MCP entry, no edits will be made." -ForegroundColor Yellow
    } else {
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
    }

    # ============================================================================
    # Step 5: Merge MCP server config (WIN-02, WIN-03)
    # ============================================================================
    if ($script:PreserveExisting) {
        Write-Host "[OK] MCP server '$serverName' left untouched in $ConfigFile" -ForegroundColor Green
    } else {
        Write-Host "[INFO] Configuring MCP server..." -ForegroundColor Cyan

        # Read existing config
        $config = Get-Content $ConfigFile -Raw | ConvertFrom-Json

        # Build new server config — local writes only DATABASE_PATH, remote writes
        # WFT_API_URL + WFT_API_KEY under a separate server name so both can
        # coexist. Task #258.
        #
        # Use absolute paths for args + DATABASE_PATH. Claude Code's MCP config
        # schema does not honor a `cwd` key (`claude mcp add` has no --cwd flag);
        # the server is launched from Claude Code's CWD, so any relative path
        # resolves against the wrong directory and node exits with
        # "Cannot find module ...".
        if ($Mode -eq 'local') {
            $newServer = [PSCustomObject]@{
                command = "node"
                args = @((Join-Path $ScriptDir 'dist/mcp/index.js'))
                env = [PSCustomObject]@{
                    DATABASE_PATH = (Join-Path $ScriptDir 'data/tasks.db')
                }
            }
        } else {
            $newServer = [PSCustomObject]@{
                command = "node"
                args = @((Join-Path $ScriptDir 'dist/mcp/remote/index.js'))
                env = [PSCustomObject]@{
                    WFT_API_URL = $ServiceUrl
                    WFT_API_KEY = $ApiKey
                }
            }
        }

        # Ensure mcpServers property exists
        if (-not (Get-Member -InputObject $config -Name "mcpServers" -MemberType Properties)) {
            $config | Add-Member -MemberType NoteProperty -Name "mcpServers" -Value ([PSCustomObject]@{})
        }

        # Add or update server entry (Add-Member -Force handles idempotency)
        $config.mcpServers | Add-Member -MemberType NoteProperty -Name $serverName -Value $newServer -Force

        # Write back with proper depth (PowerShell defaults to depth 2, we need 10)
        $config | ConvertTo-Json -Depth 10 | Set-Content $ConfigFile -Encoding UTF8
        # Re-apply the user-only ACL after every write (Set-Content can recreate
        # the file and lose the previous ACL). The file may contain the API key
        # in remote mode, and may contain pre-existing secrets either way.
        Set-UserOnlyAcl -Path $ConfigFile

        Write-Host "[OK] MCP server '$serverName' configured (user-only ACL)" -ForegroundColor Green
    }

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
    Write-Host "  - Install mode: $Mode"
    Write-Host "  - Skill files:  $skillCount file(s) -> $SkillsDest"
    Write-Host "  - Subagents:    $agentCopiedCount file(s) -> $SkillsAgentDest"
    if ($script:PreserveExisting) {
        Write-Host "  - MCP server:   '$serverName' PRESERVED in $ConfigFile (no changes written)"
    } else {
        Write-Host "  - MCP server:   $serverName -> $ConfigFile"
    }
    if ($script:PreserveExisting) {
        Write-Host "  - API key:      Untouched (existing entry preserved)"
    } elseif ($Mode -eq 'remote') {
        Write-Host "  - API key:      Configured in MCP environment (WFT_API_KEY)"
    } else {
        Write-Host "  - API key:      Not used in local mode"
    }
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
