# Wood Fired Bugs - Client Setup

This package gives any developer on the local network full access to the
Wood Fired Bugs task management system via Claude Code.

Once set up, you can use `/tasks:create-task`, `/tasks:my-work`, `/tasks:done`,
and 7 more slash commands directly in Claude Code from any project.

---

## Prerequisites

- **Node.js 18+** installed — [download from nodejs.org](https://nodejs.org/)
- **Claude Code** installed — [claude.ai/claude-code](https://claude.ai/claude-code)
- Network access to the backend server (default: `http://192.168.69.69:3000`)
- Your API key (ask the server admin)

---

## Quick Start

### Windows

Open PowerShell, navigate to this directory, and run:

```powershell
.\setup.ps1 -ApiKey "your-api-key-here"
```

With a custom server URL:

```powershell
.\setup.ps1 -ServerUrl "http://192.168.1.100:3000" -ApiKey "your-api-key-here"
```

### Linux / Mac

Open a terminal, navigate to this directory, and run:

```bash
chmod +x setup.sh
./setup.sh --api-key "your-api-key-here"
```

With a custom server URL:

```bash
./setup.sh --server-url "http://192.168.1.100:3000" --api-key "your-api-key-here"
```

### After Setup

1. Open Claude Code in any project
2. Type `/tasks:my-work` and press Enter
3. Claude will list your assigned tasks from the shared backend

---

## Available Commands

| Command | Description |
|---------|-------------|
| `/tasks:create-task [title]` | Create a new task in a project |
| `/tasks:my-work` | List your assigned tasks grouped by status |
| `/tasks:pick-up [task-id]` | Assign a task to yourself and start working |
| `/tasks:done [task-id]` | Mark a task as complete |
| `/tasks:search [keyword]` | Search tasks by keyword |
| `/tasks:show-task [task-id]` | Show full task details, comments, and dependencies |
| `/tasks:log-bug [title]` | Create a high-priority bug report |
| `/tasks:add-comment [task-id] [text]` | Add a comment to a task |
| `/tasks:blocked [task-id] [reason]` | Mark a task as blocked with a reason |
| `/tasks:project-status` | View project status overview with completion % |

---

## Troubleshooting

### Check backend connectivity

```bash
curl http://192.168.69.69:3000/health
```

Expected response: `{"status":"healthy","version":"1.0.0",...}`

If this fails:
- Verify you're on the same network as the backend
- Check the server IP address with your admin
- Ensure the server is running

### Check Node.js version

```bash
node --version
```

Must be v18.0.0 or higher.

### Test the MCP server manually

After running setup, test the MCP server directly:

**Windows (PowerShell):**
```powershell
$env:WFB_API_URL="http://192.168.69.69:3000"
$env:WFB_API_KEY="your-api-key-here"
node ".\mcp-server\dist\mcp\remote\index.js"
```

Expected output (to stderr):
```
Wood Fired Bugs MCP Server (remote) running on stdio
Connected to backend: http://192.168.69.69:3000
```

**Linux/Mac:**
```bash
WFB_API_URL=http://192.168.69.69:3000 \
WFB_API_KEY=your-api-key-here \
node ./mcp-server/dist/mcp/remote/index.js
```

### MCP server not found in Claude Code

1. Restart Claude Code after running setup
2. Check `~/.claude/settings.json` (Linux/Mac) or `%USERPROFILE%\.claude\settings.json` (Windows)
3. Verify the `mcpServers.wood-fired-bugs` entry exists with correct paths

### Skills not appearing

Verify the skill files are installed:

**Windows:** Check `%USERPROFILE%\.claude\commands\tasks\`
**Linux/Mac:** Check `~/.claude/commands/tasks/`

You should see 10 `.md` files. If missing, re-run the setup script.

---

## Architecture

```
Your Machine (Claude Code)                  Linux Backend
┌─────────────────────────────────┐         ┌──────────────────────┐
│  Claude Code                    │         │  Wood Fired Bugs      │
│  ┌──────────────────────────┐   │  HTTP   │  REST API             │
│  │  Remote MCP Server       │───┼────────>│  :3000                │
│  │  (mcp-server/)           │   │         │                        │
│  │  Proxies all 26 tools    │   │         │  SQLite database       │
│  └──────────────────────────┘   │         └──────────────────────┘
│                                 │
│  /tasks: skill commands         │
│  (~/.claude/commands/tasks/)    │
└─────────────────────────────────┘
```

The MCP server runs locally as a subprocess of Claude Code (via stdio transport).
It forwards all tool calls to the backend REST API over HTTP. Your API key is
stored in Claude Code's `settings.json` and passed to the MCP server as an
environment variable — it never leaves your machine unencrypted.
