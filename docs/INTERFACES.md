# Interface Summary

Owner: Repository maintainers

Compact, source-verified inventory of every public surface (REST routes, MCP
tools, CLI commands) and the shared service / schema layer beneath them.
Counts in this file are asserted against source by
`scripts/agent-context/__tests__/interfaces-counts.test.ts`; if the test
fails, regenerate this doc. Deep references live in
[`docs/API.md`](API.md), [`docs/MCP.md`](MCP.md), [`docs/CLI.md`](CLI.md),
[`docs/ARCHITECTURE.md`](ARCHITECTURE.md), and the navigation hub
[`AGENTS.md`](../AGENTS.md) → [`docs/AGENT_CONTEXT.md`](AGENT_CONTEXT.md).

> **Source of truth.** Validation rules and interface behaviour are defined
> in `src/schemas/` and `src/services/`. This doc lists what is exposed; the
> source files define what it does. INTERFACES.md is currently hand-written
> and drift-checked by test (future task may convert to a generator).

## Decision aid: which layers must I touch?

| Change | Touches |
|---|---|
| Add/rename a field on a task | `src/schemas/task.schema.ts` → `src/services/` → both `src/api/routes/` and `src/mcp/tools/` and `src/cli/commands/` (all three are thin adapters) |
| New verb on tasks | new schema + new service method → REST route → local MCP tool → remote MCP register-tools → CLI command → docs/API|MCP|CLI |
| Workflow rule | `src/services/workflow-engine.ts` only (consumes events) |
| Slack output | `src/slack/` only — never gated by surface auth |
| Anything user-visible | confirm the matching `docs/<surface>.md` and this file still match source |

## REST routes (Fastify)

All authenticated routes mount under `/api/v1` and require `X-API-Key`
(validated by `src/api/plugins/auth.ts`). `/health` is public; `/health/detailed`
is gated by the same auth plugin. Source: the six files under
`src/api/routes/`. Registration prefixes are in `src/api/server.ts`.

| Method | Path | Source | Purpose | Auth |
|---|---|---|---|---|
| GET | `/health` | `routes/health.ts` | Minimal public health (status + timestamp + version). | No |
| GET | `/health/detailed` | `routes/health.ts` | Component checks + runtime stats. | Yes |
| GET | `/api/v1/events` | `routes/events.ts` | SSE stream of task/project events (filterable). | Yes |
| POST | `/api/v1/tasks` | `routes/tasks/index.ts` | Create a task. | Yes |
| GET | `/api/v1/tasks` | `routes/tasks/index.ts` | List tasks with filters + pagination. | Yes |
| GET | `/api/v1/tasks/completion-report` | `routes/tasks/index.ts` | Completion dashboard for a time window. | Yes |
| GET | `/api/v1/tasks/:id` | `routes/tasks/index.ts` | Get a task by id. | Yes |
| PUT | `/api/v1/tasks/:id` | `routes/tasks/index.ts` | Update a task. | Yes |
| DELETE | `/api/v1/tasks/:id` | `routes/tasks/index.ts` | Delete a task. | Yes |
| POST | `/api/v1/tasks/:id/claim` | `routes/tasks/index.ts` | Atomically claim an unassigned task. | Yes |
| GET | `/api/v1/tasks/:id/subtasks` | `routes/tasks/index.ts` | List subtasks of a parent task. | Yes |
| POST | `/api/v1/projects` | `routes/projects/index.ts` | Create a project. | Yes |
| GET | `/api/v1/projects` | `routes/projects/index.ts` | List projects (paginated). | Yes |
| GET | `/api/v1/projects/:id` | `routes/projects/index.ts` | Get project by id. | Yes |
| PUT | `/api/v1/projects/:id` | `routes/projects/index.ts` | Update project by id. | Yes |
| DELETE | `/api/v1/projects/:id` | `routes/projects/index.ts` | Delete project by id. | Yes |
| POST | `/api/v1/tasks/:id/comments` | `routes/comments/index.ts` | Add a comment to a task. | Yes |
| GET | `/api/v1/tasks/:id/comments` | `routes/comments/index.ts` | List comments for a task. | Yes |
| DELETE | `/api/v1/tasks/:id/comments/:commentId` | `routes/comments/index.ts` | Delete a comment. | Yes |
| POST | `/api/v1/tasks/:id/dependencies` | `routes/dependencies/index.ts` | Add dependency (this task blocks another). | Yes |
| GET | `/api/v1/tasks/:id/dependencies` | `routes/dependencies/index.ts` | Get all dependencies for a task. | Yes |
| DELETE | `/api/v1/tasks/:id/dependencies/:blocksTaskId` | `routes/dependencies/index.ts` | Remove a dependency. | Yes |

**Total: 22 routes.** Counted by the regex
`/(fastify|server)\.(get|post|put|patch|delete)\(/g` across the six files
above. README's "20 authenticated endpoints" claim is stale — see follow-up
task #283.

Deep reference: [`docs/API.md`](API.md). Interactive OpenAPI is exposed at
`/docs` when `npm run dev` runs (production opt-in via
`ENABLE_SWAGGER_IN_PRODUCTION=true`); spec collector is
`src/api/plugins/swagger.ts`. No static OpenAPI snapshot is committed today.

## MCP tools

Tool definitions live in `src/mcp/tools/`. The same tool table is registered
into both the **local** server (`src/mcp/server.ts`, stdio, in-process
service calls) and the **remote** server (`src/mcp/remote/`, HTTP, proxies
through the REST API). Input schemas come from `src/schemas/task.schema.ts`
so REST and MCP cannot drift on validation.

| File | Tool | Verb | Purpose |
|---|---|---|---|
| `tools/task-tools.ts` | `create_task` | write | Create a task in a project. |
| `tools/task-tools.ts` | `get_task` | read | Get a task by id. |
| `tools/task-tools.ts` | `update_task` | write | Update title/desc/status/priority/assignee/due/tags. |
| `tools/task-tools.ts` | `list_tasks` | read | Filterable + paginated list; compact projection by default (`verbose` opts in). |
| `tools/task-tools.ts` | `delete_task` | write | Delete a task. |
| `tools/task-tools.ts` | `claim_task` | write | Atomic claim; rejects already-claimed tasks. |
| `tools/task-tools.ts` | `list_subtasks` | read | Paginated subtask list. |
| `tools/task-tools.ts` | `completion_report` | read | Completion dashboard for a window or trailing N days. |
| `tools/task-tools.ts` | `get_subtasks` | read | Paginated children of a parent task. |
| `tools/project-tools.ts` | `create_project` | write | Create a project. |
| `tools/project-tools.ts` | `get_project` | read | Get a project by id. |
| `tools/project-tools.ts` | `list_projects` | read | Paginated project list. |
| `tools/project-tools.ts` | `update_project` | write | Update name/description. |
| `tools/project-tools.ts` | `delete_project` | write | Delete a project. |
| `tools/dependency-tools.ts` | `add_dependency` | write | Declare that task A blocks task B. |
| `tools/dependency-tools.ts` | `remove_dependency` | write | Remove a dependency. |
| `tools/dependency-tools.ts` | `get_dependencies` | read | Both sides of a task's dependency graph. |
| `tools/comment-tools.ts` | `add_comment` | write | Add a comment to a task. |
| `tools/comment-tools.ts` | `get_comments` | read | Paginated chronological comments. |
| `tools/comment-tools.ts` | `delete_comment` | write | Delete a comment by id. |
| `tools/health-tools.ts` | `check_health` | read | Service health, DB connectivity, version. |

**Total: 21 tools** (9 task, 5 project, 3 dependency, 3 comment, 1 health).
9 are read-only; 12 mutate state. Counted by `grep registerTool` across the
five files above. The remote server registers the same 21 via
`src/mcp/remote/register-tools.ts`.

Deep reference: [`docs/MCP.md`](MCP.md).

## CLI subcommands (`tasks`)

Source: `src/cli/bin/tasks.ts` wires command files from
`src/cli/commands/`. Every wired command is one `program.addCommand(...)`
call.

| Group | Subcommand | File | Purpose |
|---|---|---|---|
| task | `create` | `commands/create.ts` | Create a new task. |
| task | `list` | `commands/list.ts` | List tasks with filters. |
| task | `show` | `commands/show.ts` | Show task details by id. |
| task | `update` | `commands/update.ts` | Update a task by id. |
| task | `delete` | `commands/delete.ts` | Delete a task by id. |
| task | `claim` | `commands/claim.ts` | Atomically claim a task. |
| task | `completed` | `commands/completed.ts` | Dashboard of tasks completed in a window. |
| task | `subtask-create` | `commands/subtask-create.ts` | Create a subtask under a parent. |
| task | `subtask-list` | `commands/subtask-list.ts` | List subtasks of a parent. |
| project | `project-create` | `commands/project-create.ts` | Create a project. |
| project | `project-list` | `commands/project-list.ts` | List all projects. |
| project | `project-show` | `commands/project-show.ts` | Show project details. |
| project | `project-update` | `commands/project-update.ts` | Update a project. |
| project | `project-delete` | `commands/project-delete.ts` | Delete a project. |
| dependency | `dep-add` | `commands/dep-add.ts` | Declare a dependency. |
| dependency | `dep-list` | `commands/dep-list.ts` | List dependencies. |
| dependency | `dep-remove` | `commands/dep-remove.ts` | Remove a dependency. |
| comment | `comment-add` | `commands/comment-add.ts` | Add a comment. |
| comment | `comment-list` | `commands/comment-list.ts` | List comments. |
| comment | `comment-delete` | `commands/comment-delete.ts` | Delete a comment. |
| system | `health` | `commands/health.ts` | Service health probe. |
| system | `doctor` | `commands/doctor.ts` | Diagnostics: DB, disk, config. |
| system | `db-check` | `commands/db-check.ts` | SQLite `PRAGMA integrity_check`. |
| system | `db` | `commands/db.ts` | Nested parent for `db <subcommand>` (currently hosts `mint-token`). |
| system | `backup` | `commands/backup.ts` | SQLite backup. |
| system | `stats` | `commands/stats.ts` | Aggregate task/agent stats. |
| system | `completions` | `commands/completions.ts` | Generate shell completion scripts. |

**Total: 27 commands wired into Commander** (counted by
`program.addCommand` calls in `src/cli/bin/tasks.ts`). README's "20
commands" claim is stale — see follow-up task #283.

Deep reference: [`docs/CLI.md`](CLI.md). Global flags: `--json` (machine
output), `--no-input` (fail on missing args), `--force` (skip confirms).

## Shared schemas

Every surface imports these. They are the validation source of truth — if
you change behaviour, change the schema first.

| File | Purpose |
|---|---|
| `src/schemas/task.schema.ts` | Task + project create/update/list inputs, pagination, filters, completion report, compact projection. |
| `src/schemas/comment.schema.ts` | Comment add input. |
| `src/schemas/dependency.schema.ts` | Dependency add input. |
| `src/schemas/idempotency.schema.ts` | Idempotency-Key validation + cached-response shape. |

## Services

Services own all business logic. REST routes, MCP tools, and CLI commands
are thin adapters that call services. Repositories handle persistence.
Source: `src/services/`.

| Service | Top methods | Events emitted |
|---|---|---|
| `task.service.ts` | `createTask`, `getTask`, `listTasksPaginated`, `updateTask`, `deleteTask`, `claimTask`, `getCompletionReport`, `getSubtasksPaginated` | `task.created`, `task.updated`, `task.status_changed`, `task.deleted`, `task.claimed` |
| `project.service.ts` | `createProject`, `getProject`, `listProjectsPaginated`, `updateProject`, `deleteProject` | `project.created`, `project.updated`, `project.deleted` |
| `comment.service.ts` | `addComment`, `getCommentsPaginated`, `deleteComment` | (none — task events cover audit) |
| `dependency.service.ts` | `addDependency`, `removeDependency`, `getBlockedBy`, `getBlockers` | (none) |
| `claim-release.service.ts` | `releaseClaim` | `task.updated` (on auto-release) |
| `idempotency.service.ts` | `get`, `set`, `cleanup` | n/a |
| `slack.service.ts` | `start`, `stop`, `isEnabled`, `getApp` | n/a (consumes events, does not emit) |
| `workflow-engine.ts` | `start`, `stop` | re-emits `task.updated`/`status_changed` on cascade |

`src/services/errors.ts` exports the typed error classes used below — it is
shared infrastructure, not a service.

## Repository boundaries

- Only `src/repositories/` may construct `better-sqlite3` statements; nothing
  else opens the DB directly.
- Services compose multiple repositories inside transactions when atomicity
  is required (e.g. claim, dependency cycle check, subtask cascade).
- `src/repositories/row-mapper.ts` is the canonical converter for joined
  `task_tags` rows; route/tool/CLI code never reshapes rows by hand.
- Helper files (`errors.ts`, `interfaces.ts`, `row-mapper.ts`, `types.ts`)
  are not repositories. The four concrete repositories are `task`,
  `project`, `comment`, `dependency`.

## Pagination envelope

Every list endpoint returns:

```json
{ "data": [...], "total": 0, "limit": 50, "offset": 0 }
```

Bounds from `src/schemas/task.schema.ts`: `limit` default 50, max 500;
`offset` default 0, non-negative. `total` is the unbounded count for the
same filter set so callers can paginate without re-querying without
filters. MCP list tools wrap the same envelope under a domain key
(`{ tasks, total, limit, offset }`, etc.) but use the same bounds.

## Auth expectations

| Surface | Header / mechanism | Required? |
|---|---|---|
| REST `/api/v1/**` | `X-API-Key` (against `API_KEYS` env, constant-time compare in `src/api/plugins/auth.ts`) | Yes |
| REST `/health` | none | No |
| REST `/health/detailed` | `X-API-Key` | Yes |
| Local MCP (`src/mcp/server.ts`) | stdio, trusts parent process | No |
| Remote MCP (`src/mcp/remote/`) | `X-API-Key` forwarded to the REST server's `API_KEYS` | Yes |
| CLI (`tasks`) | `X-API-Key` sourced from `API_KEY` env (set by the installer) | Yes |
| Slack | Slack signing secret on inbound; bot token outbound | Yes |

Global rate limit (`@fastify/rate-limit`) applies to every REST route except
`/health*`; defaults are 1000 req/min, tunable via `RATE_LIMIT_MAX` and
`RATE_LIMIT_TIME_WINDOW`. Response shape on breach:
`{ error: 'TOO_MANY_REQUESTS', message }` with HTTP 429.

## Error handling cheatsheet

Service-layer error classes (`src/services/errors.ts`) flow into every
surface via the central error handler (`src/api/hooks/error-handler.ts`)
for REST, and `src/mcp/errors.ts`'s `convertToMcpError` for MCP. The CLI
turns API errors into `ApiClientError` and exits non-zero.

| Service error | HTTP status (REST) | MCP wrapper | CLI behaviour |
|---|---|---|---|
| `ValidationError` | 400 | `convertToMcpError` → `InvalidParams` | `ApiClientError`, exit 1 |
| `NotFoundError` | 404 | `convertToMcpError` → `InvalidParams` | `ApiClientError`, exit 1 |
| `BusinessError` (incl. claim conflict) | 422 (claim → 409) | `convertToMcpError` | `ApiClientError`, exit 1 |
| Unknown | 500 (no stack leaked) | `convertToMcpError` → `InternalError` | `ApiClientError`, exit 1 |

The Pino logger redacts `authorization`, `cookie`, `x-api-key`, `password`,
`secret`, `apiKey`, and `token` paths (see `LOGGER_REDACT_CONFIG` in
`src/api/server.ts`); responses never echo these back.

## Local vs remote MCP parity

The local MCP server binds in-process and calls services directly. The
remote MCP server proxies every tool call to the REST API via
`src/mcp/remote/rest-client.ts`. Tools are defined **once** in
`src/mcp/tools/*` and re-registered into the remote server by
`src/mcp/remote/register-tools.ts`, which imports the same Zod schemas from
`src/schemas/`. Both transports therefore expose **the same 21 tools**
with identical input validation; behavioural differences are limited to
transport (stdio vs HTTP) and the auth boundary.

**Parity rule:** any new MCP tool MUST land in both servers in the same PR.
The drift-detection test enforces the local count; a follow-up should
extend it to assert the remote count matches.

## Pointers

| Doc | When to read |
|---|---|
| [`AGENTS.md`](../AGENTS.md) | Always first. Vendor-neutral navigation. |
| [`docs/AGENT_CONTEXT.md`](AGENT_CONTEXT.md) | Authoritative file contract. |
| [`docs/REPO_MAP.md`](REPO_MAP.md) | Compact directory ownership map. |
| [`docs/ARCHITECTURE.md`](ARCHITECTURE.md) | Data flow across the four surfaces. |
| [`docs/API.md`](API.md) | Full REST reference (route by route). |
| [`docs/MCP.md`](MCP.md) | Full MCP tool reference. |
| [`docs/CLI.md`](CLI.md) | Full CLI reference (every flag, every command). |
| [`docs/WORKFLOWS.md`](WORKFLOWS.md) | Canonical build/test/lint/run recipes. |
| [`docs/SLACK.md`](SLACK.md) | Slack notifier behaviour and signing-secret setup. |
| OpenAPI | Live at `/docs` (Swagger UI) when `npm run dev` runs; spec collector in `src/api/plugins/swagger.ts`. No committed snapshot. |
| Tests | `src/api/__tests__/`, `src/mcp/__tests__/`, `src/cli/__tests__/`, `src/services/__tests__/`. |
