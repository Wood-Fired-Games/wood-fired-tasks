# Wood Fired Tasks - Client Setup

This package gives any developer on the local network full access to the
Wood Fired Tasks task management system via Claude Code and the `tasks` CLI.

Once set up, you get:
- **10 `/tasks:*` slash commands** in Claude Code (`/tasks:create-task`, `/tasks:my-work`, etc.)
- **`tasks` CLI** in your terminal (`tasks list`, `tasks show 1`, `tasks create`, etc.)
- **MCP server** providing all 26 tools to Claude Code

---

## Prerequisites

- **Node.js 18+** installed — [download from nodejs.org](https://nodejs.org/)
- **Claude Code** installed — [claude.ai/claude-code](https://claude.ai/claude-code)
- Network access to the backend server (default: `http://localhost:3000` — override with `--server-url` or `WFT_API_URL` to target a remote host like `http://your-server.local:3000`)
- Your API key (ask the server admin)

---

## Quick Start

The setup scripts resolve the API key in this order (most secure first):

1. `WFT_API_KEY` environment variable
2. Per-user secret file
   - Windows: `%LOCALAPPDATA%\wood-fired-tasks\api-key` (user-only ACL)
   - Linux / Mac: `~/.config/wood-fired-tasks/api-key` (mode 600)
3. Masked interactive prompt
4. `--api-key` / `-ApiKey` / positional CLI argument — **deprecated**. Command-line
   secrets leak through shell history (`~/.bash_history`, PowerShell `ConsoleHost_history.txt`)
   and process listings (`ps -ef`, `Get-Process`, `wmic process get commandline`). The
   flag still works for one release but emits a warning.

After the first successful setup the key is cached in the per-user secret file,
so subsequent re-runs and the `tasks` CLI wrapper just read it from disk — no
env var, no prompt, no argv.

### Windows

Set the env var, then run with no key on argv:

```powershell
$env:WFT_API_KEY = "your-api-key-here"
.\setup.bat
```

Or let setup.bat prompt:

```
setup.bat
```

With a custom server URL (no key required on argv — setup will prompt):

```
setup.bat http://192.0.2.100:3000
```

PowerShell direct form:

```powershell
$env:WFT_API_KEY = "your-api-key-here"
powershell -ExecutionPolicy Bypass -File .\setup.ps1
```

> **Deprecated** (key on argv leaks): `setup.bat YOUR_API_KEY` or
> `.\setup.ps1 -ApiKey "your-api-key-here"`. Still works, emits a warning.

### Linux / Mac

Set the env var, then run with no key on argv:

```bash
chmod +x setup.sh
WFT_API_KEY="your-api-key-here" ./setup.sh
```

Or let setup.sh prompt:

```bash
./setup.sh
```

With a custom server URL:

```bash
WFT_API_KEY="your-api-key-here" ./setup.sh --server-url "http://192.0.2.100:3000"
```

> **Deprecated** (key on argv leaks): `./setup.sh --api-key "your-api-key-here"`.
> Still works, emits a warning.

### After Setup

**Open a new terminal** (required for PATH changes to take effect), then:

1. Run `tasks list` to see all tasks
2. Open Claude Code in any project and type `/tasks:my-work`

---

## Tasks CLI

The setup script installs the `tasks` command to your PATH. Open a **new terminal**
after setup for the PATH change to take effect.

### Common Commands

```
tasks list                    List all tasks
tasks list --status open      Filter by status
tasks list --assignee alice   Filter by assignee
tasks show 42                 Show full details for task 42
tasks create                  Create a task interactively
tasks update 42 --status done Mark task 42 as done
tasks claim 42                Claim task 42
```

### All CLI Commands

| Command | Description |
|---------|-------------|
| `tasks create` | Create a new task (interactive) |
| `tasks list` | List tasks with optional filters |
| `tasks show <id>` | Show task details |
| `tasks update <id>` | Update a task |
| `tasks delete <id>` | Delete a task |
| `tasks claim <id>` | Claim an unassigned task |
| `tasks project-create` | Create a new project |
| `tasks project-list` | List all projects |
| `tasks project-show <id>` | Show project details |
| `tasks project-update <id>` | Update a project |
| `tasks project-delete <id>` | Delete a project |
| `tasks dep-add <id> <blocks-id>` | Add a dependency |
| `tasks dep-remove <id> <blocks-id>` | Remove a dependency |
| `tasks dep-list <id>` | List dependencies |
| `tasks comment-add <id>` | Add a comment |
| `tasks comment-list <id>` | List comments |
| `tasks comment-delete <task-id> <comment-id>` | Delete a comment |
| `tasks subtask-create <parent-id>` | Create a subtask |
| `tasks subtask-list <parent-id>` | List subtasks |
| `tasks health` | Check backend connectivity |

All commands support `--json` for machine-readable output and `--help` for usage details.

> **Note:** Server-only commands (`backup`, `doctor`, `stats`, `db-check`) are not
> available in the client CLI — they require direct database access on the backend.

---

## Claude Code Slash Commands

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
curl http://localhost:3000/health
# Or, when the backend lives on another host:
# curl http://your-server.local:3000/health
```

Or using the CLI:

```
tasks health
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

### "tasks" command not found

Open a **new terminal** after running setup — PATH changes only apply to new sessions.

If still not found, check that the `bin` directory inside this package is on your PATH:
- **Windows:** Check `%PATH%` for the `bin\` directory inside this extracted package
- **Linux/Mac:** Check `$PATH` for the same

### Test the MCP server manually

The MCP server requires `WFT_API_URL` (no default — set it to your backend, e.g. `http://localhost:3000` or `http://your-server.local:3000`). To test:

**Windows (PowerShell):**
```powershell
$env:WFT_API_KEY = (Get-Content "$env:LOCALAPPDATA\wood-fired-tasks\api-key").Trim()
node ".\mcp-server\dist\mcp\remote\index.js"
```

**Linux/Mac:**
```bash
WFT_API_KEY="$(cat ~/.config/wood-fired-tasks/api-key)" \
  node ./mcp-server/dist/mcp/remote/index.js
```

Avoid pasting the literal key on the command line — it ends up in your shell
history. If you must, prefix the command with a space (most shells with
`HISTCONTROL=ignorespace` will skip it) and rotate the key afterwards.

Expected output (to stderr):
```
Wood Fired Tasks MCP Server (remote) running on stdio
Connected to backend: http://localhost:3000
```

Press Ctrl+C to exit.

### MCP server not found in Claude Code

1. Restart Claude Code after running setup
2. Run `claude mcp list` and confirm `wood-fired-tasks` appears with status `✓ Connected`
3. If missing, re-register manually. Read the key from the cached secret file
   so it never appears on the command line:

   Replace the example URL below with your backend's address (e.g.
   `http://localhost:3000` for a local backend, or `http://your-server.local:3000`
   for a LAN host):

   **Linux/Mac:**
   ```bash
   claude mcp add wood-fired-tasks --scope user \
     -e WFT_API_URL=http://localhost:3000 \
     -e WFT_API_KEY="$(cat ~/.config/wood-fired-tasks/api-key)" \
     -- node /absolute/path/to/mcp-server/dist/mcp/remote/index.js
   ```

   **Windows (PowerShell):**
   ```powershell
   $key = (Get-Content "$env:LOCALAPPDATA\wood-fired-tasks\api-key").Trim()
   claude mcp add wood-fired-tasks --scope user `
     -e WFT_API_URL=http://localhost:3000 `
     -e WFT_API_KEY=$key `
     -- node C:\path\to\mcp-server\dist\mcp\remote\index.js
   ```

   The entry lives in `~/.claude.json` (not `~/.claude/settings.json`).
   After running `claude mcp add`, tighten the config permissions:
   `chmod 600 ~/.claude.json` (Linux/Mac) or
   `icacls "$env:USERPROFILE\.claude.json" /inheritance:r /grant:r "$env:USERNAME:(R,W)"` (Windows).

### Skills not appearing

Verify the skill files are installed:

**Windows:** Check `%USERPROFILE%\.claude\commands\tasks\`
**Linux/Mac:** Check `~/.claude/commands/tasks/`

You should see 10 `.md` files. If missing, re-run the setup script.

---

## Architecture

```
Your Machine                               Linux Backend
┌──────────────────────────────────┐       ┌──────────────────────┐
│                                  │       │  Wood Fired Tasks      │
│  tasks CLI ─────────────────────────────>│  REST API             │
│  (tasks list, tasks show, etc.)  │ HTTP  │  :3000                │
│                                  │       │                        │
│  Claude Code                     │       │  SQLite database       │
│  ┌───────────────────────────┐   │       └──────────────────────┘
│  │  Remote MCP Server        │───┼──────>│
│  │  (mcp-server/)            │   │ HTTP
│  │  Proxies all 26 tools     │   │
│  └───────────────────────────┘   │
│                                  │
│  /tasks: slash commands          │
│  (~/.claude/commands/tasks/)     │
└──────────────────────────────────┘
```

Both the CLI and MCP server connect to the same backend REST API over HTTP.

## API Key Storage

Your API key never leaves your machine and is stored in two places, both
restricted to your user account:

| Path | Access | Purpose |
|------|--------|---------|
| `~/.config/wood-fired-tasks/api-key` (Linux/Mac) | mode 600, owner-only | Source of truth read by the `tasks` CLI wrapper and re-runs of `setup.sh` |
| `%LOCALAPPDATA%\wood-fired-tasks\api-key` (Windows) | user-only ACL via `icacls` | Same as above; the generated `tasks.cmd` reads from here at runtime |
| `~/.claude.json` (Linux/Mac mode 600, Windows user-only ACL) | restricted by setup | MCP server env block consumed by Claude Code |

The Windows `tasks.cmd` wrapper does **not** embed the key as a literal
`set API_KEY=...` line. It reads `WFT_API_KEY` from the per-user secret file
at each invocation. This means an attacker who can read your `%PATH%` cannot
exfiltrate the key — they would need access to your `%LOCALAPPDATA%` directory,
which is already protected by the user-only ACL.

If you ever rotate the key, re-run `setup.ps1` / `setup.sh`; the existing
wrapper picks up the new value automatically.
