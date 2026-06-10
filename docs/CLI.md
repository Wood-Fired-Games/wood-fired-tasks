# CLI Reference

Agents: start at [`AGENTS.md`](../AGENTS.md); the full read-order contract is in [`docs/AGENT_CONTEXT.md`](AGENT_CONTEXT.md).

Complete command-line interface reference for Wood Fired Tasks.

**Invocation:** From a fresh clone the CLI runs **in-tree** with no global
install — the path the [README Quick Start](../README.md#quick-start) uses.
Every `tasks <command>` example below maps to `npm run cli -- <command>
[options]` (everything after `--` is forwarded verbatim). `npm run cli --`
prints a two-line npm banner; add `--silent` for clean stdout, or run the entry
point directly: `npx tsx src/cli/bin/tasks.ts <command>`. Running `npm link`
once from the project root is **optional** — it installs a global `tasks`
command so the examples work verbatim from any directory. See
[SETUP.md → CLI Installation](SETUP.md#cli-installation).

## Global Options

These options work with any command:

| Option | Description |
|--------|-------------|
| --json | Output in machine-readable JSON format (writes to stdout, errors to stderr) |
| --no-input | Disable interactive prompts (fail if required options are missing) |
| --force | Skip confirmation prompts for destructive operations |

**Examples:**

```bash
# Machine-readable JSON output
tasks list --json

# Non-interactive mode (for scripts)
tasks create --title "Task" --project 1 --created-by "bot" --no-input

# Skip delete confirmation
tasks delete 42 --force
```

## Environment Variables

The CLI requires these environment variables to connect to the API server:

| Variable | Description | Default |
|----------|-------------|---------|
| API_BASE_URL | Base URL of the API server | http://localhost:3000 |
| API_KEY | PAT the CLI sends as the `Authorization: Bearer <pat>` header (a `wft_pat_…` value) | (none - required unless logged in) |

[IMPORTANT] Authentication uses a Personal Access Token (PAT) sent as
`Authorization: Bearer <pat>`. For interactive use prefer
[`tasks login`](#tasks-login) (OIDC device flow, or `--token <pat>` for a manual
PAT on non-`https` servers; writes a PAT to the credentials file, which takes
precedence over `API_KEY`). For scripting/CI, set `API_KEY` to
a `wft_pat_…` value or pass `--token wft_pat_…`. Mint a PAT via the web UI (`/me`),
`tasks login`, or `tasks db mint-token` (headless bootstrap).

[TIP] Add these to your `.bashrc` or `.zshrc`:

```bash
export API_BASE_URL=http://localhost:3000   # default; the CLI target
export API_KEY=wft_pat_your-token-here      # a PAT
```

## Task Commands

### tasks create

Create a new task.

**Interactive mode** (prompts for required fields):

```bash
tasks create
```

**Non-interactive mode** (all options specified):

```bash
tasks create \
  --title "Implement feature" \
  --project 1 \
  --created-by "alice" \
  --description "Add new API endpoint" \
  --priority high \
  --assignee "bob" \
  --due "2026-02-20T00:00:00Z" \
  --tags "backend,api"
```

**Options:**

| Option | Short | Type | Description |
|--------|-------|------|-------------|
| --title | -t | string | Task title (required) |
| --project | -p | number | Project ID (required) |
| --created-by | -c | string | Creator name (required) |
| --description | -d | string | Task description |
| --priority | | string | Priority: low, medium, high, urgent (default: medium) |
| --assignee | -a | string | Assignee name |
| --due | | string | Due date in ISO8601 format |
| --tags | | string | Comma-separated tags |

**Output:**

```
Created task #42: Implement feature

Title: Implement feature
Status: open
Priority: high
Project: 1
Assignee: bob
Created by: alice
Due: 2026-02-20T00:00:00Z
Tags: backend, api
```

**JSON output** (`tasks create --title "Test" --project 1 --created-by "me" --json`):

```json
{
  "success": true,
  "data": {
    "task": {
      "id": 42,
      "title": "Test",
      "status": "open",
      "priority": "medium",
      "project_id": 1
    }
  },
  "metadata": {
    "id": 42
  }
}
```

The task is nested under `.data.task`; its id is also at `.metadata.id` (extract with `tasks create … --json | jq -r '.metadata.id'`).

### tasks list

List tasks with optional filters.

**Examples:**

```bash
# List all tasks
tasks list

# Filter by project
tasks list --project 1

# Filter by status
tasks list --status open

# Filter by assignee
tasks list --assignee alice

# Search by keyword
tasks list --search "authentication"

# Filter by tags
tasks list --tags bug,urgent

# Multiple filters
tasks list --project 1 --status in_progress --assignee bob
```

**Options:**

| Option | Short | Type | Description |
|--------|-------|------|-------------|
| --project | -p | number | Filter by project ID |
| --status | -s | string | Filter by status (open, in_progress, done, closed, blocked) |
| --assignee | -a | string | Filter by assignee name |
| --search | | string | Search in title and description |
| --tags | | string | Filter by tags (comma-separated) |
| --due-before | | string | Tasks due before date (ISO8601) |
| --due-after | | string | Tasks due after date (ISO8601) |

**Output:**

```
Found 3 tasks:

ID  Title                    Status       Priority  Assignee
42  Implement authentication in_progress  high      alice
43  Write tests              open         medium    bob
44  Deploy to production     blocked      urgent    alice
```

**JSON output:**

```json
{
  "success": true,
  "data": [
    {
      "id": 42,
      "title": "Implement authentication",
      "status": "in_progress",
      "priority": "high",
      "assignee": "alice"
    }
  ],
  "metadata": {
    "count": 1
  }
}
```

### tasks show <id>

Show detailed information about a task.

**Example:**

```bash
tasks show 42
```

**Output:**

```
Task #42: Implement authentication

Title: Implement authentication
Description: Add JWT authentication to API
Status: in_progress
Priority: high
Project: 1
Assignee: alice
Created by: bob
Due date: 2026-02-20T00:00:00Z
Estimated: 240 minutes (4 hours)
Created: 2026-02-14T12:00:00.000Z
Updated: 2026-02-14T13:00:00.000Z
Tags: backend, security

Comments: 2
Dependencies: Blocks 1 task, blocked by 1 task
```

**JSON output:**

```bash
tasks show 42 --json
```

```json
{
  "success": true,
  "data": {
    "id": 42,
    "title": "Implement authentication",
    "description": "Add JWT authentication to API",
    "status": "in_progress",
    "priority": "high",
    "project_id": 1,
    "assignee": "alice",
    "created_by": "bob",
    "due_date": "2026-02-20T00:00:00.000Z",
    "estimated_minutes": 240,
    "created_at": "2026-02-14T12:00:00.000Z",
    "updated_at": "2026-02-14T13:00:00.000Z",
    "tags": ["backend", "security"]
  }
}
```

### tasks update <id>

Update a task. All options are optional (partial update).

**Examples:**

```bash
# Update status / assignee / priority
tasks update 42 --status done
tasks update 42 --assignee bob --priority urgent

# Update multiple fields
tasks update 42 --status in_progress --description "Updated description" \
  --due "2026-03-01T00:00:00Z" --tags "backend,api,urgent"

# Block atomically on other tasks (edge + status in one transaction)
tasks update 42 --status blocked --blocked-by 57,58
```

**Options:**

| Option | Type | Description |
|--------|------|-------------|
| --title | string | Update task title |
| --description | string | Update task description |
| --status | string | Update status (validates transitions) |
| --priority | string | Update priority (low, medium, high, urgent) |
| --assignee | string | Update assignee name |
| --due | string | Update due date (ISO8601 format) |
| --tags | string | Update tags (comma-separated, replaces all tags) |
| --blocked-by | string | Blocking task IDs (comma-separated). Only valid with `--status blocked`: adds the blocking dependency edge(s) and sets the status atomically (task #1004) — the task auto-unblocks when the blockers close |

**Output:**

```
Updated task #42

Title: Implement authentication
Status: done
Priority: high
Assignee: alice
Updated: 2026-02-14T15:00:00.000Z
```

### tasks delete <id>

Delete a task.

**Example:**

```bash
tasks delete 42
```

**With confirmation:**

```
Are you sure you want to delete task #42? (y/N): y
Task #42 deleted successfully
```

**Skip confirmation:**

```bash
tasks delete 42 --force
```

## Project Commands

### tasks project-create

Create a new project.

**Interactive mode:**

```bash
tasks project-create
```

**Non-interactive mode:**

```bash
tasks project-create \
  --name "My Project" \
  --description "Project description"
```

**Options:**

| Option | Short | Type | Description |
|--------|-------|------|-------------|
| --name | -n | string | Project name (required, max 100 chars) |
| --description | -d | string | Project description (optional, max 1000 chars) |

**JSON output:** the created project is nested under `.data.project`; its id is also at `.metadata.id` (extract with `tasks project-create --name "My Project" --json | jq -r '.metadata.id'`).

### tasks project-list

List all projects.

**Example:**

```bash
tasks project-list
```

**Output:**

```
Found 2 projects:

ID  Name          Description
1   Project Alpha First project
2   Project Beta  Second project
```

**JSON output:**

```bash
tasks project-list --json
```

### tasks project-show <id>

Show project details.

**Example:**

```bash
tasks project-show 1
```

**Output:**

```
Project #1: Project Alpha

Name: Project Alpha
Description: First project
Created: 2026-02-14T12:00:00.000Z
Updated: 2026-02-14T12:00:00.000Z
```

### tasks project-update <id>

Update a project.

**Example:**

```bash
tasks project-update 1 --name "Updated Name"
tasks project-update 1 --description "New description"
```

**Options:**

| Option | Short | Type | Description |
|--------|-------|------|-------------|
| --name | -n | string | Update project name |
| --description | -d | string | Update project description |

### tasks project-delete <id>

Delete a project.

**Example:**

```bash
tasks project-delete 1
```

**With confirmation:**

```
Are you sure you want to delete project #1? (y/N): y
Project #1 deleted successfully
```

## Model Commands

The **Configurable Task Models** layer lets you route each pipeline role
(`execution` for `/tasks:loop` & `/tasks:loop-dag` workers, `validation` for
verifiers, `planning` for `/tasks:decompose` / `/tasks:audit` /
integration-auditor dispatches) at a chosen Claude model — globally or
per-project. Model refs are a runtime-discovered catalog model id or the
`auto` sentinel (resolve the best live model at dispatch). The six power
categories are `minimal`, `light`, `moderate`, `strong`, `heavy`, `maximum`.

> The easiest way to author a policy interactively is the
> [`/tasks:set-models`](#configurable-models) skill, which interviews you and
> calls these commands for you. The commands below are the non-interactive
> surface.

### tasks models list

List the runtime-discovered Claude model catalog (sourced from the Models API,
with a static fallback when offline or when `ANTHROPIC_API_KEY` is unset). Each
row is `<id>  <display_name>  [<family>]`; a `(stale)` suffix and a warning
line indicate the static fallback was served.

**Example:**

```bash
tasks models list
tasks --json models list   # { models, stale } for scripting
```

### tasks project-set-models <id>

Set a single project's model policy. The per-role flags assemble a partial
`ModelPolicy` that is validated, **merged client-side over the currently
stored policy** (fetch-merge-write — the server's `PUT /projects/:id` replaces
the column wholesale), and persisted. Incremental invocations are therefore
non-destructive: adding validation routing later does not erase earlier
execution flags. Flag shapes:

- `--<role>-<category> <model|auto>` — route a role's power category (e.g.
  `--execution-heavy claude-opus-4-1` or `--validation-light auto`).
- `--<role>-default <model|auto>` — the role's fallback when no category route
  matches.
- `--planning-constant <model|auto>` — a single constant model for **every**
  planning dispatch (the planning role's simplest, most common setting — used
  because decompose/audit/integration-auditor have no per-task power category
  to size-route against).

Where `<role>` ∈ `execution | validation | planning`.

**Example:**

```bash
# Heavy execution work → Opus; everything else inherits the global default.
tasks project-set-models 7 --execution-heavy claude-opus-4-1 --execution-default auto

# Pin all planning dispatches for project 7 to a cheaper model.
tasks project-set-models 7 --planning-constant claude-haiku-4
```

### tasks settings-set-models

Set the **database-wide default** model policy (`PUT /settings/model-policy`).
Identical flag surface and the same client-side fetch-merge-write semantics as
`project-set-models` (minus the `<id>` argument). A
project with no `model_policy` of its own inherits this default; an
unconfigured default means dispatches inherit the orchestrator's session model
(the backward-compatible behaviour).

**Example:**

```bash
tasks settings-set-models --planning-constant auto --validation-default auto
```

## Dependency Commands

### tasks dep-add <taskId> <blocksTaskId>

Add a dependency relationship (taskId blocks blocksTaskId).

**Example:**

```bash
# Task 42 blocks task 43
tasks dep-add 42 43
```

**Output:**

```
Dependency created: Task 42 blocks Task 43
```

### tasks dep-remove <taskId> <blocksTaskId>

Remove a dependency relationship.

**Example:**

```bash
tasks dep-remove 42 43
```

**Output:**

```
Dependency removed: Task 42 no longer blocks Task 43
```

### tasks dep-list <taskId>

List all dependencies for a task.

**Example:**

```bash
tasks dep-list 42
```

**Output:**

```
Dependencies for task #42:

This task blocks:
- [43] Deploy to production (blocked)

This task is blocked by:
- [41] Write tests (in_progress)
```

**JSON output:**

```bash
tasks dep-list 42 --json
```

```json
{
  "success": true,
  "data": {
    "task_id": 42,
    "blocks": [
      {
        "id": 43,
        "title": "Deploy to production",
        "status": "blocked"
      }
    ],
    "blocked_by": [
      {
        "id": 41,
        "title": "Write tests",
        "status": "in_progress"
      }
    ]
  }
}
```

## Topology Command

### tasks topology

Classify a project's task graph as `FLAT`, `DAG`, or `DAG_CYCLIC` and emit an execution advisory. Opens a read-only handle on the configured `DATABASE_PATH` and runs the classifier in-process (no API round-trip).

**Example:**

```bash
tasks topology --project 1
```

**Options:**

| Option | Type | Description |
|--------|------|-------------|
| --project | number | Project ID (positive integer, required) |

**Output:**

Always emits the bare `TopologyReport` JSON object on stdout (no `{success, data}` envelope) — this is a machine-readable advisory, not a human dashboard. Pipe through `jq` to extract fields, e.g. `jq .topology`.

**Exit codes:**

Returns `0` on every successful classification, **including `DAG_CYCLIC`** (the classifier reporting a hostile topology is not itself a failure). Returns `1` only on argument-parse failures (invalid `--project`) or service-layer exceptions.

## WSJF Commands

WSJF (Weighted Shortest Job First) prioritizes a project's backlog by **Cost of Delay ÷ Job Size**. The CLI covers the history/manual-set surface; the ranking, health-linter, and rescore tools are exposed only via MCP and REST — see [`docs/MCP.md`](MCP.md) and [`docs/API.md`](API.md). Each task carries four Fibonacci-tier components (`value`, `timeCriticality`, `riskOpportunity`, `jobSize`), per-component locks/source, and an append-only score history; each project carries an optional value charter with its own version history.

### tasks wsjf-history <taskId>

Show a task's append-only WSJF score history (oldest-first) as JSON. Opens a read-only handle on the configured `DATABASE_PATH` (no API round-trip).

**Example:**

```bash
tasks wsjf-history 42
```

**Output:**

Emits a `{ task_id, total, history }` JSON object on stdout (no `{success, data}` envelope). `history` is the oldest-first array, each row carrying the score inputs (classifications, features, evidence, source, locked), `wsjf_score`/`prev_wsjf_score`, and provenance (`trigger`, `actor_type`, `actor_id`, `charter_version`, `rescore_run_id`). Pipe through `jq` to extract fields, e.g. `jq '.history[-1].wsjf_score'`.

**Exit codes:**

Returns `0` on a successful read (including an empty history for an unscored task). Returns `1` on argument-parse failures (invalid `<taskId>`) or service-layer exceptions.

### tasks wsjf-set <taskId>

Manually set and/or lock a task's four WSJF components. Runs the same enum + cross-component contradiction gate as the REST `PUT /api/v1/tasks/:id/wsjf` endpoint via an in-process `TaskService.updateTask({ wsjf: { …, manual: true } })`, and writes a `manual` score-history row.

**Example:**

```bash
tasks wsjf-set 42 \
  --value 8 \
  --time-criticality 5 \
  --risk-opportunity 3 \
  --job-size 2 \
  --lock value,jobSize
```

**Options:**

| Option | Type | Description |
|--------|------|-------------|
| --value | number | Business Value component (required, Fibonacci tier: 1, 2, 3, 5, 8, 13) |
| --time-criticality | number | Time Criticality component (required, Fibonacci tier: 1, 2, 3, 5, 8, 13) |
| --risk-opportunity | number | Risk/Opportunity-Enablement component (required, Fibonacci tier: 1, 2, 3, 5, 8, 13) |
| --job-size | number | Job Size component (required, Fibonacci tier: 1, 2, 3, 5, 8, 13) |
| --lock | string | Comma-separated component keys to lock so a rescore never overwrites them: any of `value`, `timeCriticality`, `riskOpportunity`, `jobSize` (optional) |

All four component flags are required (manual set is all-four-or-none). Locked components are preserved verbatim by any later `rescore_project`.

**Output:**

On success, emits a `{ task_id, scored, components, locked }` JSON object on stdout reflecting the persisted state.

**Exit codes:**

Returns `0` on a successful write. Returns `1` on argument-parse failures (missing/invalid component flag, non-Fibonacci tier, unknown `--lock` key), a gate rejection (enum or cross-component contradiction, e.g. `jobSize=1` with `value=13`), or service-layer exceptions.

### tasks charter-history <projectId>

Show a project's value-charter version history (oldest-first) as JSON. Opens a read-only handle on the configured `DATABASE_PATH` (no API round-trip).

**Example:**

```bash
tasks charter-history 1
```

**Output:**

Emits a `{ project_id, total, history }` JSON object on stdout (no `{success, data}` envelope). `history` is the oldest-first array, one full charter snapshot per interview version, each row carrying `interview_version`, the self-contained `charter` JSON, `change_kind`, and provenance (`actor_type`, `actor_id`, `changed_at`). Pipe through `jq` to extract fields, e.g. `jq '.history[-1].interview_version'`.

**Exit codes:**

Returns `0` on a successful read (including an empty history for a project with no charter). Returns `1` on argument-parse failures (invalid `<projectId>`) or service-layer exceptions.

> **Note:** a project's value charter is captured through the `/tasks:new-project` interview rather than set directly on the CLI. The `tasks project-create` / `tasks project-update` commands above expose `--name` / `--description` only; if a `value_charter` input is wired onto those commands in a future release it will accept the `ValueCharter` JSON shape documented in [`docs/API.md`](API.md). There is no CLI command for `wsjf_ranking`, `wsjf_health`, or `rescore_project` — use the MCP tools or REST endpoints.

## Comment Commands

### tasks comment-add <taskId>

Add a comment to a task.

**Interactive mode:**

```bash
tasks comment-add 42
# Prompts for author and content
```

**Non-interactive mode:**

```bash
tasks comment-add 42 \
  --author "alice" \
  --content "This looks great!"
```

**Options:**

| Option | Short | Type | Description |
|--------|-------|------|-------------|
| --author | -a | string | Comment author (required, max 100 chars) |
| --content | -c | string | Comment content (required, max 5000 chars) |

**Output:**

```
Comment added to task #42 by alice
```

### tasks comment-list <taskId>

List all comments for a task.

**Example:**

```bash
tasks comment-list 42
```

**Output:**

```
Comments for task #42:

[alice] 2026-02-14 12:00:00
This looks great!

[bob] 2026-02-14 12:05:00
Thanks for the review!

Total: 2 comments
```

**JSON output:**

```bash
tasks comment-list 42 --json
```

### tasks comment-delete <commentId>

Delete a comment.

**Example:**

```bash
tasks comment-delete 1
```

**With confirmation:**

```
Are you sure you want to delete comment #1? (y/N): y
Comment #1 deleted successfully
```

## Subtask Commands

### tasks subtask-create <parentTaskId>

Create a subtask under a parent task.

**Example:**

```bash
tasks subtask-create 42 \
  --title "Subtask 1" \
  --created-by "alice" \
  --assignee "bob"
```

**Options:**

Same as `tasks create`, except:
- `--project` is inherited from parent task
- `--parent-task-id` is set automatically

### tasks subtask-list <parentTaskId>

List all subtasks of a parent task.

**Example:**

```bash
tasks subtask-list 42
```

**Output:**

```
Subtasks of task #42:

ID  Title      Status  Priority  Assignee
43  Subtask 1  open    medium    bob
44  Subtask 2  open    medium    alice

Total: 2 subtasks
```

**JSON output:**

```bash
tasks subtask-list 42 --json
```

## Claim Command

### tasks claim \<id\>

Atomically claim an unassigned task. Sets the assignee and transitions status to `in_progress` in a single atomic operation.

**Examples:**

```bash
# Claim task 42
tasks claim 42 --assignee "agent-1"

# Claim with idempotency key for retry safety
tasks claim 42 --assignee "agent-1" --idempotency-key "claim-42-agent-1"
```

**Options:**

| Option | Short | Type | Description |
|--------|-------|------|-------------|
| --assignee | -a | string | Agent/person claiming the task (required) |
| --idempotency-key | | string | Unique key for retry safety (24h TTL) |

**Output:**

```
Task #42 claimed by agent-1

Title: Implement authentication
Status: in_progress
Priority: high
Project: 1
Assignee: agent-1
```

**JSON output:**

```bash
tasks claim 42 --assignee "agent-1" --json
```

```json
{
  "success": true,
  "data": {
    "task": {
      "id": 42,
      "title": "Implement authentication",
      "description": "Add JWT authentication to API",
      "status": "in_progress",
      "priority": "high",
      "project_id": 1,
      "parent_task_id": null,
      "estimated_minutes": null,
      "assignee": "agent-1",
      "created_by": "bob",
      "due_date": "2026-02-20T00:00:00.000Z",
      "created_at": "2026-02-14T12:00:00.000Z",
      "updated_at": "2026-02-14T12:05:00.000Z",
      "version": 2,
      "claimed_at": "2026-02-14T12:05:00.000Z",
      "tags": ["backend", "security"]
    }
  },
  "metadata": {
    "id": 42,
    "assignee": "agent-1"
  }
}
```

The `data` object wraps the full task under the `task` key. The `metadata` block carries the claimed task id and assignee for quick scripting access. `description`, `assignee`, `due_date`, `parent_task_id`, `estimated_minutes`, and `claimed_at` may be `null`. `version` increments by one on every successful claim/update.

**Error handling:**

If the task is already claimed or not in a claimable state, the command exits with code 1 and displays the conflict message.

## Authentication Commands

These commands manage the local credentials file used for Bearer (PAT) authentication against the WFT server. They are the recommended path for interactive use; the `API_KEY` environment variable and `--token` global flag remain supported for scripting and CI.

### tasks login

Authenticate with the WFT server and write a Personal Access Token to the credentials file. The PAT value itself is never printed (stdout or stderr). Two paths:

- **Device flow (default).** Requests a device code, surfaces a verification URL and user code, best-effort opens a browser, then polls until you approve. Used when browser login can complete against the server — that is, an `https` URL or `http://localhost` / `127.0.0.1`.
- **Manual PAT.** Triggered when you pass `--token <pat>`, *or* automatically when browser login can't complete against the target server (a plain-`http` non-localhost URL — identity providers like Google reject non-`https` OAuth redirect URIs, so the device flow would dead-end). The PAT is validated against `GET /api/v1/me` and persisted to the credentials file. When no `--token` is given on such a server, `login` prints the same `https`-required / how-to-mint-a-PAT guidance `tasks setup` shows, then (on a TTY) prompts you to paste one.

This makes `tasks login` reach parity with `tasks setup --remote`: a remote non-`https` server is no longer a dead end. Both commands share the manual-PAT logic (`canUseBrowserSso` gate + `persistManualPat`), so they can't drift.

> Note: the login-command `--token <pat>` flag (which **persists** a credential) is distinct from the global `--token` flag (which sets a per-invocation Bearer header for outbound API calls and does **not** persist anything). `tasks login --token …` and `tasks --token … login` both reach the manual-PAT persistence path.

**Examples:**

```bash
# Standard interactive device-flow login (https / localhost server)
tasks login

# Don't auto-open a browser (print the URL only)
tasks login --no-browser

# Override the server for this login (stored in the credentials file)
tasks login --server https://tasks.example.com

# Manual PAT — required for a remote plain-http / LAN-IP server where
# Google SSO can't complete. Validated against /api/v1/me, then persisted.
tasks login --server http://tasks.example.local:3000 --token wft_pat_…
```

**Options:**

| Option | Type | Description |
|--------|------|-------------|
| --token | string | Authenticate with a Personal Access Token instead of the device flow (required for remote non-`https` servers). Validated against `GET /api/v1/me`, then stored in the credentials file. |
| --token-name | string | Name for the minted PAT (advisory in v1.6; reserved for v1.7 explicit naming) |
| --no-browser | flag | Skip auto-opening the verification URL in a browser |
| --server | string | Override `API_BASE_URL` for this invocation (persisted to the credentials file) |

**Output:**

In text mode, login chrome (verification URL, user code, progress, or the manual-PAT guidance) is written to **stderr**, so `tasks login && tasks list` keeps stdout clean. On success it prints `Logged in as <displayName>`. With `--json`, a sequence of newline-separated JSON event envelopes is written to stdout — device flow: `{event:"pending"}`, optional `{event:"slow_down"}`, then `{event:"logged_in"}` or `{event:"failed"}`; manual PAT: a single `{event:"logged_in"}` or `{event:"failed"}`.

**Exit codes:**

Returns `0` on a successful login. Returns `1` on an invalid server URL, a failed device-code request, a terminal polling error, a rejected/unreachable PAT, no PAT supplied on a non-`https` server, or a credentials-write failure.

### tasks logout

Revoke the active PAT server-side and remove the local credentials file. The local credentials are always deleted regardless of the server's response, so the machine is left logged out even if the revoke call fails.

**Example:**

```bash
tasks logout
```

**Output:**

In text mode, prints `Logged out` to stderr on success. Running with no credentials file present is **not** an error — it prints `Not logged in` and exits `0` (idempotent, safe to call in CI teardown). If the server-side revoke fails (5xx or network error) the local file is still cleared and a warning tells you to revoke the stranded token id via the web UI. With `--json`, emits a single `{event:"logged_out", ...}` envelope on stdout.

**Exit codes:**

Returns `0` in all cases (including no-credentials and server-side revoke failures — local intent is satisfied).

### tasks whoami

Show the currently logged-in user. Fetches `/api/v1/me` (authoritative identity) and `/api/v1/me/tokens` (best-effort enrichment for the active token's name and last-used timestamp) in parallel.

**Example:**

```bash
tasks whoami
```

**Output:**

Text mode prints aligned fields on stdout: `Display name`, `Email`, `Active token` (name + id), `Last used`, and `Server`. If both the `API_KEY` env var and the credentials file are set, a footer notes the credentials file took precedence. With `--json`, emits a single envelope `{user, server, token?, fallback?}` on stdout (the `token` field is omitted if the token listing fetch failed).

**Exit codes:**

Returns `0` on success. Returns `1` if not logged in (no credentials file), the stored token is invalid (`401`), or the server is unreachable.

## Health Command

### tasks health

Check API server health.

**Example:**

```bash
tasks health
```

**Output:**

```
Service Status: healthy
Version: 1.0.0
Database: ok
Timestamp: 2026-02-14T12:00:00.000Z
```

**JSON output:**

```bash
tasks health --json
```

```json
{
  "success": true,
  "data": {
    "status": "healthy",
    "version": "1.0.0",
    "checks": {
      "database": "ok"
    },
    "timestamp": "2026-02-14T12:00:00.000Z"
  }
}
```

## Diagnostic Commands

These commands operate directly on the local SQLite database file (read from `DATABASE_PATH`, default `./data/tasks.db`). They do not contact the API server.

### tasks doctor

Run diagnostics for database connectivity, disk space, and configuration validity. Useful as a first-line health check when something is misbehaving.

**Example:**

```bash
tasks doctor
```

**Checks performed:**

| Check | What it verifies |
|-------|------------------|
| Database | Opens the SQLite file read-only, runs `SELECT 1`, reports the active journal mode (WAL expected). |
| Disk | Reports free vs total bytes on the partition holding the database. Status is `WARN` below 10% free, `FAIL` below 5%. |
| Config | Parses environment variables against the configuration schema and lists any issues. |

**Exit codes:**

Returns `0` when all checks pass (or only `WARN`). Returns `1` if database, disk, or config status is `FAIL`.

**Output:**

```
Database:  [PASS] Connected (SQLite WAL mode)
Disk:      [PASS] 42.3% free (180.4 GB / 426.7 GB)
Config:    [PASS] All required variables present
```

When a check fails, the corresponding line uses `[FAIL]` (or `[WARN]` for disk usage between 5%–10%). Config failures are followed by per-field issue lines.

**JSON output:**

```bash
tasks doctor --json
```

```json
{
  "success": true,
  "data": {
    "database": {
      "status": "PASS",
      "message": "Connected (SQLite WAL mode)"
    },
    "disk": {
      "status": "PASS",
      "free": 193710571520,
      "total": 458153459712,
      "freePercent": "42.3"
    },
    "config": {
      "status": "PASS",
      "errors": []
    }
  }
}
```

### tasks db-check

Run SQLite `PRAGMA integrity_check` and report database file size. Use after a crash or before a backup to confirm the file is not corrupted.

**Example:**

```bash
tasks db-check
```

**Exit codes:**

Returns `0` when integrity check passes, `1` if it fails (corruption detected).

**Output (PASS):**

```
Integrity:  PASSED
Database:   ./data/tasks.db
Size:       1.42 MB (364 pages x 4096 bytes)
```

**Output (FAIL):**

```
Integrity:  FAILED
Issues:
  - *** in database main ***
  - Page 42: btreeInitPage() returns error code 11
Database:   ./data/tasks.db
Size:       1.42 MB (364 pages x 4096 bytes)
```

**JSON output:**

```bash
tasks db-check --json
```

```json
{
  "success": true,
  "data": {
    "passed": true,
    "message": "ok",
    "dbPath": "./data/tasks.db",
    "sizeBytes": 1490944,
    "pageCount": 364,
    "pageSize": 4096
  }
}
```

When `passed` is `false`, `message` contains the joined integrity issues reported by SQLite.

### tasks backup

Create a hot SQLite backup of the task database using the SQLite Online Backup API. The source database is opened read-only, so backups are safe to run while the API server is live.

**Example:**

```bash
# Default destination: ./tasks-backup-<timestamp>.db
tasks backup

# Custom destination
tasks backup --output /var/backups/tasks/nightly.db
```

**Options:**

| Option | Short | Type | Description |
|--------|-------|------|-------------|
| --output | -o | string | Backup destination path. Default: `./tasks-backup-<ISO-timestamp>.db`. Parent directories are created automatically. |

**Exit codes:**

Returns `0` on success. Returns `1` if the source database is missing or the backup operation fails.

**Output:**

```
Backup created successfully
  Path:   /var/backups/tasks/nightly.db
  Size:   1.42 MB
  Source: ./data/tasks.db
```

**JSON output:**

```bash
tasks backup --output /tmp/snapshot.db --json
```

```json
{
  "success": true,
  "data": {
    "path": "/tmp/snapshot.db",
    "size": 1490944,
    "source": "./data/tasks.db"
  }
}
```

`size` is the size of the backup file in bytes.

### tasks stats

Show task statistics: counts by status, recent activity (last 24h), and per-agent productivity (last 7 days). Reads directly from the database.

**Example:**

```bash
tasks stats
```

**Output:**

```
Task Counts by Status:
  open          12
  in_progress    4
  done          27
  blocked        1
  Total         44

Recent Activity (24h):
  Created:  3
  Updated:  9

Agent Productivity (7 days):
  alice        14 tasks (10 done, 2 in progress)
  bob           8 tasks ( 6 done, 1 in progress)
```

If there are no tasks at all, the command prints `No tasks found.` and exits. If no agent has updated tasks in the last 7 days, the productivity section reads `No agent activity in the last 7 days.`

**JSON output:**

```bash
tasks stats --json
```

```json
{
  "success": true,
  "data": {
    "statusCounts": [
      { "status": "blocked", "count": 1 },
      { "status": "done", "count": 27 },
      { "status": "in_progress", "count": 4 },
      { "status": "open", "count": 12 }
    ],
    "recentActivity": {
      "created": 3,
      "updated": 9
    },
    "agentProductivity": [
      {
        "assignee": "alice",
        "task_count": 14,
        "completed": 10,
        "in_progress": 2
      },
      {
        "assignee": "bob",
        "task_count": 8,
        "completed": 6,
        "in_progress": 1
      }
    ]
  }
}
```

## Status-Line Commands

These commands wire Wood Fired Tasks into an agent harness's status line — the
one-line segment many coding agents render below the prompt. The capability is
harness-agnostic; [Claude Code](https://docs.claude.com/en/docs/claude-code) is
used here as the worked example because it pipes status-line JSON on stdin and
reads a `statusLine` entry from `settings.json`, but any harness that can run a
shell command and (optionally) feed it JSON on stdin can consume `tasks
statusline`.

### tasks statusline

Render the one-line status-line segment for the project linked to the current
directory. Designed to be invoked by a harness on every prompt/turn, so it is
built to be cheap and to never fail the caller.

The command reads the harness's status-line JSON from **stdin** (to EOF) and
uses the reported working directory (`cwd`, or `workspace.current_dir` as a
fallback) to resolve the linked project. Empty or non-JSON stdin is tolerated —
the command falls back to `process.cwd()`. The rendered line has up to two
independently-omittable segments:

- **Counts segment** — the linked project's name plus open and done/closed
  task counts, e.g. `myproj 3 open · 7 done`.
- **Update-hint segment** — a short nudge to run the updater, e.g.
  `⬆ /tasks:update`, appended only when an update is available and the
  update-check feature is enabled (see [Update checks](#update-checks-and-the-tasksupdate-hint)).

**Behavior contract:**

- **Always exits `0`.** Empty/garbage stdin, an unreachable API, a missing or
  malformed cache, or a busted config never crash the command or change the
  exit code. The two segments degrade **independently** — a failure in one
  never suppresses the other.
- **Unlinked → blank.** When the directory is not linked to a project (and no
  update hint applies), the command prints nothing and exits `0`.
- **Fresh cache → no API call.** Counts are served from a short-TTL local cache
  (30s). When the cache is fresh the command makes **no** REST round-trip; it
  only refreshes over the API when the cache is stale or missing.
- **Degraded → stale or blank.** If a refresh is needed but the API is
  unreachable, the command falls back to the stale cached counts when present,
  otherwise omits the counts segment. Still exits `0`.
- **Update hint is a pure cache read.** The hint segment never makes a network
  call; it reads the update-available cache written by the background
  update-check writer.

**Example:**

```bash
echo '{"cwd":"/path/to/repo"}' | tasks statusline
```

**Output:**

```
myproj 3 open · 7 done  ⬆ /tasks:update
```

**Options:**

- `--no-color` — disable ANSI color in the rendered segment. Color is also
  disabled when the `NO_COLOR` environment variable is set.
- The visible width is bounded by the `COLUMNS` environment variable (or the
  harness-reported terminal width). When the line would overflow, the counts
  segment is truncated first; the update hint is preserved.

#### Wiring it into Claude Code's `settings.json`

Claude Code reads a `statusLine` entry from `~/.claude/settings.json` (or a
project-local `.claude/settings.json`). Point it at `tasks statusline`:

```json
{
  "statusLine": {
    "type": "command",
    "command": "tasks statusline"
  }
}
```

Claude Code pipes its status-line JSON to the command on stdin, so no extra
flags are required. If `tasks` is not on the harness's `PATH`, use an absolute
path (e.g. `npx wood-fired-tasks statusline` or the absolute path to the
installed binary).

#### Fallback shell script (harnesses without native status-line JSON)

For harnesses that can run a status-line command but do **not** feed JSON on
stdin, wrap `tasks statusline` in a small script that synthesizes the minimal
JSON from the current directory. Save this as `wft-statusline.sh`, make it
executable (`chmod +x wft-statusline.sh`), and point your harness at it:

```bash
#!/usr/bin/env bash
# Fallback status-line wrapper for harnesses that don't pipe status-line JSON.
# Synthesizes the minimal { "cwd": ... } payload from the current directory and
# forwards it to `tasks statusline` on stdin. Always exits 0 so the host
# status line never breaks.
set -euo pipefail

cwd="${PWD}"
printf '{"cwd":"%s"}' "$cwd" | tasks statusline || true
```

The wrapper always exits `0`; combined with `tasks statusline`'s own
never-fail contract, a missing project, an offline server, or a stale cache
will never break the host status line.

### tasks link-project

Link the current directory to a Wood Fired Tasks project so `tasks statusline`
(and the resolver in general) can find it. Writes a repo-local `.wft/project`
marker file. The write is atomic (temp file + rename) and idempotent —
re-running simply overwrites the marker.

The marker stores either a numeric **project id** or a **project name**:

- `tasks link-project <project>` — link to an explicit id or name. A bare
  positive integer is stored as a numeric id; anything else is stored verbatim
  as a name.
- `tasks link-project` (no argument) — auto-resolve the project from the working
  directory (same resolution `tasks statusline` uses). If a project can be
  resolved, its id (or repo name) is persisted; if it cannot be resolved, the
  command errors and asks you to pass an explicit id/name.

**Examples:**

```bash
# Link by explicit project id
tasks link-project 29

# Link by name
tasks link-project my-repo

# Auto-resolve from the current directory
tasks link-project
```

**Output:**

```
Linked this directory to project 29 (/path/to/repo/.wft/project)
```

**JSON output:**

With the global `--json` flag, emits a single envelope on stdout:

```bash
tasks link-project 29 --json
```

```json
{ "event": "linked", "marker": "/path/to/repo/.wft/project", "identifier": "29", "projectId": 29 }
```

**Exit codes:**

Returns `0` on success. Returns `1` when no `<project>` argument is given and
the project cannot be auto-resolved from the working directory (in `--json` mode
this is reported as an `{ "event": "error", ... }` envelope).

### Setup integration

`tasks setup` offers — **opt-in** and **non-clobbering** — to wire
`tasks statusline` into your harness's status line for you. The offer covers
**both** rendered segments:

- the **counts** segment (linked-project open / done counts), and
- the **update-hint** segment (`⬆ /tasks:update`).

Because it is non-clobbering, `setup` will not overwrite an existing
`statusLine` entry in your `settings.json`; if one is already configured it
leaves it untouched and reports what it found.

### Update checks and the `/tasks:update` hint

The update-hint segment shown by `tasks statusline` is driven by a background
update-check feature. When a newer release is detected, the status line appends
`⬆ /tasks:update` to nudge you to run the updater (`/tasks:update`).

The feature is **on by default** and can be disabled two ways (the env var
wins, and an explicitly falsy env var forces the feature back **on** even when
the config flag disables it):

- **Persistent opt-out** — set `update_check = false` in the CLI config file
  (TOML), the durable per-user flag written by `tasks setup`. The config file
  lives at `$WFT_CONFIG_PATH`, else `$XDG_CONFIG_HOME/wood-fired-tasks/config`,
  else `~/.config/wood-fired-tasks/config`.
- **Ad-hoc / CI override** — set `WFT_NO_UPDATE_CHECK=1` (or `true`/`yes`/`on`)
  to disable the feature for a single invocation without touching the config
  file. Setting it to a falsy value (`0`/`false`/empty) forces the feature on.

When the feature is disabled, `tasks statusline` never appends the update hint.

## Configurable models

The CLI's [Model Commands](#model-commands) (`models list`,
`project-set-models`, `settings-set-models`) are the low-level surface for the
**Configurable Task Models** layer. They map onto the MCP model tools
(`list_models` / `resolve_model` / `get_model_defaults` / `set_model_defaults`
— see [MCP.md](MCP.md#model-tools-4-tools)) and the model routes in
[API.md](API.md#models--model-policy-endpoints) (`GET /models`,
`GET|PUT /settings/model-policy`, `GET /projects/:id/resolve-model`, plus
`model_policy` on the project routes).

For day-to-day use, prefer the **`/tasks:set-models`** skill — an adaptive
interview that discovers the live model catalog, asks which roles/categories
you want to pin, and writes the policy for you via the commands above (project
scope or global default). The loop skills then resolve each dispatch's model
through `resolve_model` per
[loop-shared.md §R](../skills/tasks/loop-shared.md): workers run the
`execution` role, verifiers the `validation` role, and
`/tasks:decompose` / `/tasks:audit` / the integration-auditor run the
`planning` role.

## Database Administration Commands

The `tasks db` parent command groups DB-admin subcommands that operate directly on the local SQLite database (read from `DATABASE_PATH`, default `./data/tasks.db`). They do not contact the API server. The flat `tasks db-check` command (documented above) coexists with this namespace by design.

### tasks db mint-token

Mint a Personal Access Token by direct DB access. This is the bootstrap path for the first PAT before browser sessions are available — it bypasses the API, auth chain, and HTTP entirely. Pending migrations are applied automatically before the insert. **The token is printed exactly once and cannot be retrieved later.**

**Examples:**

```bash
# Mint a token for the legacy user, no expiry
tasks db mint-token --user 1 --name "ci-runner"

# Mint with scopes and an expiry
tasks db mint-token \
  --user alice@example.com \
  --name "deploy-bot" \
  --scopes "admin,reader" \
  --expires-at 2027-05-22T00:00:00Z
```

**Options:**

| Option | Type | Description |
|--------|------|-------------|
| --user | string | User identifier — numeric id, email (case-insensitive), or legacy display_name (required) |
| --name | string | Human-readable token label (required) |
| --scopes | string | Comma-separated scope list (advisory in v1.6; not enforced) |
| --expires-at | string | ISO-8601 expiry timestamp with explicit timezone (e.g. `2027-05-22T00:00:00Z`). Bare dates and timezone-less stamps are rejected. |

**Output:**

```
Token: wft_pat_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
Id: 17
User: 1 (legacy-key)
Scopes: [admin, reader]
Expires: 2027-05-22T00:00:00Z
```

`Scopes` is always printed (`[]` when empty). `Expires` is omitted entirely when `--expires-at` was not supplied.

**Exit codes:**

Returns `0` on success. Returns `1` if the user cannot be resolved (`User '<arg>' not found.`) or `--expires-at` is not a valid strict ISO-8601 timestamp.

### tasks db migrate-identities

Backfill the identity foreign-key columns (`tasks.created_by_user_id`, `tasks.assignee_user_id`, `task_comments.author_user_id`) from the legacy TEXT columns. **Dry-run by default**; pass `--commit` to apply. Idempotent on re-run. Resolution order per value: alias-map override → email match → exact display_name → fallback strategy.

**Examples:**

```bash
# Preview the migration plan (read-only)
tasks db migrate-identities

# Apply, defaulting unmatched values to the first-seeded legacy user
tasks db migrate-identities --commit

# Use an operator-supplied alias map and skip unmatched values
tasks db migrate-identities \
  --alias-map ./aliases.json \
  --user-fallback skip \
  --commit
```

**Options:**

| Option | Type | Description |
|--------|------|-------------|
| --alias-map | string | Path to a JSON file mapping legacy TEXT values to user IDs (values must be positive integers and exist in `users`) |
| --commit | flag | Apply changes. Without it the command is a read-only dry-run. |
| --user-fallback | string | How to handle unmatched values: `legacy` (default — pin to the lowest-id legacy user) or `skip` (leave the FK NULL) |
| --limit | number | Cap rows processed **per table** (not per mapping). Testing aid. |

**Output:**

Prints a per-table plan (sorted by row count, highest impact first) in both modes. Dry-run ends with `Total rows that would be updated: N` and `Run with --commit to apply.`. Commit mode prints `Updated N rows in <table> (<textCol> → <fkCol>)` per table and a final `Done. Total rows updated: N.`.

**Exit codes:**

Returns `0` on success. Returns `1` on an invalid `--user-fallback` value, a malformed/unreadable `--alias-map`, an alias-map user id missing from `users`, or `--user-fallback legacy` when no legacy user is seeded.

## Reporting Commands

### tasks completed

Dashboard view of tasks that transitioned to `status='done'` within a time interval. Aggregates by project, assignee, priority, and daily throughput. Reads directly from the database.

**Examples:**

```bash
# Last 7 days (default if no range supplied)
tasks completed

# Trailing N days
tasks completed --days 30

# Explicit range (both --since and --until required together)
tasks completed --since 2026-04-01 --until 2026-04-30

# Scope to one project and assignee
tasks completed --days 14 --project 1 --assignee alice
```

**Options:**

| Option | Short | Type | Description |
|--------|-------|------|-------------|
| --days | -d | number | Trailing N days from now. Must be a positive integer. Default: `7` when no range is supplied. |
| --since | | string | Range start (ISO8601, inclusive). Must be paired with `--until`. |
| --until | | string | Range end (ISO8601, inclusive). Must be paired with `--since`. |
| --project | -p | number | Filter by project ID (positive integer). |
| --assignee | -a | string | Filter by assignee name. |

Passing only one of `--since` / `--until` is an error — provide both, or use `--days`.

**Output:**

```
Completion Report
  Range:  2026-05-13T00:00:00.000Z  ->  2026-05-20T00:00:00.000Z
  Total:  4 task(s) completed

ID  Title                         Project        Assignee  Priority  Completed             Time to complete
42  Implement authentication      Project Alpha  alice     high      5/18/2026, 3:42:00 PM 2d 4h
43  Write tests                   Project Alpha  bob       medium    5/19/2026, 9:10:00 AM 1d
...

By project:
  Project Alpha                  3
  Project Beta                   1

By assignee:
  alice                          2
  bob                            2

By priority:
  high                           1
  medium                         3

Daily throughput:
  2026-05-18    2  ##
  2026-05-19    1  #
  2026-05-20    1  #
```

If no tasks completed in the interval, the command prints `No completed tasks in this interval.` after the header.

**JSON output:**

```bash
tasks completed --days 7 --json
```

```json
{
  "success": true,
  "data": {
    "range": {
      "start": "2026-05-13T00:00:00.000Z",
      "end": "2026-05-20T00:00:00.000Z"
    },
    "total": 4,
    "rows": [
      {
        "id": 42,
        "title": "Implement authentication",
        "project_id": 1,
        "assignee": "alice",
        "priority": "high",
        "completed_at": "2026-05-18T15:42:00.000Z",
        "time_to_complete_seconds": 187200
      }
    ],
    "by_project": [
      { "project_id": 1, "count": 3 },
      { "project_id": 2, "count": 1 }
    ],
    "by_assignee": [
      { "assignee": "alice", "count": 2 },
      { "assignee": "bob", "count": 2 }
    ],
    "by_priority": [
      { "priority": "high", "count": 1 },
      { "priority": "medium", "count": 3 }
    ],
    "daily_throughput": [
      { "date": "2026-05-18", "count": 2 },
      { "date": "2026-05-19", "count": 1 },
      { "date": "2026-05-20", "count": 1 }
    ]
  },
  "metadata": {
    "count": 4
  }
}
```

`range` appears only inside `data.range` (the report payload). It is no longer duplicated under `metadata`.

## Shell Completion

### tasks completions \<shell\>

Generate a shell completion script and print it to stdout. Pipe to a file or source it from your shell rc to enable tab-completion for commands, subcommands, status values, and priority values.

**Supported shells:** `bash`, `zsh`.

**Examples:**

```bash
# Bash: append to ~/.bashrc (or drop into /etc/bash_completion.d/)
tasks completions bash >> ~/.bashrc

# Zsh: write to a directory on $fpath and add the directory to fpath in ~/.zshrc
mkdir -p ~/.zsh/completions
tasks completions zsh > ~/.zsh/completions/_tasks
echo 'fpath=(~/.zsh/completions $fpath)' >> ~/.zshrc
```

After restarting your shell (or `source ~/.bashrc` / `compinit` for zsh), pressing TAB after `tasks ` will complete command names. Pressing TAB after `--status ` or `--priority ` will complete valid enum values.

**Arguments:**

| Argument | Type | Description |
|----------|------|-------------|
| shell | string | Required. One of `bash` or `zsh`. Any other value exits with code 1. |

**Exit codes:**

Returns `0` on success. Returns `1` if `shell` is not `bash` or `zsh`.

This command does not honor `--json` — it always emits the raw shell script on stdout.

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | Error (validation, API error, connection error) |

## Tips

### Using in Scripts

For scripting, use `--json` mode and `--no-input` to avoid interactive prompts:

```bash
#!/bin/bash

# Create a task and capture the ID
RESPONSE=$(tasks create \
  --title "Automated task" \
  --project 1 \
  --created-by "bot" \
  --json \
  --no-input)

TASK_ID=$(echo "$RESPONSE" | jq -r '.metadata.id')

echo "Created task: $TASK_ID"

# Add a comment
tasks comment-add "$TASK_ID" \
  --author "bot" \
  --content "Task created by automation" \
  --json \
  --no-input
```

### Filtering Tasks

Combine multiple filters for precise queries:

```bash
# High-priority bugs assigned to alice
tasks list \
  --priority high \
  --tags bug \
  --assignee alice

# Overdue open tasks
tasks list \
  --status open \
  --due-before "2026-02-14T00:00:00Z"
```

### Color Output

The CLI uses colored output in terminal mode:

- Green: Success messages
- Red: Error messages
- Yellow: Warnings
- Cyan: Headers and labels

Use `--json` mode to disable colors for piping to other commands.
