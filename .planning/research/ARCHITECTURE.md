# Architecture Research: Claude Code Skills & Installer

**Domain:** Claude Code Skills + Cross-Platform Installer
**Researched:** 2026-02-13
**Confidence:** HIGH

## Integration Context

Wood Fired Bugs v1.2 adds Claude Code skills (teaching Claude how to use the task tracking system) and a cross-platform installer. This builds on the existing v1.1 architecture:

```
Existing v1.1:
┌─────────────────────────────────────────────────────────────┐
│                   Client Interfaces Layer                    │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐                   │
│  │   CLI    │  │   REST   │  │   MCP    │                   │
│  │  (HTTP)  │  │   API    │  │ (stdio)  │                   │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘                   │
│       │ HTTP        │             │ Direct                   │
├───────┴─────────────┴─────────────┴──────────────────────────┤
│                     Service Layer                             │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐     │
│  │   Task   │  │ Project  │  │Dependency│  │ Comment  │     │
│  │ Service  │  │ Service  │  │ Service  │  │ Service  │     │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘     │
├───────┴─────────────┴──────────────┴─────────────┴───────────┤
│                     Database Layer                            │
│  ┌─────────────────────────────────────────────────────┐     │
│  │         SQLite (better-sqlite3) + Systemd           │     │
│  └─────────────────────────────────────────────────────┘     │
└─────────────────────────────────────────────────────────────┘
```

v1.2 adds skills and installer that integrate with this architecture:

```
New v1.2 Components:
┌─────────────────────────────────────────────────────────────┐
│                   Claude Code (User's Machine)               │
│  ┌─────────────────────────────────────────────────────┐    │
│  │              ~/.claude/commands/tasks/               │    │
│  │  ┌──────────────┐  ┌──────────────┐                 │    │
│  │  │  create.md   │  │  list.md     │  (10 skills)    │    │
│  │  │  update.md   │  │  project.md  │                 │    │
│  │  └──────────────┘  └──────────────┘                 │    │
│  └─────────────────────────────────────────────────────┘    │
│           │                                                   │
│           │ References MCP tools via tool names              │
│           ↓                                                   │
│  ┌─────────────────────────────────────────────────────┐    │
│  │          ~/.claude.json (MCP Config)                 │    │
│  │  {                                                   │    │
│  │    "mcpServers": {                                   │    │
│  │      "wood-fired-bugs": {                            │    │
│  │        "command": "node",                            │    │
│  │        "args": ["/abs/path/to/dist/mcp/index.js"],  │    │
│  │        "env": {                                      │    │
│  │          "WOOD_FIRED_BUGS_API_KEY": "..."           │    │
│  │        }                                             │    │
│  │      }                                               │    │
│  │    }                                                 │    │
│  │  }                                                   │    │
│  └─────────────────────────────────────────────────────┘    │
│           │                                                   │
│           │ Calls MCP server (stdio transport)               │
│           ↓                                                   │
└───────────┼───────────────────────────────────────────────────┘
            │
            │ stdio (JSON-RPC)
            ↓
┌─────────────────────────────────────────────────────────────┐
│            Wood Fired Bugs MCP Server (Server Machine)       │
│  ┌─────────────────────────────────────────────────────┐    │
│  │              dist/mcp/index.js                       │    │
│  │  (25 MCP tools: tasks, projects, deps, comments)    │    │
│  └────────────────────┬────────────────────────────────┘    │
│                       │                                      │
│                       ↓                                      │
│  ┌─────────────────────────────────────────────────────┐    │
│  │              Service Layer (Direct)                  │    │
│  └─────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
```

**Key architectural facts:**

1. **Skills live on user's machine**: `~/.claude/commands/tasks/` (user-level) or project `.claude/commands/tasks/` (project-level)
2. **Skills reference MCP tools by name**: `mcp__wood-fired-bugs__create_task`, not direct calls
3. **MCP server configured globally**: `~/.claude.json` for cross-project availability
4. **Auth via environment variable**: `WOOD_FIRED_BUGS_API_KEY` set in MCP server env
5. **Installer handles setup**: Copies skills, configures MCP, sets env vars, tests connectivity

**Sources:**
- [Claude Code Skills Documentation](https://code.claude.com/docs/en/skills)
- [Claude Code MCP Configuration](https://code.claude.com/docs/en/mcp)
- [MCP Skills Comparison](https://claude.com/blog/skills-explained)

## Recommended Project Structure

### Existing Structure (v1.1)

```
src/
├── api/                # REST API (Fastify)
├── cli/                # CLI commands (Commander.js)
├── db/                 # Database + migrations
├── mcp/                # MCP server + tools
│   ├── index.ts        # stdio entry point
│   ├── server.ts       # createMcpServer factory
│   └── tools/          # Tool registration files
│       ├── task-tools.ts
│       ├── project-tools.ts
│       ├── dependency-tools.ts
│       ├── comment-tools.ts
│       └── health-tools.ts
├── repositories/       # Data access layer
├── schemas/            # Zod schemas
├── services/           # Business logic
├── types/              # TypeScript types
└── utils/              # Utilities
```

### New v1.2 Additions

```
skills/                      # NEW: Claude Code skills (markdown)
├── create.md                # /tasks:create - Create tasks
├── list.md                  # /tasks:list - List/filter tasks
├── update.md                # /tasks:update - Update tasks
├── get.md                   # /tasks:get - Get task details
├── delete.md                # /tasks:delete - Delete tasks
├── project.md               # /tasks:project - Manage projects
├── dependency.md            # /tasks:dependency - Manage dependencies
├── comment.md               # /tasks:comment - Manage comments
├── subtask.md               # /tasks:subtask - Subtask operations
└── health.md                # /tasks:health - System health

install/                     # NEW: Installer scripts
├── install.sh               # Bash installer (Linux/macOS)
├── install.ps1              # PowerShell installer (Windows)
└── README.md                # Installation instructions

dist/                        # Build output (existing)
└── mcp/                     # Compiled MCP server
    └── index.js             # Entry point for MCP server

package.json                 # Update with install scripts
```

**Rationale:**

- **`skills/` at root**: Skills are user-facing documentation, not source code. Keep separate from `src/`.
- **`install/` at root**: Installer is distribution artifact, not source. Parallel to `deploy/`.
- **Skill naming convention**: `{verb}.md` for single operations, `{noun}.md` for resource groups (project.md, dependency.md).
- **Namespace**: `/tasks:*` prevents collision with other Claude Code skills or built-in commands.

**Sources:**
- [Agent Skills Standard](https://agentskills.io)
- [Claude Code Skills Directory Structure](https://code.claude.com/docs/en/skills)

## Standard Architecture

### Skills Architecture

#### Skill File Format

Every skill is a standalone markdown file with YAML frontmatter:

```markdown
---
name: create
description: Create a new task with title, description, priority, status. Use when user wants to add a task to the tracking system. Supports subtask creation.
---

# Create Task

Creates a new task in the Wood Fired Bugs tracking system.

## When to Use

- User says "create task", "add task", "new task"
- User provides task details (title required)
- Creating subtasks under existing tasks

## MCP Tools Used

- `mcp__wood-fired-bugs__create_task`: Main task creation
- `mcp__wood-fired-bugs__list_projects`: Get available projects

## Procedure

1. **Gather Information**
   - Title (required)
   - Description (optional)
   - Priority (low/medium/high/urgent, default: medium)
   - Status (todo/in_progress/done/blocked, default: todo)
   - Project ID (optional)
   - Parent task ID for subtasks (optional)

2. **Call MCP Tool**
   ```
   Use mcp__wood-fired-bugs__create_task with parameters
   ```

3. **Confirm Result**
   - Report task ID and title
   - Show task URL if available
   - Mention next steps (assign, add dependencies, etc.)

## Examples

**Simple task:**
> "Create task: Fix login bug"

**Detailed task:**
> "Create high priority task: Implement OAuth with description: Add Google and GitHub OAuth providers, status: in_progress"

**Subtask:**
> "Create subtask under task 42: Write unit tests"
```

**Key components:**

- **Frontmatter**: `name` (becomes `/tasks:create`), `description` (when Claude auto-invokes)
- **Procedure**: Step-by-step instructions for Claude
- **MCP tool references**: By full name `mcp__wood-fired-bugs__create_task`
- **Examples**: Shows expected usage patterns

**Sources:**
- [Skill Format Documentation](https://code.claude.com/docs/en/skills)
- [Agent Skills Standard](https://github.com/anthropics/skills)

#### MCP Tool Discovery

Skills **reference** MCP tools but don't call them directly. The flow:

```
1. User: "Create a high priority task for fixing login"
   ↓
2. Claude Code: Matches skill description → loads /tasks:create skill
   ↓
3. Skill instructions: "Use mcp__wood-fired-bugs__create_task with..."
   ↓
4. Claude Code: Calls MCP tool mcp__wood-fired-bugs__create_task
   ↓
5. MCP Server: Validates, executes via service layer
   ↓
6. Response: Task created, returns structured data
   ↓
7. Skill instructions: "Report task ID and title"
   ↓
8. Claude Code: Formats response to user
```

**Important:** Skills are **instructions** not **code**. They teach Claude the workflow, Claude Code handles tool invocation.

**Tool naming convention:**
```
mcp__<server-name>__<tool-name>
    │       │            └── Tool name from server.registerTool('create_task', ...)
    │       └──────────────── MCP server name from ~/.claude.json
    └──────────────────────── MCP namespace prefix
```

**For wood-fired-bugs:**
- Server name: `wood-fired-bugs` (from `~/.claude.json` config)
- Tool names: `create_task`, `list_tasks`, `update_task`, etc.
- Full names: `mcp__wood-fired-bugs__create_task`, `mcp__wood-fired-bugs__list_tasks`

**Sources:**
- [MCP Tool Configuration](https://code.claude.com/docs/en/mcp)
- [Skills vs MCP Explanation](https://claude.com/blog/skills-explained)

### MCP Server Configuration

#### Global Configuration File

Claude Code uses `~/.claude.json` for user-level MCP server configuration:

```json
{
  "mcpServers": {
    "wood-fired-bugs": {
      "command": "node",
      "args": ["/absolute/path/to/wood-fired-bugs/dist/mcp/index.js"],
      "env": {
        "WOOD_FIRED_BUGS_API_KEY": "generated-api-key-here",
        "DB_PATH": "/absolute/path/to/wood-fired-bugs/data/tasks.db"
      }
    }
  }
}
```

**Critical details:**

- **Absolute paths required**: Relative paths fail (Claude Code doesn't know working directory)
- **Server name**: `wood-fired-bugs` becomes the MCP namespace
- **Command**: `node` (must be in PATH) or absolute path to node binary
- **Args**: Path to compiled `dist/mcp/index.js` (not TypeScript source)
- **Environment variables**: Set per-server, isolated from global environment

**Platform differences:**

| Platform | Config Location |
|----------|----------------|
| macOS | `~/.claude.json` |
| Linux | `~/.claude.json` |
| WSL | `~/.claude.json` |
| Windows | `%USERPROFILE%\.claude.json` |

**Alternative: Project-level configuration**

For team sharing, use `.mcp.json` in project root (checked into git):

```json
{
  "mcpServers": {
    "wood-fired-bugs": {
      "command": "node",
      "args": ["${PROJECT_ROOT}/dist/mcp/index.js"],
      "env": {
        "WOOD_FIRED_BUGS_API_KEY": "${WOOD_FIRED_BUGS_API_KEY}",
        "DB_PATH": "${PROJECT_ROOT}/data/tasks.db"
      }
    }
  }
}
```

**Variable expansion:**
- `${PROJECT_ROOT}`: Expands to project directory
- `${VAR}`: Expands to environment variable
- `${VAR:-default}`: Expands to VAR or default if unset

**Recommendation for v1.2:** Use global `~/.claude.json` to make skills available across all projects. Add `.mcp.json` example to repository for contributors.

**Sources:**
- [MCP Installation Scopes](https://code.claude.com/docs/en/mcp#mcp-installation-scopes)
- [Environment Variable Expansion](https://code.claude.com/docs/en/mcp#environment-variable-expansion-in-mcpjson)

### Installer Architecture

#### Cross-Platform Requirements

The installer must work on:

1. **Linux** (primary): Ubuntu/Debian (systemd-based)
2. **macOS**: Homebrew environment, zsh shell
3. **Windows**: PowerShell 5.1+ or PowerShell Core 7+

**Architecture decision:** Two separate installer scripts instead of unified cross-platform.

**Rationale:**
- Bash and PowerShell have fundamentally different ecosystems
- Separate scripts are simpler to maintain than conditional logic
- Users already know which script to run for their platform
- Enables platform-specific optimizations

**Sources:**
- [Cross-Platform PowerShell Guide](https://medium.com/@josephsims1/powershell-beyond-windows-a-cross-platform-guide-2f6d6de473dd)
- [Tips for Cross-Platform PowerShell](https://powershell.org/2019/02/tips-for-writing-cross-platform-powershell-code/)

#### Bash Installer (`install.sh`)

**Supported platforms:** Linux (Ubuntu 20.04+), macOS (10.15+), WSL2

**Installation steps:**

```bash
#!/usr/bin/env bash
set -euo pipefail

# 1. Detect platform
OS="$(uname -s)"
case "${OS}" in
    Linux*)     PLATFORM=linux;;
    Darwin*)    PLATFORM=macos;;
    *)          echo "Unsupported OS: ${OS}"; exit 1;;
esac

# 2. Verify dependencies
command -v node >/dev/null 2>&1 || { echo "Node.js required"; exit 1; }
command -v npm >/dev/null 2>&1 || { echo "npm required"; exit 1; }

# 3. Determine installation directory (prefer absolute)
INSTALL_DIR="$(cd "$(dirname "$0")" && pwd)"

# 4. Build the project
echo "Building Wood Fired Bugs..."
npm install
npm run build

# 5. Create skills directory
SKILLS_DIR="${HOME}/.claude/commands/tasks"
mkdir -p "${SKILLS_DIR}"

# 6. Copy skill files
echo "Installing Claude Code skills..."
cp -f "${INSTALL_DIR}/skills/"*.md "${SKILLS_DIR}/"

# 7. Generate API key
API_KEY="$(openssl rand -hex 32)"

# 8. Configure MCP server in ~/.claude.json
CLAUDE_CONFIG="${HOME}/.claude.json"
MCP_INDEX="${INSTALL_DIR}/dist/mcp/index.js"
DB_PATH="${INSTALL_DIR}/data/tasks.db"

# Create or update ~/.claude.json
if [[ -f "${CLAUDE_CONFIG}" ]]; then
    # Merge with existing config (use jq if available)
    echo "Updating existing ~/.claude.json..."
    # Implementation: Use jq to merge or manual backup + write
else
    echo "Creating ~/.claude.json..."
    cat > "${CLAUDE_CONFIG}" <<EOF
{
  "mcpServers": {
    "wood-fired-bugs": {
      "command": "node",
      "args": ["${MCP_INDEX}"],
      "env": {
        "WOOD_FIRED_BUGS_API_KEY": "${API_KEY}",
        "DB_PATH": "${DB_PATH}"
      }
    }
  }
}
EOF
fi

# 9. Test MCP server
echo "Testing MCP server..."
echo '{"jsonrpc":"2.0","method":"tools/list","id":1}' | node "${MCP_INDEX}"

# 10. Save API key to .env (for CLI/API access)
ENV_FILE="${INSTALL_DIR}/.env"
if grep -q "WOOD_FIRED_BUGS_API_KEY" "${ENV_FILE}" 2>/dev/null; then
    sed -i.bak "s/WOOD_FIRED_BUGS_API_KEY=.*/WOOD_FIRED_BUGS_API_KEY=${API_KEY}/" "${ENV_FILE}"
else
    echo "WOOD_FIRED_BUGS_API_KEY=${API_KEY}" >> "${ENV_FILE}"
fi

echo ""
echo "✓ Installation complete!"
echo ""
echo "Skills installed to: ${SKILLS_DIR}"
echo "MCP server configured in: ${CLAUDE_CONFIG}"
echo "API key saved to: ${ENV_FILE}"
echo ""
echo "Next steps:"
echo "  1. Restart Claude Code"
echo "  2. Try: /tasks:create Create my first task"
echo "  3. Or just ask Claude: Create a high priority task for user testing"
```

**Key patterns:**

- **Error handling**: `set -euo pipefail` stops on first error
- **Dependency checks**: `command -v` verifies tools exist
- **Absolute paths**: `$(cd "$(dirname "$0")" && pwd)` resolves script directory
- **Directory creation**: `mkdir -p` creates parent directories, no error if exists
- **File copying**: `cp -f` overwrites existing skills
- **API key generation**: `openssl rand -hex 32` creates 64-char hex string
- **JSON manipulation**: Use `jq` if available, otherwise write entire file
- **Testing**: Send JSON-RPC message to verify MCP server responds

**Sources:**
- [Bash Installer Best Practices](https://www.baeldung.com/linux/create-destination-directory)
- [Chmod +x Command](https://www.warp.dev/terminus/chmod-x)

#### PowerShell Installer (`install.ps1`)

**Supported platforms:** Windows 10+, PowerShell 5.1 or PowerShell Core 7+

**Installation steps:**

```powershell
#Requires -Version 5.1
$ErrorActionPreference = "Stop"

# 1. Verify dependencies
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Error "Node.js is required. Install from https://nodejs.org/"
    exit 1
}
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    Write-Error "npm is required. Install Node.js from https://nodejs.org/"
    exit 1
}

# 2. Determine installation directory (absolute path)
$InstallDir = Split-Path -Parent $PSCommandPath

# 3. Build the project
Write-Host "Building Wood Fired Bugs..." -ForegroundColor Green
Set-Location $InstallDir
npm install
npm run build

# 4. Create skills directory
$SkillsDir = Join-Path $env:USERPROFILE ".claude\commands\tasks"
New-Item -ItemType Directory -Force -Path $SkillsDir | Out-Null

# 5. Copy skill files
Write-Host "Installing Claude Code skills..." -ForegroundColor Green
Copy-Item -Path (Join-Path $InstallDir "skills\*.md") -Destination $SkillsDir -Force

# 6. Generate API key
$ApiKey = -join ((1..32) | ForEach-Object { '{0:x2}' -f (Get-Random -Maximum 256) })

# 7. Configure MCP server in %USERPROFILE%\.claude.json
$ClaudeConfig = Join-Path $env:USERPROFILE ".claude.json"
$McpIndex = Join-Path $InstallDir "dist\mcp\index.js"
$DbPath = Join-Path $InstallDir "data\tasks.db"

# Create or update .claude.json
if (Test-Path $ClaudeConfig) {
    Write-Host "Updating existing .claude.json..." -ForegroundColor Yellow
    # Implementation: Parse JSON, merge, write back
    # For simplicity, backup and overwrite (or use ConvertFrom-Json/ConvertTo-Json)
} else {
    Write-Host "Creating .claude.json..." -ForegroundColor Green
    $Config = @{
        mcpServers = @{
            "wood-fired-bugs" = @{
                command = "node"
                args = @($McpIndex)
                env = @{
                    WOOD_FIRED_BUGS_API_KEY = $ApiKey
                    DB_PATH = $DbPath
                }
            }
        }
    }
    $Config | ConvertTo-Json -Depth 10 | Set-Content -Path $ClaudeConfig -Encoding UTF8
}

# 8. Test MCP server
Write-Host "Testing MCP server..." -ForegroundColor Green
$TestRequest = '{"jsonrpc":"2.0","method":"tools/list","id":1}'
$TestRequest | node $McpIndex

# 9. Save API key to .env
$EnvFile = Join-Path $InstallDir ".env"
if (Test-Path $EnvFile) {
    $EnvContent = Get-Content $EnvFile
    $EnvContent = $EnvContent -replace 'WOOD_FIRED_BUGS_API_KEY=.*', "WOOD_FIRED_BUGS_API_KEY=$ApiKey"
    $EnvContent | Set-Content $EnvFile
} else {
    "WOOD_FIRED_BUGS_API_KEY=$ApiKey" | Set-Content $EnvFile
}

Write-Host ""
Write-Host "✓ Installation complete!" -ForegroundColor Green
Write-Host ""
Write-Host "Skills installed to: $SkillsDir"
Write-Host "MCP server configured in: $ClaudeConfig"
Write-Host "API key saved to: $EnvFile"
Write-Host ""
Write-Host "Next steps:"
Write-Host "  1. Restart Claude Code"
Write-Host "  2. Try: /tasks:create Create my first task"
Write-Host "  3. Or just ask Claude: Create a high priority task for user testing"
```

**Key patterns:**

- **Requirements check**: `#Requires -Version 5.1` enforces minimum PowerShell version
- **Error handling**: `$ErrorActionPreference = "Stop"` stops on first error
- **Path handling**: `Join-Path` for cross-platform path construction (handles backslashes)
- **Directory creation**: `New-Item -ItemType Directory -Force` creates if missing
- **File copying**: `Copy-Item -Force` overwrites existing skills
- **API key generation**: `Get-Random` + hex formatting
- **JSON handling**: `ConvertTo-Json` / `ConvertFrom-Json` for .claude.json
- **Testing**: Pipe JSON to node process

**PowerShell gotchas:**

- **Encoding**: Use `-Encoding UTF8` when writing JSON to avoid BOM
- **Depth**: `ConvertTo-Json -Depth 10` prevents truncation of nested objects
- **Paths**: PowerShell uses backslashes on Windows, use `Join-Path` for portability
- **Execution policy**: User may need to run `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`

**Sources:**
- [PowerShell Environment Variables](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_environment_variables)
- [PowerShell Copy-Item Guide](https://petri.com/powershell-copy-item-to-copy-files/)
- [PowerShell Cross-Platform Tips](https://jdhitsolutions.com/blog/scripting/7361/powershell-7-cross-platform-scripting-tips-and-traps/)

## Architectural Patterns

### Pattern 1: Skill-MCP Separation

**What:** Skills contain instructions for Claude, MCP tools implement the actual operations. Skills **reference** tools by name, not call them directly.

**When to use:** Always, for all Claude Code integrations.

**Example:**

```markdown
<!-- skills/create.md -->
---
name: create
description: Create a new task in the tracking system
---

## Procedure

1. Ask user for task title (required)
2. Call `mcp__wood-fired-bugs__create_task` with:
   - title: <user input>
   - priority: medium (unless user specifies)
   - status: todo
3. Report task ID and confirmation
```

**Trade-offs:**

- **Pro:** Clear separation of concerns (instructions vs implementation)
- **Pro:** Skills can evolve independently from MCP server
- **Pro:** Users can edit skills without touching code
- **Con:** Requires both skill file and MCP tool to work
- **Con:** Tool names must stay synchronized

### Pattern 2: Namespace Prefix for Skills

**What:** Use `/tasks:*` namespace for all skills to avoid collision with built-in commands or other plugins.

**When to use:** Always, for any project distributing Claude Code skills.

**Example:**

```markdown
---
name: create          # Becomes /tasks:create (with namespace)
description: ...
---
```

**Namespace is set by installation directory:**

```
~/.claude/commands/tasks/create.md    → /tasks:create
~/.claude/commands/git/commit.md      → /git:commit
~/.claude/commands/test/run.md        → /test:run
```

**Trade-offs:**

- **Pro:** Prevents name collisions (`/create` too generic, `/tasks:create` specific)
- **Pro:** User can discover all task-related commands with `/tasks:`
- **Pro:** Multiple projects can coexist (tasks, git, docker, etc.)
- **Con:** Slightly longer command names
- **Con:** Users must know namespace (but autocomplete helps)

**Alternative considered:** No namespace (skills at `~/.claude/commands/`).

**Rejected because:** Too likely to conflict with other skills. `/create` could mean create task, create file, create PR, etc.

### Pattern 3: Global MCP Server Configuration

**What:** Configure MCP server in `~/.claude.json` (user-level) instead of project `.mcp.json`.

**When to use:** When users need access to the service across multiple projects.

**Example:**

```json
// ~/.claude.json (global)
{
  "mcpServers": {
    "wood-fired-bugs": {
      "command": "node",
      "args": ["/absolute/path/to/dist/mcp/index.js"],
      "env": { "WOOD_FIRED_BUGS_API_KEY": "..." }
    }
  }
}
```

**Alternative: Project-level configuration**

```json
// .mcp.json (project root, checked into git)
{
  "mcpServers": {
    "wood-fired-bugs": {
      "command": "node",
      "args": ["${PROJECT_ROOT}/dist/mcp/index.js"],
      "env": { "WOOD_FIRED_BUGS_API_KEY": "${WOOD_FIRED_BUGS_API_KEY}" }
    }
  }
}
```

**Trade-offs:**

| Approach | Pros | Cons |
|----------|------|------|
| Global (`~/.claude.json`) | Available everywhere, survives project deletion, single API key | Requires absolute paths, not shareable with team |
| Project (`.mcp.json`) | Shareable via git, relative paths with `${PROJECT_ROOT}` | Each project needs configuration, API key in env |

**Recommendation for v1.2:** Global configuration. Wood Fired Bugs is a network-wide service (like GitHub or Slack), not project-specific. Users want access everywhere.

**Future consideration:** Support both. Installer creates global config, repository includes `.mcp.json` example for contributors.

### Pattern 4: Installer Tests MCP Connectivity

**What:** Installer sends a test JSON-RPC request to MCP server before completing.

**When to use:** Always, for any MCP server installer.

**Example:**

```bash
# Send tools/list request to verify server responds
echo '{"jsonrpc":"2.0","method":"tools/list","id":1}' | node dist/mcp/index.js
```

**Expected response:**

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "tools": [
      {"name": "create_task", "description": "..."},
      {"name": "list_tasks", "description": "..."}
      // ... 25 tools
    ]
  }
}
```

**Trade-offs:**

- **Pro:** Catches configuration errors before user tries skills
- **Pro:** Verifies node path, file permissions, database access
- **Pro:** Immediate feedback (fails fast)
- **Con:** Requires database to exist (installer should create if missing)
- **Con:** May fail if environment variables not set (check before test)

**Implementation note:** Installer should create `data/tasks.db` if missing (run migrations) before testing MCP server.

### Pattern 5: Auto-Generated API Keys

**What:** Installer generates unique API key instead of asking user to create one.

**When to use:** When API key is for single-user access (not shared).

**Example:**

```bash
# Bash
API_KEY="$(openssl rand -hex 32)"

# PowerShell
$ApiKey = -join ((1..32) | ForEach-Object { '{0:x2}' -f (Get-Random -Maximum 256) })
```

**Trade-offs:**

- **Pro:** Zero user friction (no manual key creation)
- **Pro:** Cryptographically secure (64 hex chars = 256 bits)
- **Pro:** Unique per installation
- **Con:** User can't choose memorable key (but not needed for MCP auth)
- **Con:** Must save to both `.env` (for server) and `~/.claude.json` (for MCP)

**Alternative:** Ask user to provide API key.

**Rejected because:** MCP tools authenticate via environment variable, user never sees it. Auto-generation is simpler.

## Data Flow

### Skill Invocation Flow

```
User Request
    ↓
Claude Code: Parse intent
    ↓
Match skill description → Load /tasks:create skill
    ↓
Skill instructions: "Use mcp__wood-fired-bugs__create_task"
    ↓
Claude Code: Locate MCP server "wood-fired-bugs" in ~/.claude.json
    ↓
Spawn MCP server: node dist/mcp/index.js (stdio)
    ↓
MCP Server: Initialize database, services
    ↓
Claude Code: Send JSON-RPC request to stdio
    ↓
    {"jsonrpc":"2.0","method":"tools/call","params":{
      "name":"create_task",
      "arguments":{"title":"Fix login bug","priority":"high"}
    }}
    ↓
MCP Server: Route to task-tools.ts registerTool('create_task')
    ↓
Tool handler: Validate with Zod schema
    ↓
TaskService.createTask(validated)
    ↓
TaskRepository: INSERT INTO tasks
    ↓
SQLite: Write to database
    ↓
TaskRepository → TaskService → Tool handler
    ↓
MCP Server: Format response
    ↓
    {"jsonrpc":"2.0","id":1,"result":{
      "content":[{"type":"text","text":"Task created: Fix login bug (ID: 42)"}],
      "structuredContent":{"id":42,"title":"Fix login bug",...}
    }}
    ↓
Claude Code: Parse response
    ↓
Skill instructions: "Report task ID and confirmation"
    ↓
Claude: "I've created task #42: Fix login bug"
    ↓
User sees result
```

### Installer Flow (Bash)

```
User runs: ./install/install.sh
    ↓
Detect platform (Linux/macOS/WSL)
    ↓
Verify dependencies (node, npm, openssl)
    ↓
Build project (npm install && npm run build)
    ↓
Create ~/.claude/commands/tasks/ directory
    ↓
Copy skills/*.md → ~/.claude/commands/tasks/
    ↓
Generate API key (openssl rand -hex 32)
    ↓
Check if ~/.claude.json exists
    ↓
    If exists: Backup + merge (use jq if available)
    If not: Create new file
    ↓
Write MCP server config to ~/.claude.json
    ↓
    {
      "mcpServers": {
        "wood-fired-bugs": {
          "command": "node",
          "args": ["/absolute/path/dist/mcp/index.js"],
          "env": {"WOOD_FIRED_BUGS_API_KEY":"..."}
        }
      }
    }
    ↓
Test MCP server (echo JSON | node dist/mcp/index.js)
    ↓
    Success: Server responds with tool list
    Failure: Show error, rollback config
    ↓
Save API key to .env file (for CLI/REST API)
    ↓
Print success message + next steps
    ↓
User restarts Claude Code
    ↓
Skills available at /tasks:*
```

### Key Data Interactions

**Skill → MCP Tool:**
- Skills reference tools by name: `mcp__wood-fired-bugs__create_task`
- Claude Code resolves tool → MCP server from `~/.claude.json`
- No direct coupling (skill doesn't know tool implementation)

**MCP Server → Services:**
- MCP tools call service methods directly (no REST API)
- Same service layer as CLI and REST API (shared business logic)
- Zod schemas validate input before service call

**Installer → Configuration:**
- Installer writes to `~/.claude.json` (MCP config)
- Installer writes to `.env` (API key for REST/CLI)
- Both use same API key (single source of truth)

## Integration Points

### New Components Summary

| Component | Type | Location | Purpose |
|-----------|------|----------|---------|
| Skill files (10) | Markdown | `skills/*.md` | Claude instructions for task operations |
| Bash installer | Script | `install/install.sh` | Linux/macOS installation |
| PowerShell installer | Script | `install/install.ps1` | Windows installation |
| Install README | Docs | `install/README.md` | Installation instructions |
| MCP config template | JSON | `install/mcp-config.example.json` | Example for manual setup |

### Modified Components

| Component | Change | Reason |
|-----------|--------|--------|
| `package.json` | Add `"postinstall": "echo Run install/install.sh"` | Remind users to run installer |
| `package.json` | Add `"scripts": {"install:skills": "./install/install.sh"}` | Convenient install command |
| `.gitignore` | Add `~/.claude.json` to example | Don't commit user configs |
| `README.md` | Add "Installation" section | Document installer usage |

### No Changes Needed

These components work as-is:

- `src/mcp/` — MCP server already implements 25 tools
- `src/services/` — Business logic complete
- `src/db/` — Database schema supports all operations
- MCP server entry point (`dist/mcp/index.js`) — Already stdio-compatible

### External Dependencies

| Dependency | Version | Purpose | Installer Validates |
|------------|---------|---------|---------------------|
| Node.js | 18+ | Run MCP server | Yes (`node --version`) |
| npm | 8+ | Build project | Yes (`npm --version`) |
| openssl | Any | Generate API keys (Bash) | Optional (fallback to /dev/urandom) |
| PowerShell | 5.1+ | Run installer (Windows) | Yes (`#Requires -Version 5.1`) |

**Optional dependencies:**

- `jq` (Bash): Merge existing `~/.claude.json` instead of overwrite
- `git` (both): Check project version, show install location

## Build Order

Recommended implementation sequence for v1.2:

### Phase 1: Skill Files (Build first)

1. Create `skills/` directory at project root
2. Write 10 skill markdown files:
   - `create.md` — Create tasks
   - `list.md` — List/filter tasks
   - `update.md` — Update tasks
   - `get.md` — Get task details
   - `delete.md` — Delete tasks
   - `project.md` — Project management (create, list, update, delete)
   - `dependency.md` — Dependency management (add, remove, list)
   - `comment.md` — Comment operations (add, list, delete)
   - `subtask.md` — Subtask operations (create, list)
   - `health.md` — System health check

**Template for each skill:**

```markdown
---
name: <verb>
description: <when to use> <what it does> <key capabilities>
---

# <Title>

<Brief description>

## When to Use

- <Trigger phrase 1>
- <Trigger phrase 2>

## MCP Tools Used

- `mcp__wood-fired-bugs__<tool_name>`: <purpose>

## Procedure

1. <Step 1>
2. <Step 2>
3. <Step 3>

## Examples

**<Scenario>:**
> "<User request>"
```

### Phase 2: Bash Installer (Build second)

3. Create `install/` directory
4. Write `install/install.sh`:
   - Platform detection (Linux, macOS, WSL)
   - Dependency verification (node, npm)
   - Project build (npm install && npm run build)
   - Skills installation (copy to `~/.claude/commands/tasks/`)
   - API key generation
   - MCP configuration (`~/.claude.json`)
   - Connectivity test
   - .env file update
   - Success message
5. Test on Linux (Ubuntu 20.04, 22.04, 24.04)
6. Test on macOS (Intel and Apple Silicon)
7. Test on WSL2

### Phase 3: PowerShell Installer (Build third)

8. Write `install/install.ps1`:
   - Dependency verification (node, npm)
   - Project build
   - Skills installation (copy to `%USERPROFILE%\.claude\commands\tasks\`)
   - API key generation (PowerShell method)
   - MCP configuration (`%USERPROFILE%\.claude.json`)
   - Connectivity test
   - .env file update
   - Success message
9. Test on Windows 10 (PowerShell 5.1)
10. Test on Windows 11 (PowerShell 7)

### Phase 4: Documentation (Build fourth)

11. Write `install/README.md`:
    - Prerequisites (Node.js 18+, Claude Code)
    - Installation steps (Linux/macOS vs Windows)
    - Verification steps
    - Troubleshooting
    - Manual installation instructions
12. Update project `README.md`:
    - Add "Installation" section
    - Link to `install/README.md`
    - Add "Usage with Claude Code" section
13. Create `install/mcp-config.example.json`:
    - Template for manual setup
    - Placeholders for paths and API key

### Phase 5: Testing & Validation (Build last)

14. End-to-end testing:
    - Run installer on each platform
    - Restart Claude Code
    - Test each skill (`/tasks:create`, `/tasks:list`, etc.)
    - Test manual MCP server start
    - Test API key authentication
15. Edge case testing:
    - Install with existing `~/.claude.json`
    - Install with existing skills directory
    - Install without Claude Code installed (should work, verify later)
    - Reinstall (update scenario)
16. Documentation review:
    - Verify all commands are correct
    - Test copy-paste instructions
    - Check troubleshooting steps

**Rationale for ordering:**

- Skills first: Define the interface, informs installer requirements
- Bash second: Primary platform (Linux servers), most users
- PowerShell third: Smaller user base, can learn from Bash installer
- Documentation fourth: Describes working system
- Testing last: Validates all components together

**Dependencies:**

- Phase 1 (Skills): No dependencies
- Phase 2 (Bash): Depends on skills existing
- Phase 3 (PowerShell): Can be parallel with Phase 2 (same requirements)
- Phase 4 (Docs): Depends on installers working
- Phase 5 (Testing): Depends on all previous phases

## Anti-Patterns

### Anti-Pattern 1: Skills Execute MCP Tools Directly

**What people do:** Try to include MCP tool calls in skill frontmatter or use special syntax.

**Why it's wrong:**

- Skills are markdown instructions, not executable code
- Claude Code resolves tool names and handles invocation
- Skills guide Claude's reasoning, they don't call tools

**Do this instead:** Reference tools by name in procedure section, let Claude Code invoke them.

**Example (wrong):**

```markdown
---
name: create
execute: mcp__wood-fired-bugs__create_task  # ❌ No "execute" field
---
```

**Example (correct):**

```markdown
---
name: create
description: Create tasks
---

## Procedure

1. Use `mcp__wood-fired-bugs__create_task` with parameters  # ✅ Reference in instructions
```

### Anti-Pattern 2: Relative Paths in MCP Configuration

**What people do:** Use relative paths in `~/.claude.json`.

```json
{
  "mcpServers": {
    "wood-fired-bugs": {
      "command": "node",
      "args": ["./dist/mcp/index.js"]  // ❌ Relative path
    }
  }
}
```

**Why it's wrong:**

- Claude Code doesn't know working directory (could be anywhere)
- MCP server fails to start ("Cannot find module")
- Hard to debug (no error message about path)

**Do this instead:** Always use absolute paths.

```json
{
  "mcpServers": {
    "wood-fired-bugs": {
      "command": "node",
      "args": ["/home/user/wood-fired-bugs/dist/mcp/index.js"]  // ✅ Absolute
    }
  }
}
```

**Or use `${PROJECT_ROOT}` in `.mcp.json`:**

```json
{
  "mcpServers": {
    "wood-fired-bugs": {
      "command": "node",
      "args": ["${PROJECT_ROOT}/dist/mcp/index.js"]  // ✅ Variable expansion
    }
  }
}
```

### Anti-Pattern 3: Skills Without Namespace

**What people do:** Install skills at `~/.claude/commands/` root.

```
~/.claude/commands/
├── create.md         # ❌ Global namespace
├── list.md           # ❌ Conflicts with other tools
└── update.md         # ❌ Too generic
```

**Why it's wrong:**

- Name collisions (`/create` could mean create task, create file, create PR)
- Hard to discover related skills
- Can't distinguish origin (which project provides this skill?)

**Do this instead:** Use subdirectory for namespace.

```
~/.claude/commands/
└── tasks/            # ✅ Namespace prefix
    ├── create.md     # Becomes /tasks:create
    ├── list.md       # Becomes /tasks:list
    └── update.md     # Becomes /tasks:update
```

### Anti-Pattern 4: Installer Overwrites User Configuration

**What people do:** Installer writes `~/.claude.json` without checking existing content.

```bash
# ❌ WRONG: Destroys existing MCP servers
cat > ~/.claude.json <<EOF
{
  "mcpServers": {
    "wood-fired-bugs": { ... }
  }
}
EOF
```

**Why it's wrong:**

- User loses other MCP server configurations
- Can't reinstall without backing up manually
- Violates principle of least surprise

**Do this instead:** Merge with existing configuration.

```bash
# ✅ CORRECT: Preserve existing servers
if [[ -f ~/.claude.json ]]; then
    # Backup
    cp ~/.claude.json ~/.claude.json.backup

    # Merge (use jq if available)
    jq '.mcpServers."wood-fired-bugs" = {<config>}' ~/.claude.json > /tmp/claude.json
    mv /tmp/claude.json ~/.claude.json
else
    # Create new
    cat > ~/.claude.json <<EOF
    {
      "mcpServers": {
        "wood-fired-bugs": { ... }
      }
    }
    EOF
fi
```

**Alternative:** Always backup, show user where backup is.

### Anti-Pattern 5: No Installer Validation

**What people do:** Assume installation worked, don't test MCP server.

**Why it's wrong:**

- User tries skill, MCP server fails silently
- Hard to debug (user doesn't know what went wrong)
- Poor user experience (feels broken)

**Do this instead:** Test MCP server before completing.

```bash
# Test MCP server responds
echo "Testing MCP server..."
RESPONSE=$(echo '{"jsonrpc":"2.0","method":"tools/list","id":1}' | node dist/mcp/index.js)

if echo "$RESPONSE" | grep -q '"result"'; then
    echo "✓ MCP server is working"
else
    echo "✗ MCP server failed to respond"
    echo "Response: $RESPONSE"
    exit 1
fi
```

**Validation checklist:**

- [ ] Node.js installed and in PATH
- [ ] npm installed and in PATH
- [ ] Project builds successfully
- [ ] Skills directory created
- [ ] Skill files copied
- [ ] `~/.claude.json` exists and is valid JSON
- [ ] MCP server responds to test request
- [ ] API key saved to `.env`

## Scaling Considerations

| Scale | Architecture Adjustments |
|-------|--------------------------|
| 1-10 users (v1.2) | Single MCP server, global `~/.claude.json`, 10 skills. Manual installation. |
| 10-100 users | Add auto-updater (check GitHub releases), team `.mcp.json` example, skill discovery (list available skills). |
| 100+ users | MCP server as HTTP endpoint (not stdio), centralized API key management, skill marketplace/registry, installer via package manager (Homebrew, Scoop). |

### Scaling Priorities

1. **First bottleneck:** Manual installation per user.
   - **Fix:** Package as npm global (`npm install -g wood-fired-bugs-skills`), auto-runs installer.

2. **Second bottleneck:** API key distribution/rotation.
   - **Fix:** OAuth integration or API key server (fetch key from central service).

3. **Third bottleneck:** Skill updates (user doesn't know when new skills available).
   - **Fix:** Auto-update checker (compare local skills with GitHub repository).

4. **Fourth bottleneck:** MCP server performance (stdio has latency).
   - **Fix:** HTTP transport instead of stdio (MCP supports SSE, WebSocket).

**v1.2 focus:** Single-user installation, stdio transport. Defer scaling to v1.3+.

## Verification Checklist

Before marking v1.2 complete:

**Skills:**
- [ ] 10 skill files created in `skills/` directory
- [ ] Each skill has YAML frontmatter (name, description)
- [ ] Each skill references correct MCP tools by full name
- [ ] Skills use `/tasks:*` namespace
- [ ] Skill descriptions are comprehensive (when to use + what it does)

**Installers:**
- [ ] `install/install.sh` exists and is executable (`chmod +x`)
- [ ] `install/install.ps1` exists
- [ ] Both installers validate dependencies (node, npm)
- [ ] Both installers build project (`npm install && npm run build`)
- [ ] Both installers copy skills to correct directory
- [ ] Both installers generate unique API key
- [ ] Both installers configure MCP server in `~/.claude.json`
- [ ] Both installers test MCP server connectivity
- [ ] Both installers save API key to `.env`

**Documentation:**
- [ ] `install/README.md` exists with prerequisites and steps
- [ ] Project `README.md` updated with "Installation" section
- [ ] `install/mcp-config.example.json` exists for manual setup

**Testing:**
- [ ] Installer tested on Linux (Ubuntu 20.04, 22.04, 24.04)
- [ ] Installer tested on macOS (Intel and Apple Silicon)
- [ ] Installer tested on Windows 10 + 11 (PowerShell 5.1 and 7)
- [ ] Skills tested in Claude Code (`/tasks:create`, `/tasks:list`, etc.)
- [ ] MCP server responds to manual test (`echo JSON | node dist/mcp/index.js`)
- [ ] Reinstall scenario tested (existing `~/.claude.json` preserved)

**Integration:**
- [ ] Skills reference all 25 MCP tools
- [ ] No orphaned MCP tools (every tool referenced by at least one skill)
- [ ] Namespace `/tasks:*` doesn't conflict with built-in commands
- [ ] API key works for REST API, CLI, and MCP server

## Sources

**Claude Code Documentation:**
- [Extend Claude with Skills](https://code.claude.com/docs/en/skills)
- [Connect Claude Code to MCP](https://code.claude.com/docs/en/mcp)
- [MCP Installation Scopes](https://code.claude.com/docs/en/mcp#mcp-installation-scopes)
- [Skills vs MCP Comparison](https://claude.com/blog/skills-explained)

**Agent Skills Standard:**
- [GitHub: anthropics/skills](https://github.com/anthropics/skills)
- [Agent Skills Official Site](https://agentskills.io)

**Cross-Platform Scripting:**
- [PowerShell Beyond Windows Guide](https://medium.com/@josephsims1/powershell-beyond-windows-a-cross-platform-guide-2f6d6de473dd)
- [Cross-Platform PowerShell Tips](https://powershell.org/2019/02/tips-for-writing-cross-platform-powershell-code/)
- [PowerShell Cross-Platform Traps](https://jdhitsolutions.com/blog/scripting/7361/powershell-7-cross-platform-scripting-tips-and-traps/)

**Installation Scripting:**
- [Bash: Copy and Create Destination Directory](https://www.baeldung.com/linux/create-destination-directory)
- [Bash: Chmod +x Command](https://www.warp.dev/terminus/chmod-x)
- [PowerShell: Environment Variables](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_environment_variables)
- [PowerShell: Copy-Item Guide](https://petri.com/powershell-copy-item-to-copy-files/)

**MCP Configuration:**
- [Configuring MCP Tools in Claude Code](https://scottspence.com/posts/configuring-mcp-tools-in-claude-code)
- [Understanding Claude Code Full Stack](https://alexop.dev/posts/understanding-claude-code-full-stack/)

---
*Architecture research for: Wood Fired Bugs v1.2 - Claude Code Skills & Installer*
*Researched: 2026-02-13*
*Confidence: HIGH*
