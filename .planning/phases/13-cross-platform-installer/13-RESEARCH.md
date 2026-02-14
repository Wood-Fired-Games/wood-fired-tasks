# Phase 13: Cross-Platform Installer - Research

**Researched:** 2026-02-13
**Domain:** Cross-platform shell scripting (Bash/PowerShell), JSON configuration management, installer automation
**Confidence:** MEDIUM

## Summary

Phase 13 requires creating cross-platform installers (Bash for Linux, PowerShell for Windows) that automate the setup of Claude Code skills and MCP server configuration. The installers must handle three critical operations: (1) copy skill files to the appropriate Claude Code directory, (2) safely merge MCP server configuration into existing Claude Code settings while preserving other servers, and (3) validate connectivity to the wood-fired-bugs service.

Key challenges include handling different configuration file locations across platforms (~/.claude.json on Linux, different behavior on Windows), safely merging JSON without breaking existing configurations, and implementing proper backup/rollback mechanisms for configuration changes.

The research reveals that both bash and PowerShell have mature ecosystems for these tasks: jq for JSON manipulation in bash, native ConvertFrom-Json/ConvertTo-Json in PowerShell, and established patterns for idempotent installers that can be run multiple times safely.

**Primary recommendation:** Use defensive scripting patterns (set -euo pipefail for bash, ErrorActionPreference Stop for PowerShell), implement atomic file operations with timestamped backups, and leverage jq for bash JSON merging and native PowerShell cmdlets for Windows JSON handling.

## Standard Stack

### Core Tools

| Tool | Version | Purpose | Why Standard |
|------|---------|---------|--------------|
| jq | 1.6+ | JSON parsing and merging in bash | Industry standard for JSON in shell scripts, ubiquitous on Linux |
| curl | Latest | HTTP endpoint validation | Universal HTTP client, available by default on all platforms |
| PowerShell | 7.5+ | Windows installer scripting | Native to Windows, cross-platform capable, strong JSON support |
| Bash | 4.0+ | Linux installer scripting | Universal on Linux/macOS, mature ecosystem |

### Supporting

| Tool | Version | Purpose | When to Use |
|------|---------|---------|-------------|
| Test-NetConnection | Built-in | Network connectivity validation (PowerShell) | Windows endpoint validation |
| rsync | Latest | File copying with attribute preservation | When preserving symlinks/permissions matters |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| jq | python -m json.tool | jq is more concise and widely available; python adds dependency |
| curl | wget | curl has better error handling and is more universal |
| PowerShell native JSON | External PowerShell modules | Native cmdlets are faster and have no dependencies |

**Installation:**

Bash dependencies:
```bash
# Debian/Ubuntu
sudo apt-get install jq curl

# RHEL/CentOS
sudo yum install jq curl

# macOS
brew install jq
```

PowerShell (Windows):
```powershell
# PowerShell 7+ is recommended but not required
# Native JSON cmdlets available in PowerShell 5.1+
```

## Architecture Patterns

### Recommended Project Structure

```
wood-fired-bugs/
├── install.sh              # Linux/macOS installer
├── install.ps1             # Windows PowerShell installer
├── skills/
│   └── tasks/             # Skill files to copy
│       ├── log-bug.md
│       ├── create-task.md
│       └── ...
└── .planning/
    └── phases/
        └── 13-cross-platform-installer/
```

### Pattern 1: Configuration File Location Discovery

**What:** Platform-specific logic to find Claude Code configuration file
**When to use:** At installer startup to locate target configuration
**Example:**

```bash
# Bash (Linux/macOS)
# Source: https://code.claude.com/docs/en/mcp
if [ -f "$HOME/.claude.json" ]; then
  CONFIG_FILE="$HOME/.claude.json"
else
  echo "ERROR: Claude Code config not found at ~/.claude.json"
  exit 1
fi
```

```powershell
# PowerShell (Windows)
# Source: https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop
$ConfigFile = "$env:USERPROFILE\.claude.json"
if (-not (Test-Path $ConfigFile)) {
  Write-Error "Claude Code config not found at $ConfigFile"
  exit 1
}
```

### Pattern 2: Atomic Configuration Backup

**What:** Timestamped backups before any modification
**When to use:** Before every configuration file write
**Example:**

```bash
# Bash
# Source: https://www.2daygeek.com/linux-bash-script-backup-configuration-files-remote-linux-system-server/
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="${CONFIG_FILE}.backup.${TIMESTAMP}"
cp "$CONFIG_FILE" "$BACKUP_FILE"
echo "Backed up config to $BACKUP_FILE"
```

```powershell
# PowerShell
# Source: https://robindadswell.github.io/blog/2019/10/14/writing-idempotent-powershell-scripts
$Timestamp = Get-Date -Format "yyyyMMdd_HHmmss"
$BackupFile = "$ConfigFile.backup.$Timestamp"
Copy-Item $ConfigFile $BackupFile
Write-Host "Backed up config to $BackupFile"
```

### Pattern 3: JSON Deep Merge

**What:** Merge new MCP server config while preserving existing servers
**When to use:** When adding wood-fired-bugs MCP server to existing configuration
**Example:**

```bash
# Bash with jq
# Source: https://richrose.dev/posts/linux/jq/jq-jsonmerge/
# Deep merge: existing config + new server
jq -s '.[0] * .[1]' "$CONFIG_FILE" new_config.json > merged.json
mv merged.json "$CONFIG_FILE"
```

```powershell
# PowerShell
# Source: https://gist.github.com/Badabum/a61e49019fb96bef4d5d9712e07b2af7
$existing = Get-Content $ConfigFile | ConvertFrom-Json
$newServer = @{
  "wood-fired-bugs" = @{
    command = "node"
    args = @("dist/mcp/index.js")
    env = @{
      WOOD_FIRED_BUGS_API_KEY = $ApiKey
      DB_PATH = "./data/tasks.db"
    }
  }
}

# Merge mcpServers
if (-not $existing.mcpServers) {
  $existing | Add-Member -MemberType NoteProperty -Name "mcpServers" -Value @{}
}
$existing.mcpServers | Add-Member -MemberType NoteProperty -Name "wood-fired-bugs" -Value $newServer["wood-fired-bugs"] -Force

# Save
$existing | ConvertTo-Json -Depth 10 | Set-Content $ConfigFile
```

### Pattern 4: Idempotent Skill File Copy

**What:** Copy skills only if missing or outdated, preserve permissions
**When to use:** Every installer run
**Example:**

```bash
# Bash with rsync
# Source: https://www.cyberciti.biz/faq/linux-unix-apple-osx-bsd-rsync-copy-hard-links/
SKILL_DIR="$HOME/.claude/commands/tasks"
mkdir -p "$SKILL_DIR"

# Copy preserving timestamps, only if newer
rsync -av --update skills/tasks/ "$SKILL_DIR/"
```

```powershell
# PowerShell
# Source: https://robindadswell.github.io/blog/2019/10/14/writing-idempotent-powershell-scripts
$SkillDir = "$env:USERPROFILE\.claude\commands\tasks"
New-Item -ItemType Directory -Force -Path $SkillDir | Out-Null

Get-ChildItem "skills\tasks\*.md" | ForEach-Object {
  $dest = Join-Path $SkillDir $_.Name
  if (-not (Test-Path $dest) -or $_.LastWriteTime -gt (Get-Item $dest).LastWriteTime) {
    Copy-Item $_.FullName $dest -Force
  }
}
```

### Pattern 5: HTTP Endpoint Validation

**What:** Verify connectivity to wood-fired-bugs service after configuration
**When to use:** Final step before installer success message
**Example:**

```bash
# Bash with curl
# Source: https://www.baeldung.com/linux/shell-check-url-validity
API_URL="http://localhost:3000/health"
if curl --fail --silent --connect-timeout 5 "$API_URL" > /dev/null; then
  echo "✓ Service connectivity verified"
else
  echo "⚠ WARNING: Could not reach service at $API_URL"
  echo "Ensure the service is running: npm start"
fi
```

```powershell
# PowerShell
# Source: https://lazyadmin.nl/powershell/test-netconnection/
$ApiUrl = "http://localhost:3000"
$Result = Test-NetConnection -ComputerName "localhost" -Port 3000 -InformationLevel Quiet

if ($Result) {
  Write-Host "✓ Service connectivity verified" -ForegroundColor Green
} else {
  Write-Warning "Could not reach service at $ApiUrl"
  Write-Host "Ensure the service is running: npm start"
}
```

### Anti-Patterns to Avoid

- **Direct string manipulation of JSON:** Never use sed/awk to modify JSON files; use jq (bash) or ConvertFrom-Json (PowerShell) to ensure valid syntax
- **Overwriting configs without backup:** Always create timestamped backups before any modification
- **Silent failures:** Never suppress errors in installers; fail loudly with clear messages
- **Hardcoded paths:** Use environment variables and platform detection instead of assuming paths
- **Global namespace pollution:** In PowerShell, avoid global variables; use script-scoped variables

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| JSON parsing/merging | String manipulation with sed/awk/regex | jq (bash), ConvertFrom-Json (PowerShell) | JSON has complex escaping rules, nested structures, and edge cases that regex cannot handle reliably |
| HTTP connectivity testing | Raw socket operations | curl (bash), Test-NetConnection (PowerShell) | Handle redirects, timeouts, SSL/TLS, HTTP status codes correctly |
| File backup/restore | Manual copy without timestamps | Timestamped backups with atomic operations | Need rollback capability if installation fails |
| Path handling | String concatenation | Join-Path (PowerShell), proper quoting in bash | Handle spaces, special characters, cross-platform differences |
| User input validation | Custom parsing | Read-Host -AsSecureString (PowerShell), read -s (bash) | Secure input handling, history protection |

**Key insight:** Shell scripting has solved these problems repeatedly over decades. Mature tools exist with battle-tested edge case handling. Custom implementations introduce subtle bugs (especially with JSON and paths).

## Common Pitfalls

### Pitfall 1: Configuration File Location Confusion

**What goes wrong:** Documentation inconsistencies about Claude Code config location; some docs mention ~/.claude/settings.json, others ~/.claude.json, actual behavior varies

**Why it happens:** Claude Code configuration has evolved; different versions and contexts (Desktop vs CLI) use different locations

**How to avoid:**
- Check for ~/.claude.json FIRST (most reliable for Claude Code CLI as of 2026)
- Verify config file works by checking for existing mcpServers object
- Document the actual path used in installer output

**Warning signs:** Installer completes successfully but skills/MCP server don't appear in Claude Code

**Sources:**
- [Claude Code MCP Configuration](https://code.claude.com/docs/en/mcp)
- [GitHub Issue: Documentation incorrect about MCP configuration file location](https://github.com/anthropics/claude-code/issues/4976)

### Pitfall 2: Shallow JSON Merge Losing Nested Data

**What goes wrong:** Using jq's `+` operator or PowerShell simple merge overwrites nested objects instead of merging them

**Why it happens:** Default merge behavior is shallow; mcpServers contains nested server configs

**How to avoid:**
- Use jq's `*` operator for recursive deep merge: `jq -s '.[0] * .[1]'`
- In PowerShell, use Add-Member with -Force only on specific properties, not entire objects
- Test merge with existing multi-server configs

**Warning signs:** After installer runs, previously configured MCP servers disappear from config

**Sources:**
- [Merge multiple JSON files with JQ](https://richrose.dev/posts/linux/jq/jq-jsonmerge/)
- [Merge two .json objects using PowerShell](https://gist.github.com/Badabum/a61e49019fb96bef4d5d9712e07b2af7)

### Pitfall 3: API Key Not Scoped to MCP Server

**What goes wrong:** Installer adds API key to shell profile (.bashrc, profile.ps1) instead of MCP config env section; MCP server doesn't receive the key

**Why it happens:** Confusion between environment variables for CLI usage vs MCP server environment

**How to avoid:**
- Write API key to the `env` property within the MCP server config JSON
- MCP servers do NOT inherit all shell environment variables
- Test by checking MCP server logs for authentication errors

**Warning signs:** Skills fail with "Unauthorized" or "API key required" errors despite key being set in shell

**Sources:**
- [Managing Environment Variables - MCP](https://apxml.com/courses/getting-started-model-context-protocol/chapter-4-debugging-and-client-integration/managing-environment-variables)
- [MCP configuration secrets handling](https://0xhagen.medium.com/mcp-configuration-is-a-sh-tshow-but-heres-how-i-fixed-secrets-handling-5395010762a1)

### Pitfall 4: Not Restarting Claude Code After Config Change

**What goes wrong:** Configuration changes don't take effect; users see old config

**Why it happens:** Claude Code caches configuration; requires full restart to reload

**How to avoid:**
- Document in installer output: "Restart Claude Code to apply changes"
- Consider detecting if Claude Code is running and warn user
- Use clear messaging with specific restart instructions

**Warning signs:** Configuration file looks correct but skills/MCP server not available in Claude Code

**Sources:**
- [Managing Environment Variables - MCP](https://apxml.com/courses/getting-started-model-context-protocol/chapter-4-debugging-and-client-integration/managing-environment-variables)

### Pitfall 5: Installer Not Idempotent

**What goes wrong:** Running installer twice breaks configuration, duplicates entries, or fails with errors

**Why it happens:** No checks for existing installation state before making changes

**How to avoid:**
- Check if wood-fired-bugs MCP server already exists in config
- Skip/update instead of failing
- Use "command -v" (bash) or Test-Path (PowerShell) to check prerequisites
- Make all operations safe to repeat

**Warning signs:** Installer works first time, fails on second run, or creates duplicate entries

**Sources:**
- [Writing Idempotent PowerShell scripts](https://robindadswell.github.io/blog/2019/10/14/writing-idempotent-powershell-scripts)
- [Mission Impossible Code - Idempotent Package Installer](https://missionimpossiblecode.io/mission-impossible-code-compact-idempotent-devops-oriented-multi-distro-package-installer-script-for-linux-and-mac)

### Pitfall 6: No Rollback on Partial Failure

**What goes wrong:** Installer copies files, fails during config merge, leaves system in inconsistent state

**Why it happens:** No transactional guarantees; each step modifies system state independently

**How to avoid:**
- Create all backups BEFORE any modifications
- On error, restore from backup automatically
- Use trap (bash) or trap { } finally { } (PowerShell) for cleanup
- Validate each step before proceeding to next

**Warning signs:** Installer fails midway, user must manually clean up or restore

**Sources:**
- [InstallSite: Installation Phases and Rollback](http://www.installsite.org/pages/en/isnews/200108/index.htm)
- [Atomic file operations](https://github.com/DavidVorick/atomic-file)

## Code Examples

Verified patterns from official sources:

### Bash Installer Shell

```bash
#!/usr/bin/env bash
# Source: https://vaneyckt.io/posts/safer_bash_scripts_with_set_euxo_pipefail/
set -euo pipefail

# Cleanup on exit
trap cleanup EXIT
cleanup() {
  local exit_code=$?
  if [ $exit_code -ne 0 ]; then
    echo "Installation failed. Restoring backup..."
    if [ -n "${BACKUP_FILE:-}" ] && [ -f "$BACKUP_FILE" ]; then
      cp "$BACKUP_FILE" "$CONFIG_FILE"
      echo "Configuration restored from backup"
    fi
  fi
}

# Rest of installer...
```

### PowerShell Installer Shell

```powershell
# Source: https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_preference_variables
$ErrorActionPreference = "Stop"

try {
  # Installation steps...
} catch {
  Write-Error "Installation failed: $_"
  if (Test-Path $BackupFile) {
    Copy-Item $BackupFile $ConfigFile -Force
    Write-Host "Configuration restored from backup"
  }
  exit 1
}
```

### Secure API Key Input (Bash)

```bash
# Source: Standard bash read builtin
read -sp "Enter Wood Fired Bugs API key: " API_KEY
echo  # New line after masked input
if [ -z "$API_KEY" ]; then
  echo "ERROR: API key is required"
  exit 1
fi
```

### Secure API Key Input (PowerShell)

```powershell
# Source: https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.utility/read-host
$ApiKey = Read-Host "Enter Wood Fired Bugs API key" -MaskInput
if ([string]::IsNullOrWhiteSpace($ApiKey)) {
  Write-Error "API key is required"
  exit 1
}
```

### jq Deep Merge for MCP Config

```bash
# Source: https://richrose.dev/posts/linux/jq/jq-jsonmerge/
# Create new server config
cat > /tmp/new_server.json <<EOF
{
  "mcpServers": {
    "wood-fired-bugs": {
      "command": "node",
      "args": ["dist/mcp/index.js"],
      "env": {
        "WOOD_FIRED_BUGS_API_KEY": "$API_KEY",
        "DB_PATH": "./data/tasks.db"
      }
    }
  }
}
EOF

# Deep merge with existing config
jq -s '.[0] * .[1]' "$CONFIG_FILE" /tmp/new_server.json > /tmp/merged.json
mv /tmp/merged.json "$CONFIG_FILE"
rm /tmp/new_server.json
```

### Skills Directory Setup (Bash)

```bash
# Source: https://www.cyberciti.biz/faq/linux-cp-command-copy-symbolic-soft-link/
SKILLS_SOURCE="./skills/tasks"
SKILLS_DEST="$HOME/.claude/commands/tasks"

# Create directory if doesn't exist
mkdir -p "$SKILLS_DEST"

# Copy with archive mode (preserves timestamps, permissions)
# --update: skip files that are newer at destination
cp -a --update "$SKILLS_SOURCE/"* "$SKILLS_DEST/"

echo "Installed $(ls -1 "$SKILLS_DEST" | wc -l) skill files"
```

### MCP Server Config Structure

```json
{
  "mcpServers": {
    "wood-fired-bugs": {
      "command": "node",
      "args": ["dist/mcp/index.js"],
      "env": {
        "WOOD_FIRED_BUGS_API_KEY": "your-api-key-here",
        "DB_PATH": "./data/tasks.db"
      }
    }
  }
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| ~/.claude/settings.json for MCP config | ~/.claude.json for Claude Code CLI | ~2025 | Documentation confusion; must check actual location |
| Shell environment variables for MCP | env property in MCP server config | MCP 1.0 | API keys must be in config, not shell profile |
| Manual JSON string manipulation | jq for bash, native cmdlets for PowerShell | Established | Safer, more reliable JSON handling |
| cp for file operations | rsync or cp -a | Established | Better preservation of attributes |

**Deprecated/outdated:**
- **~/.claude/settings.json:** Some docs mention this, but ~/.claude.json is the actual location for Claude Code CLI
- **Global environment variables for MCP servers:** MCP servers are isolated; use `env` property in config
- **sed/awk for JSON:** Unreliable; use proper JSON tools

## Open Questions

### 1. What is the exact configuration file location for Claude Code on Windows?

**What we know:**
- Linux uses ~/.claude.json
- Some docs mention different paths for Claude Desktop vs Claude Code CLI
- Windows path conventions differ from Unix

**What's unclear:**
- Does Windows Claude Code use %USERPROFILE%\.claude.json or different location?
- Are there registry entries or AppData locations to check?

**Recommendation:**
- Check both %USERPROFILE%\.claude.json and %APPDATA%\Claude\claude_desktop_config.json
- Document actual path found during Windows testing
- Add detection logic to installer

### 2. How should installer handle project location for wood-fired-bugs service?

**What we know:**
- MCP server needs to run from project directory (for dist/mcp/index.js)
- DB_PATH is configurable via environment variable
- Installer runs from project directory

**What's unclear:**
- Should installer assume global npm install, local project, or user choice?
- How to set working directory in MCP config?

**Recommendation:**
- Use absolute paths in MCP config (resolve during installation)
- Prompt user for installation location or detect current directory
- Add `cwd` parameter to MCP server config

### 3. Should installer validate jq availability or bundle it?

**What we know:**
- jq is widely available on Linux
- Not installed by default on all systems
- Small standalone binary

**What's unclear:**
- Error early if jq missing, or fallback to Python/node JSON parsing?
- Bundle jq binary with installer?

**Recommendation:**
- Check for jq at installer start with "command -v jq"
- Provide clear installation instructions if missing
- Consider fallback to node/python for JSON if available

## Sources

### Primary (HIGH confidence)

- [Connect Claude Code to tools via MCP - Official Docs](https://code.claude.com/docs/en/mcp)
- [Getting Started with Local MCP Servers on Claude Desktop](https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop)
- [Managing Environment Variables - MCP](https://apxml.com/courses/getting-started-model-context-protocol/chapter-4-debugging-and-client-integration/managing-environment-variables)
- [jq Manual - Official](https://jqlang.org/manual/)
- [Microsoft Learn: Read-Host](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.utility/read-host)
- [Microsoft Learn: ErrorActionPreference](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_preference_variables)

### Secondary (MEDIUM confidence)

- [How to Backup Configuration Files on Remote System Using Bash](https://www.2daygeek.com/linux-bash-script-backup-configuration-files-remote-linux-system-server/)
- [Merge multiple JSON files with JQ](https://richrose.dev/posts/linux/jq/jq-jsonmerge/)
- [Writing Idempotent PowerShell scripts](https://robindadswell.github.io/blog/2019/10/14/writing-idempotent-powershell-scripts)
- [Safer bash scripts with set -euxo pipefail](https://vaneyckt.io/posts/safer_bash_scripts_with_set_euxo_pipefail/)
- [How to Verify if URL Is Valid From Linux Shell - Baeldung](https://www.baeldung.com/linux/shell-check-url-validity)
- [Test-NetConnection in PowerShell - LazyAdmin](https://lazyadmin.nl/powershell/test-netconnection/)
- [How to Copy Files And Preserve Symbolic Links](https://www.cyberciti.biz/faq/linux-cp-command-copy-symbolic-soft-link/)

### Tertiary (LOW confidence - needs validation)

- [GitHub Issue #4976: Documentation incorrect about MCP configuration file location](https://github.com/anthropics/claude-code/issues/4976) - User-reported, not official
- [MCP configuration secrets handling - Medium](https://0xhagen.medium.com/mcp-configuration-is-a-sh-tshow-but-heres-how-i-fixed-secrets-handling-5395010762a1) - Community workaround, not official

## Metadata

**Confidence breakdown:**
- Standard stack: MEDIUM - jq and PowerShell JSON cmdlets are well-established, but Claude Code config location has some documentation inconsistencies
- Architecture: MEDIUM - Patterns are verified from official docs and established practices, but some Claude Code specifics need validation
- Pitfalls: MEDIUM - Common installer pitfalls well-documented, MCP-specific issues based on recent 2025-2026 community reports

**Research date:** 2026-02-13
**Valid until:** ~2026-03-15 (30 days) - stable technologies, but Claude Code config conventions may evolve
