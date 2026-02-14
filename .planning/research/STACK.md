# Stack Research

**Domain:** Claude Code Skills & Cross-Platform Installer
**Researched:** 2026-02-13
**Confidence:** HIGH

## Recommended Stack

### Claude Code Skills (No New Dependencies)

| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| Markdown | N/A | Skill file format | Official Claude Code skill format — YAML frontmatter + markdown content |
| YAML | N/A | Skill metadata | Standard frontmatter format for Claude Code skills |
| Bash | N/A | Dynamic context injection | `!`command`` syntax for live data insertion into skills |

**Rationale:** Claude Code skills are markdown files with YAML frontmatter. No npm dependencies needed — they're static files that Claude Code reads directly from `~/.claude/commands/tasks/` or `~/.claude/skills/tasks/`. The existing MCP tools become available to skills through Claude's tool invocation system.

### MCP Server Configuration (No New Dependencies)

| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| JSON | N/A | MCP config format | Claude Desktop's native configuration format at `~/.config/Claude/claude_desktop_config.json` |
| Node.js | Existing | MCP server runtime | Already used for Wood Fired Bugs MCP server via @modelcontextprotocol/sdk |
| npx | Comes with Node | Server launcher | Standard launcher in Claude Desktop configs |

**Rationale:** MCP configuration uses JSON at a well-defined location. The Wood Fired Bugs MCP server is already built with @modelcontextprotocol/sdk v1.26.0 — no version changes needed. Configuration just registers the server with Claude Desktop.

### Cross-Platform Installer Scripts

| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| Bash | 4.0+ | Linux installer | Universal on Linux/macOS, handles symlinks, directory creation, config merging |
| PowerShell | 7.0+ | Windows installer | Cross-platform PowerShell 7+ available on Windows 10/11, handles JSON manipulation |
| jq | Latest | JSON config merging (Linux) | Industry standard for JSON manipulation in shell scripts |
| Node.js | Existing | JSON parsing fallback | Already required for MCP server, can parse/merge JSON if jq unavailable |

**Rationale:**
- **Bash** is the standard for Linux scripting, pre-installed on all modern Linux distributions and macOS
- **PowerShell 7+** is Microsoft's official cross-platform shell, recommended over older PowerShell 5.1 for better cross-platform compatibility
- **jq** is the de facto standard for JSON manipulation in Bash, widely available via package managers
- **Node.js** provides a fallback for JSON operations if jq is unavailable

## Installation

**No new npm dependencies required.** The existing stack handles everything:

```bash
# Already installed in package.json
@modelcontextprotocol/sdk  # MCP server SDK
commander                   # CLI framework (not needed for skills, but for installer CLI)
chalk                       # Terminal colors (for installer feedback)
```

**System dependencies for installers:**

```bash
# Linux (Ubuntu/Debian)
sudo apt-get install jq  # Optional but recommended for JSON merging

# Windows
# PowerShell 7+ recommended (https://github.com/PowerShell/PowerShell)
# Ships with Windows 10/11, or install via:
winget install --id Microsoft.PowerShell --source winget
```

## Stack Patterns by Feature

### Claude Code Skills

**File Structure:**
```
~/.claude/commands/tasks/     # Legacy location (still works)
~/.claude/skills/tasks/       # Recommended location
  ├── SKILL.md                # Required: Main skill file
  ├── templates/              # Optional: Templates for skill output
  ├── examples/               # Optional: Example outputs
  └── scripts/                # Optional: Helper scripts
```

**SKILL.md Format:**
```markdown
---
name: skill-name
description: What this skill does and when to use it
disable-model-invocation: true  # Optional: prevent auto-invocation
user-invocable: false           # Optional: hide from menu
allowed-tools: Read, Grep       # Optional: restrict tools
---

# Skill Instructions

Your instructions for Claude...

$ARGUMENTS or $0, $1, $2 for positional arguments
${CLAUDE_SESSION_ID} for session ID

!`command` for dynamic context injection
```

**Discovery Hierarchy:**
1. Enterprise (managed settings)
2. Personal (`~/.claude/skills/`)
3. Project (`.claude/skills/`)
4. Plugins

When names collide, higher priority wins. Skills take precedence over `.claude/commands/` files.

### MCP Server Configuration

**Config File Location:**
```bash
# Linux
~/.config/Claude/claude_desktop_config.json

# macOS
~/Library/Application Support/Claude/claude_desktop_config.json

# Windows
%APPDATA%\Claude\claude_desktop_config.json
```

**Config Format:**
```json
{
  "mcpServers": {
    "wood-fired-bugs": {
      "command": "node",
      "args": [
        "/absolute/path/to/wood-fired-bugs/dist/mcp/index.js"
      ],
      "env": {
        "WOOD_FIRED_BUGS_API_KEY": "your-api-key-here",
        "NODE_ENV": "production"
      }
    }
  }
}
```

**Configuration Fields:**
- `command`: Executable to run (node, npx, python, etc.)
- `args`: Array of arguments (use absolute paths)
- `env`: Environment variables (credentials, config)

**Best Practices:**
- Use absolute paths for reliability
- Store credentials in `env` block
- Server name becomes the identifier in Claude Desktop
- Restart Claude Desktop after config changes

### Cross-Platform Installer Scripts

**Bash Pattern (Linux):**
```bash
#!/usr/bin/env bash
set -euo pipefail  # Exit on error, undefined vars, pipe failures

# Detect paths
CLAUDE_CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/Claude"
CLAUDE_COMMANDS_DIR="$HOME/.claude/commands/tasks"
CLAUDE_SKILLS_DIR="$HOME/.claude/skills/tasks"

# Create directories
mkdir -p "$CLAUDE_CONFIG_DIR"
mkdir -p "$CLAUDE_SKILLS_DIR"

# Copy skill files
cp -r ./skills/* "$CLAUDE_SKILLS_DIR/"

# Merge MCP config using jq
if command -v jq &> /dev/null; then
  jq -s '.[0] * .[1]' \
    "$CLAUDE_CONFIG_DIR/claude_desktop_config.json" \
    ./config/mcp-server-config.json \
    > "$CLAUDE_CONFIG_DIR/claude_desktop_config.json.tmp"
  mv "$CLAUDE_CONFIG_DIR/claude_desktop_config.json.tmp" \
     "$CLAUDE_CONFIG_DIR/claude_desktop_config.json"
else
  # Fallback: use Node.js
  node ./scripts/merge-config.js
fi

# Set executable permissions
chmod +x "$CLAUDE_SKILLS_DIR/"**/*.sh 2>/dev/null || true

echo "✓ Installation complete"
echo "  Skills installed to: $CLAUDE_SKILLS_DIR"
echo "  MCP server configured at: $CLAUDE_CONFIG_DIR/claude_desktop_config.json"
echo ""
echo "⚠ Restart Claude Desktop to load changes"
```

**PowerShell Pattern (Windows):**
```powershell
#!/usr/bin/env pwsh
#Requires -Version 7.0

$ErrorActionPreference = "Stop"

# Detect paths (cross-platform PowerShell 7+ syntax)
$ClaudeConfigDir = if ($IsWindows) {
    "$env:APPDATA\Claude"
} else {
    "$HOME/.config/Claude"
}

$ClaudeSkillsDir = "$HOME\.claude\skills\tasks"

# Create directories
New-Item -ItemType Directory -Force -Path $ClaudeConfigDir | Out-Null
New-Item -ItemType Directory -Force -Path $ClaudeSkillsDir | Out-Null

# Copy skill files
Copy-Item -Recurse -Force ".\skills\*" $ClaudeSkillsDir

# Merge MCP config using PowerShell
$configPath = Join-Path $ClaudeConfigDir "claude_desktop_config.json"
$newConfig = Get-Content ".\config\mcp-server-config.json" | ConvertFrom-Json

if (Test-Path $configPath) {
    $existingConfig = Get-Content $configPath | ConvertFrom-Json
    # Merge mcpServers objects
    $existingConfig.mcpServers.PSObject.Properties | ForEach-Object {
        $newConfig.mcpServers | Add-Member -NotePropertyName $_.Name -NotePropertyValue $_.Value -Force
    }
}

$newConfig | ConvertTo-Json -Depth 10 | Set-Content $configPath

Write-Host "✓ Installation complete" -ForegroundColor Green
Write-Host "  Skills installed to: $ClaudeSkillsDir"
Write-Host "  MCP server configured at: $configPath"
Write-Host ""
Write-Host "⚠ Restart Claude Desktop to load changes" -ForegroundColor Yellow
```

**Key Cross-Platform Considerations:**
- Use `[IO.Path]::PathSeparator` for path separators (`;` on Windows, `:` on Unix)
- Check `$IsWindows`, `$IsLinux`, `$IsMacOS` for platform-specific logic
- Avoid aliases (use `Copy-Item` not `cp`, `Get-ChildItem` not `ls`)
- Use forward slashes in paths where possible (PowerShell handles both)
- Test on actual target platforms — cross-platform doesn't mean write-once-run-anywhere

## Alternatives Considered

| Recommended | Alternative | When to Use Alternative |
|-------------|-------------|-------------------------|
| Markdown skills in `~/.claude/` | Python/Node.js plugins | When skills need complex runtime logic or external dependencies |
| JSON config merging | Manual user config | For single-user setups where automation isn't needed |
| Bash (Linux) | Python installer | When Python is already required by the project |
| PowerShell 7+ (Windows) | Batch scripts (.bat) | Never — batch scripts are legacy, PowerShell is the modern standard |
| jq (JSON parsing) | Node.js scripts | When Node.js is already required (fallback in this project) |
| `~/.claude/skills/` | `~/.claude/commands/` | Never for new projects — skills are the recommended approach |

## What NOT to Use

| Avoid | Why | Use Instead |
|-------|-----|-------------|
| `.claude/commands/` for new projects | Legacy location, skills have more features (supporting files, frontmatter controls) | `~/.claude/skills/` |
| PowerShell 5.1 aliases in scripts | Platform-specific, non-portable | Full cmdlet names (`Copy-Item` not `cp`) |
| Hardcoded paths in installers | Breaks on different systems | Environment variables, path detection |
| Relative paths in MCP config | Claude Desktop may launch from different working directories | Absolute paths |
| Git-committing `claude_desktop_config.json` | Contains user credentials, system-specific paths | Provide template/example config |
| npm dependencies for skills | Skills are markdown files, not Node.js modules | Use dynamic context injection (`!`command``) |
| Remote MCP servers for local tools | Adds network latency, auth complexity | Local stdio MCP servers |

## Version Compatibility

| Package | Version | Compatible With | Notes |
|---------|---------|-----------------|-------|
| @modelcontextprotocol/sdk | 1.26.0 | Claude Desktop 0.7+ | Existing version works, no upgrade needed |
| Node.js | 18+ | MCP SDK 1.x | Already installed (required for better-sqlite3) |
| PowerShell | 7.0+ | Windows 10/11, Linux, macOS | Required for cross-platform PowerShell features |
| Bash | 4.0+ | All modern Linux/macOS | Universal, no compatibility concerns |
| jq | 1.5+ | JSON config merging | Optional but recommended for Bash installer |
| Claude Desktop | 0.7+ | MCP Protocol 2024-11-05 | Check via Claude menu → "Check for Updates..." |

**Critical Compatibility Notes:**
- Claude Code skills format is stable as of 2026 — YAML frontmatter + markdown content
- MCP config schema is stable — `command`, `args`, `env` structure unchanged
- PowerShell 7+ is NOT the same as Windows PowerShell 5.1 — scripts must target 7+ for cross-platform
- Skills discovery is hierarchical — enterprise > personal > project > plugins

## Sources

### Claude Code Skills
- [Extend Claude with skills - Claude Code Docs](https://code.claude.com/docs/en/skills) — MEDIUM confidence (official docs)
- [GitHub - anthropics/skills](https://github.com/anthropics/skills) — MEDIUM confidence (official examples)
- [Claude Skills and CLAUDE.md: a practical 2026 guide](https://www.gend.co/blog/claude-skills-claude-md-guide) — LOW confidence (community guide)
- [Inside Claude Code Skills: Structure, prompts, invocation](https://mikhail.io/2025/10/claude-code-skills/) — LOW confidence (blog post)

### MCP Configuration
- [Connect to local MCP servers - Model Context Protocol](https://modelcontextprotocol.io/docs/develop/connect-local-servers) — HIGH confidence (official docs)
- [Getting Started with Local MCP Servers on Claude Desktop](https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop) — HIGH confidence (official support)
- [Ultimate Guide to Claude MCP Servers & Setup | 2026](https://generect.com/blog/claude-mcp/) — LOW confidence (community guide)

### Cross-Platform Scripting
- [PowerShell 7 Cross-Platform Scripting Tips and Traps](https://jdhitsolutions.com/blog/scripting/7361/powershell-7-cross-platform-scripting-tips-and-traps/) — MEDIUM confidence (expert blog)
- [Tips for Writing Cross-Platform PowerShell Code](https://powershell.org/2019/02/tips-for-writing-cross-platform-powershell-code/) — MEDIUM confidence (community org)
- [GitHub - PowerShell/PowerShell](https://github.com/PowerShell/PowerShell) — HIGH confidence (official repo)
- [Installing PowerShell on Linux in 2026](https://thelinuxcode.com/installing-powershell-on-linux-in-2026-a-practical-opinionated-walkthrough/) — MEDIUM confidence (current guide)

---
*Stack research for: Claude Code Skills & Installer*
*Researched: 2026-02-13*
