# MCP Server and Claude Code Integration

Agents: start at [`AGENTS.md`](../AGENTS.md); the full read-order contract is in [`docs/AGENT_CONTEXT.md`](AGENT_CONTEXT.md).

Complete reference for the Wood Fired Tasks MCP server and Claude Code skill files.

## Overview

Wood Fired Tasks exposes task management capabilities via the Model Context Protocol (MCP), enabling direct integration with Claude Code and other MCP-compatible clients.

The MCP server provides:

- 27 tools for task, project, comment, dependency, reporting, health, topology, WSJF, and wait operations
- 1 resource for SSE event stream discovery
- stdio transport for seamless Claude Code integration
- 11 pre-built skill files for common workflows
- Two server modes: **local** (in-process SQLite) and **remote** (HTTP proxy to a deployed REST API)

## MCP Server

### Transport

The MCP server uses stdio transport for communication with MCP clients.

### Entry Points

**Production (after build):**

```bash
node dist/mcp/index.js
```

**Development:**

```bash
npx tsx src/mcp/index.ts
```

or

```bash
npm run mcp:dev
```

### Server Name

`wood-fired-tasks`

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `DATABASE_PATH` | Path to SQLite database file (canonical name; matches `src/config/env.ts`). | `./data/tasks.db` |
| `DB_PATH` | Deprecated alias for `DATABASE_PATH`. Read only when `DATABASE_PATH` is unset. Kept for backward compatibility with older `~/.claude.json` installs. | — |
| `WFT_STRICT_EVIDENCE` | When `true`, `update_task` rejects a `verification_evidence` payload showing the structural tells of fabrication (self-graded/empty/placeholder verifier identity, placeholder check text). Default off. See [RELIABILITY.md](RELIABILITY.md). | `false` (off) |

[NOTE] The MCP server creates its own database connection. It does NOT call the REST API.

## Configuration

> **Recommended setup (single-writer).** For anything beyond a single-user,
> same-host dev box, wire your MCP client to the **remote (REST) variant**
> (`dist/mcp/remote/index.js`) rather than the local SQLite variant. Only one
> process should ever own the database file — the API service. The remote
> variant proxies every tool call through that service over HTTP, so the service
> stays the single writer. The local variant (`dist/mcp/index.js` +
> `DATABASE_PATH`) opens the SQLite file **directly**: point two long-lived
> processes at the same file and you get write contention, and point it at the
> wrong file and it **silently serves stale data with no warning** — a common
> "my tasks disappeared!" cause (see
> [TROUBLESHOOTING.md](TROUBLESHOOTING.md)). Use the local variant only when your
> client and the database are on the same host and nothing else writes that
> file. See [Remote MCP Server](#remote-mcp-server) for the recommended config.

### Claude Code Setup

Add this configuration to `~/.claude.json` in the `mcpServers` section:

```json
{
  "mcpServers": {
    "wood-fired-tasks": {
      "command": "node",
      "args": ["/absolute/path/to/wood-fired-tasks/dist/mcp/index.js"],
      "env": {
        "DATABASE_PATH": "/absolute/path/to/wood-fired-tasks/data/tasks.db"
      }
    }
  }
}
```

[IMPORTANT] Use absolute paths for both the MCP server script and the database file.

### Automatic Installation

The provided installers handle configuration automatically. Both default to
`--mode local`, which writes a `wood-fired-tasks` entry that holds only
`DATABASE_PATH` — no API key is collected, persisted, or written, because the
local MCP server does not use one (task #258).

**Linux/macOS:**

```bash
./install.sh                 # local (default) — no API key
./install.sh --mode remote   # remote — prompts/reads WFT_API_KEY
```

**Windows:**

```powershell
.\install.ps1                # local (default)
.\install.ps1 -Mode remote   # remote
```

Both installers:
1. Copy skill files to `~/.claude/commands/tasks/`
2. Add or update the MCP server configuration in `~/.claude.json`:
   - local mode adds/updates `wood-fired-tasks` (points at `dist/mcp/index.js`)
   - remote mode adds/updates `wood-fired-tasks-remote` (points at `dist/mcp/remote/index.js`)
3. Set the `DATABASE_PATH` environment variable for the local server, or
   `WFT_API_URL` + `WFT_API_KEY` for the remote server. Older local installs
   may have `DB_PATH`; both are accepted, with `DATABASE_PATH` taking precedence.

See [docs/SETUP.md → Migration: removing an unused API key from older local
installs](SETUP.md#migration-removing-an-unused-api-key-from-older-local-installs-task-258)
if your existing `wood-fired-tasks` entry contains a leftover
`WOOD_FIRED_TASKS_API_KEY` — it can be removed.

## Authentication

The MCP server has two transports, and they authenticate differently:

| Transport | Auth surface | Credential source |
|-----------|--------------|-------------------|
| **Local stdio** (`dist/mcp/index.js`) | None at the wire (filesystem-trusted). On boot, the server resolves `WFT_API_KEY` to a local `users` row and threads `actorUserId` into every write tool. | `WFT_API_KEY` env var (optional) |
| **Remote HTTP** (`dist/mcp/remote/index.js`) | `WFT_API_KEY` forwarded to the REST API on every tool call. | `WFT_API_KEY` env var (required) |

### Local MCP — boot-time identity resolution

`WFT_API_KEY` accepts two value shapes; the local MCP server resolves
them at boot:

1. **PAT** — values starting with `wft_pat_` are hashed (SHA-256) and
   looked up in `api_tokens`. The matched row's
   `user_id` becomes the actor for every subsequent write tool call.
   Revoked / unknown PATs fall back to `mcp-bot` (see below).
2. **Legacy key** — anything else is matched against the `API_KEYS`
   env list on the server side. A matching entry resolves to the
   corresponding `users` row (the same one the legacy REST strategy
   would resolve).
3. **Unset / unresolved** — if `WFT_API_KEY` is missing, empty, or
   matches no PAT/legacy entry, the actor falls back to the seeded
   `mcp-bot` service-account row. Writes are attributed to that bot.

The fallback is opportunistic — the MCP server stays usable even
without a credential — but the resulting writes lack per-operator
attribution, so deployments that audit by user should always supply a
real PAT.

[NOTE] The `mcp-bot` row is seeded unconditionally on first boot.
`tasks db mint-token --user mcp-bot` mints a PAT bound
to that row if you'd rather have an explicit credential than rely on
the fallback.

### Remote MCP — header switching on prefix

The remote bridge's REST client looks at the `WFT_API_KEY` value at
startup and chooses the wire header by prefix:

| `WFT_API_KEY` prefix | Outbound header |
|----------------------|-----------------|
| `wft_pat_…` | `Authorization: Bearer wft_pat_…` |
| anything else | `X-API-Key: <value>` |

The REST API's auth chain (PAT → session → legacy) decodes each
appropriately. The remote bridge itself does not parse or validate the
PAT — it forwards the credential and lets the server side enforce.

### Recommended flow

```bash
# 1. Mint a PAT once via the web UI (/me) or the CLI for headless boxes:
tasks login                           # browser flow on a workstation
# or:
node dist/cli/bin/tasks.js db mint-token --user you@example.com

# 2. Paste the PAT value into your MCP client config:
#    "env": { "WFT_API_KEY": "wft_pat_…" }

# 3. Restart Claude Code. The MCP server (local or remote) picks up the
#    PAT on next boot.
```

See [`../SECURITY.md`](../SECURITY.md) → **Authentication Architecture**
for the full credential lifecycle (mint, hash storage, revocation).

## Remote MCP Server

Wood Fired Tasks ships a **second** MCP server entry point (`npm run mcp:remote`, source under `src/mcp/remote/`) for the case where the bugs REST API runs on a different machine than the developer's MCP client. Instead of opening the SQLite file in-process, the remote server proxies every tool call to the deployed REST API over HTTP.

### When to use the remote server

| Scenario | Use |
|----------|-----|
| Bugs API and your Claude Code client run on the same host (laptop, dev box). | **Local** (`mcp:start` / `mcp:dev`) — direct SQLite access, no network hop. |
| Bugs API runs on a shared server, container, VM, or homelab box; multiple machines / agents share a single database. | **Remote** (`mcp:remote`) — every machine points its MCP client at the deployed API. |
| You don't want SQLite write contention from multiple long-lived MCP processes against a network-mounted database file. | **Remote** — the API owns the only writer. |

### Configuration

The remote server is configured entirely via environment variables and fails fast at startup with a readable message if either is missing:

| Variable | Required | Description |
|----------|----------|-------------|
| `WFT_API_URL` | yes | Base URL of the deployed bugs API, e.g. `http://your-server.local:3000` or `https://bugs.example.com`. The remote server appends `/api/v1` itself — supply the host root. No default; setting nothing fails startup so a misconfigured client never silently hits `localhost`. |
| `WFT_API_KEY` | yes | API key the remote server uses for every outbound REST call. Must match a key on the API's `API_KEYS` list. |

### Claude Code config snippet

Add this alongside (or instead of) the local `wood-fired-tasks` entry in `~/.claude.json`:

```json
{
  "mcpServers": {
    "wood-fired-tasks-remote": {
      "command": "node",
      "args": ["/absolute/path/to/wood-fired-tasks/dist/mcp/remote/index.js"],
      "env": {
        "WFT_API_URL": "https://bugs.example.com",
        "WFT_API_KEY": "your-api-key-here"
      }
    }
  }
}
```

> Prefer the [launcher-wrapper below](#keeping-the-api-key-out-of-client-config-recommended) over an inline `WFT_API_KEY` — it keeps the secret out of `~/.claude.json`.

For development you can also run it via `tsx`:

```bash
WFT_API_URL=http://localhost:3000 WFT_API_KEY=dev-key npm run mcp:remote
```

### Keeping the API key out of client config (recommended)

Pasting `WFT_API_KEY` straight into `~/.claude.json` works, but it leaves a
long-lived secret in a file your agent reads and writes constantly. Prefer a
thin launcher script as the MCP `command` that injects the key at spawn time
from the server's own environment file, so the client config holds **no
secret**:

```bash
#!/usr/bin/env bash
# ~/.local/bin/wft-mcp — reads the key from the server's .env at spawn time.
set -euo pipefail
WFT_API_KEY="$(grep -m1 '^API_KEYS=' /opt/wood-fired-tasks/.env | cut -d= -f2- | cut -d, -f1)"
export WFT_API_KEY
export WFT_API_URL="${WFT_API_URL:-http://localhost:3000}"
exec node /opt/wood-fired-tasks/dist/mcp/remote/index.js
```

The client entry then carries only the command — no `env` block, no key:

```json
{
  "mcpServers": {
    "wood-fired-tasks": { "command": "/home/you/.local/bin/wft-mcp", "args": [] }
  }
}
```

Mint a dedicated PAT (`tasks login` / `db mint-token`) instead of reusing a
master `API_KEYS` value when you want per-operator attribution and easy
revocation.

### Local vs remote at a glance

| Aspect | Local MCP server (`mcp:start`) | Remote MCP server (`mcp:remote`) |
|--------|-------------------------------|----------------------------------|
| Source | `src/mcp/index.ts` → `src/mcp/server.ts` | `src/mcp/remote/index.ts` → `src/mcp/remote/register-tools.ts` |
| Data access | In-process via `better-sqlite3` against `DB_PATH` | HTTPS/HTTP calls to the deployed REST API |
| Required env | `DB_PATH` (optional, defaults to `./data/tasks.db`) | `WFT_API_URL` + `WFT_API_KEY` (both required, no defaults) |
| Auth surface | None (filesystem-trusted) | API key on every call |
| Tool count | 27 (full set including `completion_report`, `topology_check`, `wait_for_unblock`, and the four WSJF tools) | 27 (full parity: `completion_report` proxies `GET /api/v1/tasks/completion-report`, `topology_check` proxies `GET /api/v1/projects/:id/topology`, `wait_for_unblock` resolves over the SSE stream `GET /api/v1/events`, and `wsjf_ranking` / `wsjf_history` / `wsjf_health` / `rescore_project` proxy the project- and task-scoped WSJF REST endpoints) |
| `events://stream` resource | Served, points at `API_URL` (default `http://localhost:3000/api/v1`) | Served, points at `WFT_API_URL/api/v1` |

The remote server carries every tool the local server does. `completion_report` calls reach the deployed REST API (`GET /api/v1/tasks/completion-report`) which runs `TaskService.getCompletionReport` server-side and returns the same envelope the local in-process tool produces. `topology_check` is registered on the remote server too (`src/mcp/remote/register-tools.ts`), proxying `GET /api/v1/projects/:id/topology` (`TopologyService.classify`) instead of constructing the service in-process. The four WSJF tools (`wsjf_ranking`, `wsjf_history`, `wsjf_health`, `rescore_project`) reach remote parity the same way (WSJF 1.10): the remote proxy calls `GET /api/v1/projects/:id/wsjf-ranking`, `GET /api/v1/tasks/:id/score-history`, `GET /api/v1/projects/:id/wsjf-health`, and `POST /api/v1/projects/:id/rescore`, each of which exposes the same service the stdio server wires in-process (`rankFrontier`, `WsjfHistoryRepository`, `WsjfHealthService`, `WsjfRescoreService`). `wait_for_unblock` is hosted on **both** servers but over **different transports**: the local variant resolves the `blocked -> open` transition off the **in-process EventBus**, while the remote variant (task #481) resolves it off the **SSE event stream** (`GET /api/v1/events`, `RestClient.waitForUnblockViaSse`) — so the remote tool additionally observes cross-process / cross-session transitions. The input schema and the three return envelopes (`already_unblocked` / `unblocked` / `timeout`) are byte-identical across both transports.

## Tools Reference

The MCP server exposes 27 tools organized by domain:

| Tool | Domain | One-line description |
|------|--------|----------------------|
| `create_task` | Task | Create a new task in a project. |
| `get_task` | Task | Get a single task by ID. |
| `update_task` | Task | Update title, status, priority, assignee, due date, or tags. |
| `list_tasks` | Task | List tasks with filters and pagination; returns compact rows by default. |
| `delete_task` | Task | Permanently delete a task. |
| `claim_task` | Task | Atomically assign an unclaimed task to an agent and set status to `in_progress`. |
| `list_subtasks` | Task | Paginated list of a task's child subtasks (summary text + structured payload). |
| `get_subtasks` | Task | Paginated subtasks of a task (alternative shape returning the same data). |
| `completion_report` | Task | Dashboard report of completed tasks over a time window with per-project / assignee / priority / daily aggregates. |
| `create_project` | Project | Create a new project container. |
| `get_project` | Project | Get a project by ID. |
| `list_projects` | Project | List all projects. |
| `update_project` | Project | Update project name or description. |
| `delete_project` | Project | Permanently delete a project. |
| `add_comment` | Comment | Add a comment to a task. |
| `get_comments` | Comment | Chronological comment thread for a task. |
| `delete_comment` | Comment | Delete a comment by ID. |
| `add_dependency` | Dependency | Mark that one task blocks another. |
| `remove_dependency` | Dependency | Remove a blocking relationship between two tasks. |
| `get_dependencies` | Dependency | Return both blockers and blocked-by relationships for a task. |
| `check_health` | Health | Verify database connectivity and report version info. |
| `topology_check` | Topology | Classify a project as FLAT, DAG, or DAG_CYCLIC over its task-dependency graph; returns roots, leaves, edges, and an execution advisory. |
| `wait_for_unblock` | Task | Long-poll (block) until a task transitions `blocked` -> `open`, then return the fresh projection. On both servers: local resolves over the in-process bus, remote over the SSE stream. |

### Task Tools (9 tools)

#### create_task

Create a new task in a project.

**Input Schema:**

```json
{
  "title": "string (required, max 255 chars)",
  "description": "string (optional, max 5000 chars)",
  "priority": "low|medium|high|urgent (optional, default: medium)",
  "project_id": "number (required, positive integer)",
  "parent_task_id": "number (optional, positive integer)",
  "estimated_minutes": "number (optional, 0-10080)",
  "assignee": "string (optional, max 100 chars)",
  "created_by": "string (required, max 100 chars)",
  "due_date": "string (optional, ISO8601 format)",
  "tags": ["array of strings (optional, max 20 tags)"]
}
```

**Usage:** When Claude Code needs to create a new task, bug report, or work item.

#### get_task

Get a task by its ID.

**Input Schema:**

```json
{
  "id": "number (required, positive integer)"
}
```

**Usage:** When Claude Code needs to fetch task details, inspect a task, or show task information.

#### update_task

Update an existing task by ID.

**Input Schema:**

```json
{
  "id": "number (required, positive integer)",
  "updates": {
    "title": "string (optional, max 255 chars)",
    "description": "string (optional, max 5000 chars)",
    "status": "open|in_progress|done|closed|blocked (optional)",
    "priority": "low|medium|high|urgent (optional)",
    "parent_task_id": "number (optional, positive integer)",
    "estimated_minutes": "number (optional, 0-10080)",
    "assignee": "string (optional, max 100 chars)",
    "due_date": "string (optional, ISO8601 format)",
    "tags": ["array of strings (optional)"]
  }
}
```

**Usage:** When Claude Code needs to modify task fields, change status, update assignee, or adjust priority.

#### list_tasks

List tasks with optional filters and pagination. Returns a compact task projection by default; pass `verbose=true` for full description + audit fields.

**Input Schema:**

```json
{
  "project_id": "number (optional, positive integer)",
  "status": "string (optional, task status)",
  "assignee": "string (optional, assignee name)",
  "tags": ["array of strings (optional)"],
  "due_before": "string (optional, ISO8601)",
  "due_after": "string (optional, ISO8601)",
  "updated_before": "string (optional, ISO8601)",
  "updated_after": "string (optional, ISO8601)",
  "search": "string (optional, max 200 chars)",
  "limit": "number (optional, 1-500, default 50)",
  "offset": "number (optional, >=0, default 0)",
  "verbose": "boolean (optional, default false)"
}
```

**Returns:** `{ tasks, total, limit, offset }`.

**Usage:** When Claude Code needs to find tasks, filter by criteria, or search for specific work items.

#### delete_task

Delete a task by its ID.

**Input Schema:**

```json
{
  "id": "number (required, positive integer)"
}
```

**Usage:** When Claude Code needs to remove a task permanently.

#### claim_task

Atomically claim an unassigned task, setting assignee and transitioning status to `in_progress`.

**Input Schema:**

```json
{
  "task_id": "number (required, positive integer)",
  "assignee": "string (required, 1-100 chars)"
}
```

**Usage:** When Claude Code needs to claim a task for an agent. Returns the updated task on success. Returns a 409-equivalent error if the task is already claimed or not in a claimable state. Multiple agents can race to claim; exactly one wins.

#### list_subtasks

List subtasks (children) of a parent task. Paginated.

**Input Schema:**

```json
{
  "task_id": "number (required, positive integer)",
  "limit": "number (optional, 1-500, default 50)",
  "offset": "number (optional, >=0, default 0)"
}
```

**Returns:** `{ parent_task_id, subtasks, total, limit, offset }` plus a human-readable summary in text content.

**Usage:** When Claude Code needs to see the breakdown of a parent task into subtasks.

#### get_subtasks

Get all subtasks (children) of a parent task. Paginated.

**Input Schema:**

```json
{
  "task_id": "number (required, positive integer)",
  "limit": "number (optional, 1-500, default 50)",
  "offset": "number (optional, >=0, default 0)"
}
```

**Returns:** `{ parent_task_id, subtasks, total, limit, offset }`.

**Usage:** Alternative to list_subtasks for retrieving child tasks when callers prefer a uniform paginated shape.

#### completion_report

Dashboard view of tasks completed (`status=done`) within a time interval. Caller supplies **either** a trailing window (`days`) **or** explicit `start`/`end` ISO8601 bounds; optional filters narrow by project or assignee.

**Input Schema:**

```json
{
  "days": "number (optional, 1-365 — trailing days from now)",
  "start": "string (optional, ISO8601 — required with end)",
  "end": "string (optional, ISO8601 — required with start; must be >= start)",
  "project_id": "number (optional, positive integer)",
  "assignee": "string (optional, 1-100 chars)"
}
```

Provide either `days` OR both `start` and `end`. The two forms are mutually exclusive; supplying neither is a validation error.

**Returns (structuredContent):**

```json
{
  "range": { "start": "ISO8601", "end": "ISO8601" },
  "total": "number — count of done tasks in the window",
  "rows": [
    {
      "id": "number",
      "title": "string",
      "project_id": "number",
      "assignee": "string | null",
      "priority": "low|medium|high|urgent",
      "created_at": "ISO8601",
      "completed_at": "ISO8601",
      "time_to_complete_seconds": "number"
    }
  ],
  "by_project":   [{ "project_id": "number", "count": "number" }],
  "by_assignee":  [{ "assignee": "string", "count": "number" }],
  "by_priority":  [{ "priority": "low|medium|high|urgent", "count": "number" }],
  "daily_throughput": [{ "date": "YYYY-MM-DD", "count": "number" }]
}
```

The text content returns a short summary including total count, range, and top-5 projects/assignees.

**Usage:** When Claude Code or a dashboard skill needs completion throughput over a period — e.g., weekly velocity, per-assignee throughput, time-to-complete distributions, daily burn-down.

### Project Tools (5 tools)

#### create_project

Create a new project.

**Input Schema:**

```json
{
  "name": "string (required, max 100 chars)",
  "description": "string (optional, max 1000 chars)"
}
```

**Usage:** When Claude Code needs to create a new project container for tasks.

#### get_project

Get a project by its ID.

**Input Schema:**

```json
{
  "id": "number (required, positive integer)"
}
```

**Usage:** When Claude Code needs to fetch project details.

#### list_projects

List all projects.

**Input Schema:**

```json
{}
```

**Usage:** When Claude Code needs to see all available projects or help users select a project.

#### update_project

Update an existing project by ID.

**Input Schema:**

```json
{
  "id": "number (required, positive integer)",
  "updates": {
    "name": "string (optional, max 100 chars)",
    "description": "string (optional, max 1000 chars)"
  }
}
```

**Usage:** When Claude Code needs to modify project name or description.

#### delete_project

Delete a project by its ID.

**Input Schema:**

```json
{
  "id": "number (required, positive integer)"
}
```

**Usage:** When Claude Code needs to remove a project permanently.

### Comment Tools (3 tools)

#### add_comment

Add a comment to a task.

**Input Schema:**

```json
{
  "task_id": "number (required, positive integer)",
  "author": "string (required, max 100 chars)",
  "content": "string (required, max 5000 chars)"
}
```

**Usage:** When Claude Code needs to add notes, feedback, or context to a task.

#### get_comments

Get all comments for a task in chronological order.

**Input Schema:**

```json
{
  "task_id": "number (required, positive integer)"
}
```

**Usage:** When Claude Code needs to review discussion history or see task annotations.

#### delete_comment

Delete a comment by ID.

**Input Schema:**

```json
{
  "comment_id": "number (required, positive integer)"
}
```

**Usage:** When Claude Code needs to remove a comment.

### Dependency Tools (3 tools)

#### add_dependency

Add a dependency relationship between tasks.

**Input Schema:**

```json
{
  "task_id": "number (required, positive integer)",
  "blocks_task_id": "number (required, positive integer)"
}
```

**Usage:** When Claude Code needs to mark that task_id blocks blocks_task_id (creates a blocking relationship).

#### remove_dependency

Remove a dependency relationship between tasks.

**Input Schema:**

```json
{
  "task_id": "number (required, positive integer)",
  "blocks_task_id": "number (required, positive integer)"
}
```

**Usage:** When Claude Code needs to remove a blocking relationship.

#### get_dependencies

Get all dependencies for a task.

**Input Schema:**

```json
{
  "task_id": "number (required, positive integer)"
}
```

**Returns:** Both tasks that this task blocks AND tasks that block this task.

**Usage:** When Claude Code needs to understand task dependencies and blockers.

### Health Tools (1 tool)

#### check_health

Check service health status, database connectivity, and version information.

**Input Schema:**

```json
{}
```

**Usage:** When Claude Code needs to verify the MCP server and database are functioning correctly.

### Topology Tools (1 tool)

#### topology_check

Classify a project as `FLAT` (parallelizable, `/tasks:loop`), `DAG` (wave-by-wave parallel dispatch, `/tasks:loop-dag`), or `DAG_CYCLIC` (BLOCKED) based on its `task_dependencies` graph.

**Input Schema:**

```json
{
  "project_id": "number (required, positive integer)"
}
```

**Returns:** A `TopologyReport` (in both human-readable `content[0].text` and structured `structuredContent` form) containing `topology`, `advisory`, `edges`, `roots`, and `leaves`.

**Usage:** When Claude Code needs to decide whether a project's backlog can be drained in parallel (`/tasks:loop-dag`) or must run sequentially, or to detect a dependency cycle that blocks execution. Registered on both the local and remote servers; the remote variant proxies `GET /api/v1/projects/:id/topology`.

### Wait Tools (1 tool)

#### wait_for_unblock

Long-poll (block) until a task transitions `blocked` -> `open`, then return the fresh task projection. Wraps the in-process `subscribeOnce` helper over the EventBus singleton.

**Input Schema:**

```json
{
  "task_id": "number (required, positive integer)",
  "timeout_seconds": "number (optional, positive integer; default 300, clamped to max 1800)"
}
```

**Returns:** Exactly one of three structured shapes:

- `{ "status": "unblocked", "task": <fresh projection>, "applied_timeout_seconds": <number> }` — the `blocked -> open` transition fired during the wait.
- `{ "status": "already_unblocked", "task": <fresh projection>, "applied_timeout_seconds": <number> }` — the task was not `blocked` at call time (returns immediately).
- `{ "status": "timeout", "task_id": <number>, "waited_seconds": <number>, "applied_timeout_seconds": <number> }` — the deadline elapsed. **No error is thrown for timeout.**

`applied_timeout_seconds` echoes the clamped timeout so callers can see when a requested value exceeded the 1800s ceiling. Authorization is identical to `get_task`: an unknown / inaccessible `task_id` yields the same MCP error.

**Two transports (local in-process bus vs remote SSE stream):** `wait_for_unblock` is hosted on **both** the local and remote MCP servers, but resolves the `blocked -> open` transition over different transports:

- **Local (stdio, `src/mcp/tools/wait-for-unblock-tools.ts`):** subscribes to the **in-process EventBus**, so it only observes status transitions that happen in the **same process** as the MCP server (e.g. the workflow-engine auto-unblock cascade running in-process). It does **not** see transitions made by other sessions or processes.
- **Remote (`src/mcp/remote/register-tools.ts` → `RestClient.waitForUnblockViaSse`, task #481):** opens a streaming authenticated `GET /api/v1/events?event_types=task.status_changed` and resolves on the first frame whose payload satisfies `data.id === task_id && metadata.from === "blocked" && metadata.to === "open"`. Because the SSE stream carries events from the whole server, the remote variant **also** observes cross-process / cross-session wake-ups (the domain previously reserved for the `events://stream` resource and the wft-router automation recipe, task #456).

The input schema, the three envelopes, the clamp logic, and the no-throw timeout semantics are byte-identical across both transports, so a caller cannot tell which one served the request.

**Usage:** When an agent has hit a `blocked` task and wants to park until its blockers clear (within the same MCP process) rather than busy-polling `get_task`.

##### Long-polling for task transitions

`wait_for_unblock` and the wft-router [persistent-agent-sessions recipe](automation-recipes/persistent-agent-sessions.md) solve the same problem — "wake an agent when a task unblocks" — from opposite ends of a single trade-off. `wait_for_unblock` is a **single-turn blocking call inside ONE MCP request**: the calling agent holds the connection open until the `blocked -> open` transition fires (or the deadline elapses). Reach for it when the agent can afford to stay connected — sub-30-minute waits with no host failover, no session teardown. The wft-router persistent-agent-sessions recipe is the opposite pole: **fire-and-forget, cross-session wake-ups**. The agent closes its session and goes away; later, when the task transitions, wft-router dispatches an adapter that re-spawns (or re-prompts) the agent. Choose it when the wait may outlive the agent process, span hosts, or survive a restart.

**`wait_for_unblock` (single-turn, in-process):**

```json
{ "task_id": 1234, "timeout_seconds": 600 }
```

The call blocks for up to 600s and returns `{ "status": "unblocked", "task": <fresh projection> }` the instant the blocker clears.

**wft-router `agent_session_dispatch` (cross-session, fire-and-forget):**

```yaml
rules:
  - name: unblocked-task-wakes-session
    on: task.status_changed
    where: { to_status: open }
    do: agent_session_dispatch
    with: { adapter: local-command, target: your-session, prompt: "{{task.id}}" }
```

## Resources Reference

The MCP server exposes 1 resource.

### events://stream

**Name:** Event Stream

**MIME type:** `text/event-stream` (resource returns Markdown describing the live SSE endpoint).

**Description:** Real-time task and project event stream via Server-Sent Events.

This resource does **not** stream events directly — MCP resources are request/response, not long-lived connections. Instead it returns Markdown documentation telling agents how to open an SSE connection to the REST API:

- The SSE endpoint URL (`GET <apiUrl>/events`)
- Required authentication (`X-API-Key` header — the resource never embeds the key, only the placeholder, so prompt-cache surfaces stay clean)
- Available query parameters for filtering (`project_id`, `event_types`)
- The canonical event type list (see below)
- Reconnection protocol (`Last-Event-ID` header)
- Example `curl -N` invocation
- SSE event frame format (`id:`, `event:`, `data:` lines)

**Canonical event types**

The resource description and the server's emitted events MUST stay in sync. The authoritative list lives in `src/events/types.ts` (`ALLOWED_EVENT_TYPES`); the resource Markdown is generated from the same set:

| Event | Trigger |
|-------|---------|
| `task.created` | New task created |
| `task.updated` | Task field(s) updated |
| `task.deleted` | Task deleted |
| `task.status_changed` | Task status transitioned |
| `task.claimed` | Task atomically claimed by an agent via `claim_task` |
| `project.created` | New project created |
| `project.updated` | Project updated |
| `project.deleted` | Project deleted |
| `ping` | SSE heartbeat (every 30 seconds — not in `ALLOWED_EVENT_TYPES`, transport-level only) |

If you add or rename a domain event, update `ALLOWED_EVENT_TYPES` in `src/events/types.ts`, the table in `src/mcp/resources/events.ts`, and this table together. The `events-resource` MCP test (`src/mcp/__tests__/events-resource.test.ts`) is the canonical regression guard.

**Usage:** When Claude Code needs to discover how to subscribe to real-time task notifications. After reading this resource, agents open the SSE connection over HTTP (or via `curl -N`) using their `WFT_API_KEY` / local `API_KEYS` value.

## Skill Files

Wood Fired Tasks provides 11 pre-built skill files in the `/tasks:` namespace.

After installation, these skills are available as slash commands in Claude Code.

### /tasks:create-task

**Description:** Creates a new task with configurable project, priority, and assignee.

**Use when:** User wants to add a task, create work items, or plan new work.

**Workflow:** Prompts for title, project, priority, assignee, and other task details, then creates the task using the create_task MCP tool.

### /tasks:show-task

**Description:** Shows full details of a task including comments and dependencies.

**Use when:** User wants to see task details, inspect a task, or review a specific task.

**Workflow:** Fetches task data, comments, and dependencies in parallel, then displays comprehensive task information.

### /tasks:my-work

**Description:** Lists tasks assigned to the current user grouped by status.

**Use when:** User asks about their tasks, assigned work, workload, or what to do next.

**Workflow:** Filters tasks by current user assignee, groups by status (open, in_progress, blocked, done), and displays organized summary.

### /tasks:project-status

**Description:** Shows project overview with task counts grouped by status and completion percentage.

**Use when:** User asks about project status, progress, overview, dashboard, or summary.

**Workflow:** Lists all projects, retrieves tasks for each, calculates counts by status, computes completion percentage, and displays project dashboard.

### /tasks:search

**Description:** Searches tasks by keyword across titles and descriptions.

**Use when:** User wants to find tasks, look up work items, or search for specific topics.

**Workflow:** Accepts search keyword from arguments, calls list_tasks with search filter, displays matching results.

### /tasks:log-bug

**Description:** Creates a bug report task with high priority.

**Use when:** User reports a bug, mentions an issue, or asks to log a problem.

**Workflow:** Prompts for title and description, sets priority to high, creates task with bug tag.

### /tasks:done

**Description:** Marks a task as complete by setting status to done.

**Use when:** User finishes a task, says mark done, complete, or finished.

**Workflow:** Validates status transition, updates task status to done using update_task MCP tool.

### /tasks:blocked

**Description:** Marks a task as blocked and records the blocking reason as a comment.

**Use when:** User reports a blocker, dependency issue, or impediment on a task.

**Workflow:** Updates task status to blocked, adds comment with blocking reason for context.

### /tasks:pick-up

**Description:** Assigns a task to the current user and sets status to in_progress.

**Use when:** User wants to start working on a task, pick up a task, or claim a task.

**Workflow:** Assigns task to current user, transitions status to in_progress, confirms assignment.

### /tasks:add-comment

**Description:** Adds a comment to a task.

**Use when:** User wants to add a note, leave feedback, or annotate a task with additional context.

**Workflow:** Prompts for comment content, adds comment to specified task using add_comment MCP tool.

### /tasks:loop

**Description:** Autonomous backlog-drain loop that works through a project's open tasks one at a time. A single orchestrating context plans and verifies; subagents implement each task.

**Use when:** User wants to clear an open-task backlog hands-off — typically said as "loop the backlog", "drain project X", "work through the backlog", or "fix every open task in <project>".

**Workflow:** Resolves the target project from the argument (asks if omitted), discovers the repo's build/test/smoke commands once, then loops: pick the highest-priority open task (`urgent > high > medium > low`, ties broken by oldest ID first), `claim_task`, dispatch a subagent with a self-contained brief (acceptance criteria, domain-doc excerpts, repo conventions, validation steps, "do not commit"), independently re-run the validation suite when the subagent returns, `add_comment` summarizing approach + change + validation results, `update_task` to `done`, commit and push one task per commit, and repeat until `list_tasks status=open` is empty. Validation commands are **not hardcoded** — they're read from `CLAUDE.md`, `package.json`, `Makefile`, or asked once at startup, making the loop project-agnostic. Tasks that can't be resolved after 2–3 attempts are moved to `blocked` with a comment so the loop keeps draining the rest.

**Arguments:** `[project-name]` — case-insensitive partial match. If omitted, the skill asks rather than guessing.

**Safety:** Stops on empty backlog (no polling), commits per task with the task ID in the message, never uses `git add -A`, notes manual follow-ups (e.g. blocked SSH push, sudo-required deploys) in task comments instead of stalling the loop.

## How It Works

### Architecture

```
Claude Code
    |
    | (stdio)
    |
MCP Server (dist/mcp/index.js)
    |
    | (better-sqlite3)
    |
SQLite Database (tasks.db)
```

The MCP server:

1. Creates its own database connection to the SQLite database
2. Uses the same service layer as the REST API (TaskService, ProjectService, etc.)
3. Shares the same schema and data with the API and CLI
4. Does NOT call the REST API (direct database access)

### Data Flow

When Claude Code uses a skill file:

1. Skill file logic determines which MCP tool(s) to call
2. MCP tool receives parameters from Claude Code
3. Tool calls the appropriate service method (e.g., TaskService.createTask)
4. Service performs database operations via better-sqlite3
5. Result is returned to Claude Code as structured data

### Database Sharing

All three interfaces (API, CLI, MCP) share the same SQLite database:

- **API Server:** Long-lived connection, handles HTTP requests
- **CLI:** Per-command connection, executes and closes
- **MCP Server:** Long-lived connection, handles stdio messages

SQLite's WAL mode enables concurrent reads and sequential writes across all interfaces.

## Troubleshooting

### MCP server not appearing in Claude Code

1. Check that `~/.claude.json` has the correct configuration
2. Verify the `command` path points to the compiled MCP server (`dist/mcp/index.js`)
3. Verify the `DATABASE_PATH` (or legacy `DB_PATH`) in the config points to a valid database file
4. Restart Claude Code after configuration changes

### MCP tools return "database error"

1. Check that the database file exists at `DATABASE_PATH` (or legacy `DB_PATH`)
2. Verify file permissions allow read/write access
3. Run `npm run migrate` to ensure the schema is up to date
4. Check that the database file is not locked by another process

### Skill files not showing up

1. Verify skill files are copied to `~/.claude/commands/tasks/`
2. Check that each skill file has valid frontmatter (name, description fields)
3. Restart Claude Code to reload skill files

### Data not syncing between API and MCP

The API and MCP server share the same database file. If changes made via the API don't appear in MCP (or vice versa):

1. Verify both are using the same database path (`DATABASE_PATH` or legacy `DB_PATH`)
2. Check that SQLite is in WAL mode (handled automatically by the app)
3. If using Docker or VMs, ensure the database file is on a shared volume

[TIP] Use the `check_health` MCP tool to verify database connectivity from within Claude Code.

## Next Steps

- Try the skill files in Claude Code: `/tasks:create-task`, `/tasks:my-work`, `/tasks:project-status`, `/tasks:bug-smash`
- Explore the 27 MCP tools for custom workflows (including `completion_report` for dashboards)
- Use `claim_task` for multi-agent task coordination
- Switch to the [Remote MCP Server](#remote-mcp-server) when your bugs API runs on a different host
- Read the `events://stream` resource for real-time event integration
- Read the [API.md](API.md) reference for REST API details
- Read the [CLI.md](CLI.md) reference for command-line usage
