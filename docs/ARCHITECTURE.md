# Architecture

Owner: Repository maintainers
Status: Authoritative one-pager. See [docs/AGENT_CONTEXT.md](AGENT_CONTEXT.md) for the contract.

## Mission

`wood-fired-tasks` exposes one dataset through three inbound surfaces (REST,
MCP, CLI) and one outbound notifier (Slack). **Source of truth: `src/services/`
+ `src/schemas/`** — every surface is a thin adapter that validates with a
shared Zod schema and delegates to a shared service. Shared behaviour belongs
in services/schemas, never in a surface. See [AGENTS.md](../AGENTS.md) for the
navigation hub.

## Layer diagram

```
   REST API (Fastify)     MCP server (stdio + remote HTTP)     CLI (`tasks`)
        |                          |                              |
        +------------+-------------+----------------+-------------+
                     v                              | (remote MCP and
            src/schemas/  <-- Zod, shared           |  CLI proxy over
                     v       by every surface       |  HTTP -> REST)
            src/services/  <======= SOURCE OF TRUTH<+
                     |   (Task, Project, Dependency, Comment,
                     |    Idempotency, ClaimRelease, WorkflowEngine, Slack,
                     |    Wsjf, WsjfRescore, WsjfHealth)
                     v
            src/repositories/  (better-sqlite3 prepared statements)
                     v
                  src/db/  (SQLite + umzug, WAL journal)

   eventBus (src/events/event-bus.ts, process-wide singleton)
        ^  emitted by services after every mutation
        +--> WorkflowEngine   (cascade parent + auto-unblock)
        +--> SSEManager       (GET /api/v1/events for REST clients)
        +--> SlackNotifier    (src/slack/notifier.ts, outbound Slack)
```

The CLI does NOT bind to services in-process — it is an HTTP client over the
REST API. Remote MCP (`src/mcp/remote/`) is the same pattern. Local MCP
(`src/mcp/index.ts`) binds in-process and calls services directly.

## Per-surface flow

- **REST** (`src/api/server.ts`, `src/api/routes/**`): request -> Fastify
  `preHandler` `authPlugin` (Bearer PAT) -> route handler (Zod via
  `fastify-type-provider-zod`) -> service -> repository -> SQLite. Response
  Zod-serialised, stamped with `X-Request-ID`; errors flow through
  `src/api/hooks/error-handler.ts`.
- **MCP local** (`src/mcp/index.ts` + `src/mcp/tools/*`): `StdioServerTransport`
  reads JSON-RPC from stdin -> tool handler validates with the same
  `src/schemas/` Zod schemas -> calls services directly. Stdout is JSON-RPC
  only; logs go to stderr.
- **MCP remote** (`src/mcp/remote/index.ts` + `register-tools.ts`): stdio
  transport on the client, but each tool calls `RestClient` which POSTs to
  the REST API with `Authorization: Bearer <pat>`. No DB access on the client. Required env:
  `WFT_API_URL`, `WFT_API_KEY` (the PAT) — both fail fast.
- **CLI** (`src/cli/bin/tasks.ts` -> `src/cli/commands/*`): Commander
  subcommands call `src/cli/api/client.ts`, an HTTP client against the REST
  API. Auth via a cached PAT (`tasks login`) or the `API_KEY` env / `--token`
  flag, sent as `Authorization: Bearer <pat>`. Global flags: `--json`, `--no-input`, `--force`.
- **Slack inbound** (`/tasks` slash command ->
  `src/slack/commands/tasks-command.ts`): bolt verifies the Slack signing
  secret, then dispatches subcommands (`list`, `show`, `create`, `update`,
  `claim`, `delete`, `subscribe`, `unsubscribe`, …) directly to the
  in-process services passed by `src/api/server.ts` at startup.
- **Slack outbound** (`src/slack/notifier.ts`): subscribes to event-bus task
  events, looks up subscribed channels in `slack_channel_subscriptions`,
  formats Block Kit via `src/slack/task-formatter.ts`, posts with retry
  (skips permanent errors `not_in_channel`, `channel_not_found`,
  `invalid_auth`, `token_revoked`).

## Mutation flows

### Task create / update / delete

1. Surface validates input with `CreateTaskSchema` / `UpdateTaskSchema`.
2. `TaskService.createTask` forces `status='open'`; checks project and parent
   exist (and parent is in the same project).
3. `TaskRepository` writes inside a SQLite transaction; FTS5 triggers keep
   `tasks_fts` in sync.
4. Service emits `task.created`, `task.updated`, or `task.deleted` on
   `eventBus`. `task.deleted` is emitted BEFORE the row is removed so
   subscribers can still read related rows.
5. If `status` changed, `TaskService.updateTask` also emits
   `task.status_changed` with `{ from, to, source }` in `metadata`. The
   `WorkflowEngine` may cascade further updates (see below).

### Project create / update / delete

1. `ProjectService` validates via `CreateProjectSchema`.
2. Writes through `ProjectRepository`. Tasks reference projects with
   `ON DELETE CASCADE`, so deleting a project removes its tasks.
3. Emits `project.created`, `project.updated`, `project.deleted`.

### WSJF scoring / ranking

WSJF (Weighted Shortest Job First) layers economic prioritization onto the
backlog so `/tasks:loop[-dag]` drain work by value-per-effort rather than the
flat `priority` enum (backward-compatible: unscored projects sort by `priority`
then age as before). The load-bearing decision is a strict **judgment/math
split** — the LLM classifies over closed enums + verbatim evidence spans; the
server recomputes every Fibonacci component deterministically, so no client
number is trusted and any stored score is replayable without the model.

1. **Charter** — `ProjectService` accepts an optional `value_charter`
   (`ValueCharterSchema`), the per-project reference frame for Business-Value
   scoring (set by the `/tasks:new-project` interview; skipping falls back to
   `priority`). Each write snapshots into `project_charter_history`.
2. **Scoring gate** — `validateScoreSubmission` (`src/services/wsjf.service.ts`)
   is the single chokepoint below every write path: Zod enum/shape → theme in
   charter → each evidence span is a verbatim substring → `jobSizeTier` within
   `jobSizeBand` → contradiction rules → batch invariants (every Cost-of-Delay
   column has a `1` anchor; per-column variance ≥ `VARIANCE_FLOOR`). It
   recomputes the four components and writes the `wsjf_*` columns all-or-none.
   `computeWsjf = (value + timeCriticality + riskOpportunity) / max(jobSize, 1)`;
   manual overrides use `validateManualScore` (enum + contradiction only).
3. **Ranking** — `rankFrontier` (read-time, never persisted) adds blocker
   propagation: a task's Cost of Delay is lifted by the γ-decayed CoD of its
   distinct transitive dependents (γ = 0.5, capped at 3×; diamond-safe via BFS
   over the transitive closure), then divided by job size for `effective_wsjf`.
   `DAG_CYCLIC` is rejected up front; unscored tasks slot in via
   `priorityFallbackScore` (urgent→9…low→1). `frontier` scope drops
   blocked/not-ready tasks; `all` ranks every task.
4. **Rescore** — `WsjfRescoreService` re-runs the gate against the current
   charter, **skips locked components**, and commits component updates, one `wsjf_score_history` row per changed task, and the `wsjf_rescore_run` record in one transaction (per-task failures return in `errors[]` without aborting the batch).
5. **History + linter** — every score write appends an immutable
   `wsjf_score_history` row (full classifications + features + evidence) in the
   same transaction. `WsjfHealthService` is a pure, non-blocking linter for six degeneracies (`degenerate-spread`, `cod-no-anchor`, `job-size-collapsed`, `stale-time-criticality`, `high-fallback-ratio`, `score-churn`).

Surface (full stdio↔remote MCP parity): 4 MCP tools (`wsjf_ranking`,
`wsjf_history`, `rescore_project`, `wsjf_health`), the WSJF REST routes under
`src/api/routes/{tasks,projects}/wsjf.ts`, and 3 CLI commands — full references
in [docs/MCP.md](MCP.md), [docs/API.md](API.md), [docs/CLI.md](CLI.md).

### Comment create / delete

1. `CommentService` validates with `CreateCommentSchema`; verifies the task
   exists.
2. `CommentRepository` writes. **No event is emitted** — comments are
   intentionally a non-eventful surface today.
3. Delete enforces task scope: when the route passes a `task_id`, mismatches
   surface as `NotFoundError` to avoid IDOR leakage.

### Dependency add / remove

1. `DependencyService.addDependency` validates input, verifies both task IDs
   exist, then loads all dependencies and runs `CycleDetector`.
2. Cycle attempt -> `BusinessError` (422). Self-dependency rejected by the
   schema-level `CHECK(task_id != blocks_task_id)` and the cycle detector.
3. Remove is by `(task_id, blocks_task_id)` pair; missing -> `NotFoundError`.
4. No events emitted by the dependency service; downstream auto-unblock is
   triggered by the `task.status_changed` cascade in `WorkflowEngine`.

### Claim acquire / release

- Acquire (`TaskService.claimTask`): validates task exists, status `open`, no
  assignee; `TaskRepository.claimTask` does an atomic CAS (`BEGIN IMMEDIATE` +
  version bump); emits `task.claimed`. REST `POST /:id/claim` honours
  `X-Idempotency-Key` (8-128 chars, `[A-Za-z0-9_-]`), cached 24 h.
- Renew (task #1003): a same-assignee claim of a held `in_progress` task
  refreshes `claimed_at` (restarting the TTL) and re-emits `task.claimed`;
  `getTask` adds `claim_ttl_minutes` + `claim_remaining_seconds` while active.
- Release (stale sweep): `ClaimReleaseService` ticks every 5 min; stale =
  `assignee NOT NULL AND status='in_progress'` with BOTH `claimed_at` and
  `updated_at` ≤ now-30min (**30-minute idle timeout**, reset by any update,
  comment, or renewal). Stale rows reset to `status='open', assignee=NULL,
  claimed_at=NULL, version+1`, emitting `task.updated` + `task.claim_released`
  (`previous_assignee`/`expired_claimed_at`/`released_at`, `source='workflow'`).

### Status transitions

Legal values (`src/types/task.ts`): `open`, `in_progress`, `done`, `closed`,
`blocked`, `backlogged`. Enforced both by the SQLite `CHECK` constraint and
by `VALID_STATUS_TRANSITIONS`:

```
open        -> in_progress, blocked, closed, backlogged
in_progress -> done, blocked, open
blocked     -> open, in_progress
done        -> closed, open
closed      -> open
backlogged  -> open
```

Any other transition raises `BusinessError` ("Invalid status transition…").
`WorkflowEngine` enforces a two-step cascade (open -> in_progress -> done)
when auto-completing parents.

### Completion timestamp

`tasks.completed_at` (migration 007) is set by the application layer when a
task transitions **into** `status='done'` and cleared when it transitions
**out**. `'closed'` is intentionally not treated as completion. Existing rows
were back-filled with `updated_at` as best-available approximation.

### Event emission

Event bus type: `src/events/event-bus.ts` (singleton). Emitted types:
`task.created/updated/deleted/status_changed/claimed/claim_released`,
`project.created/updated/deleted` (runtime list: `ALLOWED_EVENT_TYPES`
in `src/events/types.ts`). Emitted by
services after a successful repository write. Consumers:

- `WorkflowEngine` — listens to `task.status_changed` with
  `ignoreTransaction: true`; cascades parent auto-complete + dependency
  auto-unblock, max depth 5, wrapped in a SQLite transaction so failures
  roll back. `runInTransaction` buffers external subscriber emits so no
  phantom events leak on rollback.
- `SSEManager` — `GET /api/v1/events` for authenticated SSE clients; per-key
  (4), per-IP (8), and global (200) caps (env-tunable).
- `SlackNotifier` — task event types only; filters by
  `slack_channel_subscriptions(project_id, event_type)`.

### Idempotency

`IdempotencyService` (`src/services/idempotency.service.ts`) is backed by the
`idempotency_keys` table. Key TTL: **24 hours**. Used **only** for the claim
endpoint today (`POST /api/v1/tasks/:id/claim` with `X-Idempotency-Key`).
A cached response is replayed verbatim with HTTP 200. Inline cleanup fires
whenever the table exceeds 10 000 rows; an hourly interval in `server.ts`
provides the steady-state sweep.

## Database summary

WAL mode is enabled by `src/db/database.ts`:
`journal_mode=WAL`, `foreign_keys=ON`, `synchronous=NORMAL`,
`busy_timeout=5000`. In-memory test DBs skip WAL.

| Table | Columns (one-liner) | Purpose |
|---|---|---|
| `projects` | `id`, `name UNIQUE`, `description`, `value_charter` (JSON, migration 014), timestamps | Top-level grouping. `value_charter` is the per-project WSJF reference frame (nullable). |
| `tasks` | `id`, `title`, `description`, `status`, `priority`, `project_id`, `parent_task_id`, `assignee`, `created_by`, `due_date`, `estimated_minutes`, `version`, `claimed_at`, `completed_at`, `wsjf_value`/`wsjf_time_criticality`/`wsjf_risk_opportunity`/`wsjf_job_size` (INTEGER, CHECK ∈ Fibonacci `{1,2,3,5,8,13}`, migration 013), `wsjf_evidence`/`wsjf_locked`/`wsjf_source`/`wsjf_classifications`/`wsjf_features` (JSON), timestamps | Core entity. `version` is the CAS counter for atomic claim. WSJF columns are all-four-or-none (enforced at the DTO boundary), all nullable. |
| `task_tags` | `task_id`, `tag` (UNIQUE pair) | Side table; `GROUP_CONCAT`-joined on reads. |
| `tasks_fts` | FTS5 virtual table over `(title, description)` | Full-text search; kept in sync by triggers. |
| `task_comments` | `id`, `task_id`, `author`, `content`, timestamps | Comments; cascade-delete with task. |
| `task_dependencies` | `id`, `task_id`, `blocks_task_id`, `CHECK(!=)`, UNIQUE pair | Directed `task_id -> blocks_task_id` edge. |
| `idempotency_keys` | `key PK`, `response` (JSON), `created_at` | 24 h replay cache. |
| `slack_channel_subscriptions` | `channel_id`, `project_id`, `event_type`, UNIQUE triple | Outbound notification subscribers. |
| `wsjf_rescore_run` | `id PK`, `project_id` (FK CASCADE), `triggered_at`, `charter_version`, `actor_type`, `actor_id`, `tasks_evaluated`, `tasks_changed`, `tasks_skipped_locked`, `summary` | Append-only; one row per rescore event (migration 015). |
| `wsjf_score_history` | `id PK`, `task_id`/`project_id` (FK CASCADE), `changed_at`, `trigger`, `actor_type`, `actor_id`, `charter_version`, `rescore_run_id` (soft FK SET NULL), the four components, `classifications`, `features`, `evidence`, `source`, `locked`, `wsjf_score`, `prev_wsjf_score` | Append-only; one immutable row per score write (full inputs, replay-able). Migration 015. |
| `project_charter_history` | `id PK`, `project_id` (FK CASCADE), `interview_version`, `charter` (JSON), `change_kind`, `actor_type`, `actor_id`, `changed_at` | Append-only; full charter snapshot per interview version (migration 015). |
| `_migrations` | `name`, `executed_at` | Umzug bookkeeping (canonical names, no extension). |

## Migration rules

- Files live in `src/db/migrations/NNN-<slug>.ts` (monotonic prefix).
- Run via `npm run migrate` (umzug; see `src/db/migrate.ts`).
- Names stored extensionless in `_migrations`, so `.ts` (dev) and `.js`
  (dist) of the same migration are treated as one. `runMigrations` wraps
  discovery + apply in `BEGIN EXCLUSIVE` so concurrent starters serialise.
- Every migration MUST export both `up(db)` and `down(db)`; rollback is
  exercised by `src/db/__tests__/migrations-roundtrip.test.ts` plus
  per-migration tests for 004-007.
- SQLite gotchas: `DROP COLUMN` needs referencing indexes dropped first;
  changing a `CHECK` constraint needs the `tasks_new` + copy + rename +
  recreate-indexes + recreate-FTS-triggers pattern (migration 005).
- Current max is **017** (17 migrations, `001`–`017`). The three WSJF
  migrations are `013-wsjf-fields` (the `wsjf_*` columns on `tasks`),
  `014-value-charter` (`projects.value_charter`), and `015-wsjf-audit` (the
  three append-only tables, created FK-dependency-first with
  `wsjf_rescore_run` before `wsjf_score_history`).

## Pagination + filtering contract

Public envelope: `{ data: T[], total: number, limit: number, offset: number }`
(`paginatedSchema` in `src/schemas/task.schema.ts`). `total` is the unbounded
match count for the same filter set.

- Query/body fields: `limit` (positive int, default **50**, max **500**),
  `offset` (non-negative int, default **0**). No cursor today.
- Filter fields on `GET /api/v1/tasks` (see `QueryTaskFiltersSchema`):
  `project_id`, `status`, `assignee`, `tags` (CSV in URL), `due_before`,
  `due_after`, `updated_before`, `updated_after`, `search` (FTS5, max
  200 chars / 32 terms).
- MCP `list_tasks` adds a `verbose` flag (default off -> compact projection
  via `toCompactTask`) to bound tool-result token cost.

## Error handling contract

Three layers translate up:

1. **Repository** (`src/repositories/errors.ts`) — only `FtsSyntaxError` is
   exported; raw SQLite messages are kept internal so parser details do not
   leak to clients.
2. **Service** (`src/services/errors.ts`) — `ValidationError`,
   `BusinessError`, `NotFoundError`. Services catch repository errors (e.g.
   `FtsSyntaxError`) and translate them into a `ValidationError` with a
   sanitised message.
3. **Surface mapping** (`src/api/hooks/error-handler.ts`):

   | Service error | HTTP | Error code |
   |---|---|---|
   | `ValidationError` | 400 | `VALIDATION_ERROR` (`details` = field errors) |
   | `NotFoundError` | 404 | `NOT_FOUND` |
   | `BusinessError` | 422 | `BUSINESS_RULE_VIOLATION` |
   | Fastify request error | as-is | `code` or `REQUEST_ERROR` |
   | Anything else | 500 | `INTERNAL_ERROR` (no stack leaked) |

   MCP wraps the same service errors via `convertToMcpError` so tool calls
   surface a structured failure. The CLI HTTP client (`src/cli/api/client.ts`)
   throws `ApiClientError` with the parsed payload and `process.exitCode = 1`
   on failure.

## Auth boundaries

- **REST**: Personal Access Token (PAT) per request via header
  `Authorization: Bearer <pat>`. Plugin `src/api/plugins/auth.ts` hashes the
  presented PAT (SHA-256) and looks it up in the `api_tokens` table, then
  resolves the bound user identity. `/health` is unauthenticated;
  `/health/detailed` is gated.
- **MCP local** (stdio): no auth — trusts the parent process that spawned
  it. The DB path comes from `DATABASE_PATH` (or legacy `DB_PATH`).
- **MCP remote**: passes `WFT_API_KEY` (a PAT) to the REST API via the
  `Authorization: Bearer <pat>` header. Fails fast if `WFT_API_URL` or
  `WFT_API_KEY` is missing.
- **CLI**: a cached PAT (`tasks login`) or the `API_KEY` env / `--token`
  flag, sent as `Authorization: Bearer <pat>`; `API_BASE_URL` defaults to
  `http://localhost:3000`.
- **Slack**: bolt verifies the Slack signing secret on every inbound slash
  command. Outbound uses the bot token; no project API key is involved.

## Source-of-truth rule

If a piece of behaviour must be identical across REST, MCP, and CLI, it lives
in `src/services/` and the matching schema in `src/schemas/`. Surfaces import
the same Zod schema (REST via `fastify-type-provider-zod`, MCP via
`registerTool`, CLI via the HTTP client's types) so a validation rule added
once is enforced everywhere. **Intentional divergences**:

- CLI prompts interactively (unless `--no-input`) and confirms destructive
  actions (unless `--force`); REST and MCP do neither.
- MCP `list_tasks` projects rows through `toCompactTask` to bound tool-call
  token cost; REST returns the full row.
- `SlackNotifier` only subscribes to task event types (no project events).
- `CommentService` does **not** emit events; SSE/Slack do not see comment
  activity.

## Deeper docs

| File | One-line purpose |
|---|---|
| [docs/API.md](API.md) | REST API reference. |
| [docs/MCP.md](MCP.md) | MCP tool reference. |
| [docs/CLI.md](CLI.md) | CLI reference. |
| [docs/SLACK.md](SLACK.md) | Slack surface reference. |
| [docs/SETUP.md](SETUP.md) | Local setup, env, install. |
| [docs/REPO_MAP.md](REPO_MAP.md) | Per-directory ownership. |
| [docs/AGENT_CONTEXT.md](AGENT_CONTEXT.md) | Authoritative agent-doc contract. |
