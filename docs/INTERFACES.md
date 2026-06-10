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

Authenticated `/api/v1/**` routes require a Bearer PAT (`Authorization: Bearer
<pat>`, validated by `src/api/plugins/auth.ts`). `/health` is public;
`/health/detailed` is gated by the same auth plugin. The `/auth/*` and `/web/*`
surfaces are the OAuth / device-flow / browser-login layer and carry their own
session/CSRF handling rather than a Bearer PAT. Source: the files under `src/api/routes/` (auth,
web, me, tasks, projects, comments, dependencies, events, health). Registration
prefixes are in `src/api/server.ts`.

The core task/project/comment/dependency CRUD surface:

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
| GET | `/api/v1/projects/:id/topology` | `routes/projects/topology.ts` | Topology classification (FLAT/DAG/DAG_CYCLIC). | Yes |
| GET | `/api/v1/projects/:id/dependency-graph` | `routes/projects/dependency-graph.ts` | Dependency-graph tree view (#342). | Yes |
| GET | `/api/v1/projects/:id/resolve-model` | `routes/projects/resolve-model.ts` | Configurable Task Models (#926): resolve the model for a pipeline role (`{ model }` or `null`). | Yes |
| GET | `/api/v1/models` | `routes/models/index.ts` | Configurable Task Models (#922): runtime Claude model catalog (`{ models, stale }`). | Yes |
| GET | `/api/v1/settings/model-policy` | `routes/settings/model-policy.ts` | Configurable Task Models (#922): read the DB-wide model-policy default. | Yes |
| PUT | `/api/v1/settings/model-policy` | `routes/settings/model-policy.ts` | Configurable Task Models (#922): set/clear the DB-wide model-policy default. | Yes |
| GET | `/api/v1/projects/:id/charter-history` | `routes/projects/wsjf.ts` | WSJF 4.5 (#645): chronological value-charter snapshots. | Yes |
| GET | `/api/v1/projects/:id/rescore-runs` | `routes/projects/wsjf.ts` | WSJF 4.5 (#645): chronological rescore runs. | Yes |
| GET | `/api/v1/tasks/:id/wsjf` | `routes/tasks/wsjf.ts` | WSJF 4.5 (#645): read persisted WSJF components/evidence/locks. | Yes |
| PUT | `/api/v1/tasks/:id/wsjf` | `routes/tasks/wsjf.ts` | WSJF 4.5 (#645): set/lock components (manual gate). | Yes |
| GET | `/api/v1/tasks/:id/score-history` | `routes/tasks/wsjf.ts` | WSJF 4.5 (#645): chronological WSJF score history. | Yes |
| POST | `/api/v1/tasks/:id/comments` | `routes/comments/index.ts` | Add a comment to a task. | Yes |
| GET | `/api/v1/tasks/:id/comments` | `routes/comments/index.ts` | List comments for a task. | Yes |
| DELETE | `/api/v1/tasks/:id/comments/:commentId` | `routes/comments/index.ts` | Delete a comment. | Yes |
| POST | `/api/v1/tasks/:id/dependencies` | `routes/dependencies/index.ts` | Add dependency (this task blocks another). | Yes |
| GET | `/api/v1/tasks/:id/dependencies` | `routes/dependencies/index.ts` | Get all dependencies for a task. | Yes |
| DELETE | `/api/v1/tasks/:id/dependencies/:blocksTaskId` | `routes/dependencies/index.ts` | Remove a dependency. | Yes |

The identity / auth / web surface (`src/api/routes/me/`, `auth/`, `web/`):

| Method | Path | Source | Purpose | Auth |
|---|---|---|---|---|
| GET | `/api/v1/me` | `routes/me/profile.ts` | Current authenticated identity. | Yes |
| POST | `/api/v1/me/tokens` | `routes/me/tokens.ts` | Mint a PAT (registered via `fastify.route`). | Yes |
| GET | `/api/v1/me/tokens` | `routes/me/tokens.ts` | List the caller's PATs. | Yes |
| DELETE | `/api/v1/me/tokens/active` | `routes/me/tokens.ts` | Revoke the currently-presented PAT. | Yes |
| DELETE | `/api/v1/me/tokens/:id` | `routes/me/tokens.ts` | Revoke a PAT by id. | Yes |
| GET | `/auth/login` | `routes/auth/login.ts` | Begin OAuth login. | OIDC |
| GET | `/auth/callback` | `routes/auth/callback.ts` | OAuth provider redirect target. | OIDC |
| GET | `/auth/error` | `routes/auth/auth-error.ts` | OAuth error landing page. | OIDC |
| POST | `/auth/logout` | `routes/auth/logout.ts` | End the browser session. | OIDC |
| POST | `/auth/device/code` | `routes/auth/device-code.ts` | Device-flow: request a device + user code. | OIDC |
| POST | `/auth/device/token` | `routes/auth/device-token.ts` | Device-flow: poll/exchange for a token. | OIDC |
| GET | `/auth/device` | `routes/auth/device-html.ts` | Device-flow: code-entry HTML page. | OIDC |
| POST | `/auth/device/verify` | `routes/auth/device-html.ts` | Device-flow: submit the user code. | OIDC |
| GET | `/web/login` | `routes/web/login.ts` | Browser login page. | OIDC |
| GET | `/web/me` | `routes/web/me.ts` | Browser account page. | Session |
| GET | `/web/me/tokens` | `routes/web/tokens.ts` | Browser PAT management page. | Session |
| POST | `/web/me/tokens/:id/revoke` | `routes/web/tokens.ts` | Browser PAT revoke action. | Session |

When OIDC is disabled, the 7 verb-registered handlers in
`routes/auth/disabled-stub.ts` (GET `/auth/login`, GET `/auth/callback`,
POST `/auth/logout`) and `routes/auth/device-disabled-stub.ts` (POST
`/auth/device/code`, POST `/auth/device/token`, GET `/auth/device`, POST
`/auth/device/verify`) replace the live `/auth/*` handlers above — the two
sets are mutually exclusive at runtime.

**Core CRUD subtotal — Total: 22 routes** across the six
`{health,events}` + `{tasks,projects,comments,dependencies}/index.ts` files
(the drift-detection anchor counted by
`scripts/agent-context/__tests__/interfaces-counts.test.ts`); the `topology`
and `dependency-graph` rows above live in their own sibling files and are
counted in the full-surface total below.

**Full surface — Total: 59 route handlers; up to 52 reachable in any single
running instance.** Counted by
`/(fastify|server|app)\.(get|post|put|patch|delete)\(/g` across
`src/api/routes/` (excluding `__tests__`). The 7 OIDC-disabled stub handlers
are mutually exclusive with the 8 live `/auth/*` routes, so a given instance
serves 59 − 7 = 52. WSJF 4.5 (#645) added 5 verb registrations (2 in
`routes/projects/wsjf.ts`, 3 in `routes/tasks/wsjf.ts`); Configurable Task
Models added 4 (1 in `routes/models/index.ts`, 2 in
`routes/settings/model-policy.ts`, 1 in `routes/projects/resolve-model.ts`).
(The POST `/api/v1/me/tokens` route is registered via `fastify.route` rather
than a verb method, so it is *not* part of the 59 verb count; the table lists
it for completeness.)

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
| `tools/topology-tools.ts` | `topology_check` | read | Wave 4.1 (#318): classify a project as FLAT/DAG/DAG_CYCLIC. |
| `tools/wait-for-unblock-tools.ts` | `wait_for_unblock` | read | Task #455: in-process long-poll until a task transitions blocked->open. |
| `tools/wsjf-tools.ts` | `wsjf_ranking`, `wsjf_history`, `rescore_project`, `wsjf_health` | read (×3) / write (rescore) | WSJF 1.10: propagation-adjusted ranking, score-history timeline, deterministic project rescore, degeneracy linter. |
| `tools/model-tools.ts` | `list_models`, `resolve_model`, `get_model_defaults`, `set_model_defaults` | read (×3) / write (set) | Configurable Task Models: runtime model catalog, per-role policy resolution, get/set of the DB-wide default policy. |

**Total: 31 tools** (9 task, 5 project, 3 dependency, 3 comment, 1 health, 1
topology, 1 wait, 4 WSJF, 4 model). 17 are read-only; 14 mutate state. Counted
by `grep registerTool` across the nine files above. The remote server registers
all **31 REST-backed tools** via `src/mcp/remote/register-tools.ts`; the topology
classifier reaches the same `TopologyService` over REST
(`GET /api/v1/projects/:id/topology`) rather than via a direct in-process
call, and the four WSJF tools proxy `GET /api/v1/projects/:id/wsjf-ranking`,
`GET /api/v1/tasks/:id/score-history`, `GET /api/v1/projects/:id/wsjf-health`,
and `POST /api/v1/projects/:id/rescore` (WSJF 1.10), and the four model tools
proxy `GET /api/v1/models`, `GET /api/v1/projects/:id/resolve-model`, and
`GET|PUT /api/v1/settings/model-policy` (#926). `wait_for_unblock` is
hosted on **both** servers (#481) — the local variant resolves the
`blocked->open` transition off the in-process EventBus, while the remote
variant resolves it off the SSE event stream (`GET /api/v1/events`,
`RestClient.waitForUnblockViaSse`), so the remote tool additionally observes
cross-process / cross-session wake-ups.

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
| project | `project-set-models` | `commands/project-set-models.ts` | Configurable Task Models (Task 12): set a project's model policy from per-role/per-category flags; persists via `PUT /projects/:id`. |
| models | `models list` | `commands/models.ts` | Configurable Task Models (Task 12): list the runtime-discovered Claude model catalog (`GET /models`); marks a `(stale)` fallback. |
| settings | `settings-set-models` | `commands/settings-set-models.ts` | Configurable Task Models (Task 12): set the database-wide default model policy (`PUT /settings/model-policy`). |
| dependency | `dep-add` | `commands/dep-add.ts` | Declare a dependency. |
| dependency | `dep-list` | `commands/dep-list.ts` | List dependencies. |
| dependency | `dep-remove` | `commands/dep-remove.ts` | Remove a dependency. |
| comment | `comment-add` | `commands/comment-add.ts` | Add a comment. |
| comment | `comment-list` | `commands/comment-list.ts` | List comments. |
| comment | `comment-delete` | `commands/comment-delete.ts` | Delete a comment. |
| system | `health` | `commands/health.ts` | Service health probe. |
| system | `doctor` | `commands/doctor.ts` | Diagnostics: DB, disk, config. |
| system | `db-check` | `commands/db-check.ts` | SQLite `PRAGMA integrity_check`. |
| system | `db` | `commands/db.ts` | Nested parent for `db <subcommand>` (hosts `mint-token`, `migrate-identities`). |
| system | `db mint-token` | `commands/db-mint-token.ts` | Offline-mint a PAT against the SQLite DB; raw value printed once. Bootstraps headless agents. |
| system | `db migrate-identities` | `commands/db-migrate-identities.ts` | Backfill identity FK columns from legacy TEXT columns. Dry-run by default; `--commit` applies; idempotent. |
| system | `backup` | `commands/backup.ts` | SQLite backup. |
| system | `stats` | `commands/stats.ts` | Aggregate task/agent stats. |
| system | `completions` | `commands/completions.ts` | Generate shell completion scripts. |
| auth | `login` | `commands/login.ts` | Authenticate via OAuth device flow; writes credentials file. |
| auth | `logout` | `commands/logout.ts` | Revoke the active PAT (DELETE /me/tokens/active) and remove the local credentials file. |
| auth | `whoami` | `commands/whoami.ts` | Show the currently authenticated user (GET /me + GET /me/tokens). Honors `--json`. |
| advisory | `topology` | `commands/topology.ts` | Wave 4.1 (#318): classify a project as FLAT/DAG/DAG_CYCLIC and emit an execution advisory. |
| wsjf | `wsjf-history` | `commands/wsjf.ts` | WSJF 4.5 (#645): show a task's append-only WSJF score history (oldest-first). |
| wsjf | `wsjf-set` | `commands/wsjf.ts` | WSJF 4.5 (#645): set / lock a task's WSJF components via the manual gate. |
| wsjf | `charter-history` | `commands/wsjf.ts` | WSJF 4.5 (#645): show a project's value-charter history (oldest-first). |
| distribution | `mcp` | `commands/mcp.ts` | Frictionless distribution (#734): launch the MCP bridge — local stdio server by default, remote HTTP bridge when `WFT_API_URL`/`--remote` is set. |
| distribution | `serve` | `commands/serve.ts` | Frictionless distribution (#733): boot the API server on the OS app-data DB, migrate-on-start, cwd-independent. |
| distribution | `setup` | `commands/setup.ts` | Frictionless distribution (#737): merge the local MCP entry into `~/.claude.json` and copy skills into `~/.claude/commands/tasks/`; `--fix-npm-prefix` for no-sudo global installs. |
| distribution | `self-update` | `commands/self-update.ts` | Frictionless distribution (#739): `npm i -g wood-fired-tasks@latest` with no-sudo EACCES remediation. |
| distribution | `docs` | `commands/docs.ts` | Frictionless distribution (#749): browse bundled user guides — `docs list`/`show`/`path`/`open`, resolved via the asset resolver (package root, not cwd). |
| distribution | `service` | `commands/service.ts` | Frictionless distribution (#740/#741/#742): manage the background service — `install`/`uninstall`/`status`, admin-free by default (Linux systemctl --user, macOS launchd, Windows per-user logon task); `install --system` is the sole elevating path. |
| statusline | `statusline` | `commands/statusline.ts` | v2.0 status line (#597): reads Claude Code's status-line JSON from stdin, renders the linked-project open/done counts + the update-available hint from a TTL cache; degrades silently (exit 0) when unlinked/offline. |
| statusline | `link-project` | `commands/link-project.ts` | v2.0 status line (#595): links the current directory to a project by writing the repo-local `.wft/project` marker the statusline resolver reads. |

**Total: 45 commands wired into Commander** (counted by
`program.addCommand` calls in `src/cli/bin/tasks.ts`).

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
| `wsjf.service.ts` | `validateScoreSubmission`, `validateManualScore`, `computeWsjf`, `rankFrontier` | (none — score writes flow through `task.service.ts`; ranking/propagation is read-time only, never persisted) |
| `wsjf-rescore.service.ts` | deterministic project rescore against the current value charter; skips locked components; writes one `wsjf_score_history` row per changed task + the run record in one transaction | (none — `task.updated` is emitted per changed task via `task.service.ts`) |
| `wsjf-health.service.ts` | `analyzeWsjfHealth` (pure, non-blocking degeneracy/pitfall linter) | (none) |

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
| REST `/api/v1/**` | `Authorization: Bearer <pat>` (PAT hashed + looked up in `api_tokens`, `src/api/plugins/auth.ts`) | Yes |
| REST `/health` | none | No |
| REST `/health/detailed` | `Authorization: Bearer <pat>` | Yes |
| Local MCP (`src/mcp/server.ts`) | stdio, trusts parent process | No |
| Remote MCP (`src/mcp/remote/`) | `Authorization: Bearer <pat>` forwarded from `WFT_API_KEY` | Yes |
| CLI (`tasks`) | `Authorization: Bearer <pat>` from a cached PAT (`tasks login`) or `API_KEY` env / `--token` | Yes |
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
`src/schemas/`. The remote server exposes all **27 REST-backed tools** with
identical input validation; behavioural differences are limited to transport
(stdio vs HTTP) and the auth boundary. `topology_check` (#318) reaches the
same `TopologyService` over REST — the remote server proxies it to
`GET /api/v1/projects/:id/topology` (wired in commit 6f30bfc), so its
input/output schema is byte-identical to the stdio tool and callers can't tell
which transport they're on. `wait_for_unblock` (#455 local, #481 remote) is
the only tool whose transport differs by more than the proxy hop: the local
variant resolves the `blocked->open` transition off the in-process EventBus,
the remote variant off the SSE event stream (`GET /api/v1/events`); the input
schema and the three return envelopes are byte-identical either way.

**Parity rule:** any new MCP tool MUST land in both servers in the same PR.
The drift-detection test enforces the local count; the remote registration
count is asserted by the `register-tools` unit test's expected-tools list
(now 31, matching the 31-tool local total — 4 of which are the WSJF tools, 4
the model tools, and 1 is `wait_for_unblock`).

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
