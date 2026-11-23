# Project "Archived" state — design

<!-- Point-in-time design spec. Not a maintained reference: once the feature
     ships, the live docs are docs/API.md, docs/MCP.md and docs/CLI.md. -->

| | |
| --- | --- |
| Tracker | WFT #2368 |
| Status | Proposal — design only, no runtime code changed |
| Written | 2026-11-23, against `main` at `e029aee` (v2.9.0) |
| Decision owner | Stuart |

## 1. Problem

A project today has `name`, `description`, `value_charter`, `model_policy` and
`scm` (`src/types/task.ts`, `Project`). When its work is finished there are two
options, both bad:

- **Rename it** (e.g. prefix "DONE"). It still shows in every `list_projects`
  call, every skill's project picker and the status line.
- **Delete it.** `tasks.project_id`, `slack_channel_subscriptions.project_id`,
  the three WSJF audit tables and `api_tokens.project_id` are all
  `REFERENCES projects(id) ON DELETE CASCADE`, so the whole task history goes
  with it.

The proposal adds a reversible **archived** state: the project and its tasks
stay readable by id, drop out of default listings, and stop accepting work.

## 2. Recommended behaviour

Each rule has one recommendation. The five that most need Stuart's call are
collected in [section 7](#7-decisions-for-stuart).

### 2.1 Representation

Three nullable columns on `projects`: `archived_at`, `archived_by`,
`archive_reason`. A project is archived exactly when `archived_at` is not
null. API responses add those three fields plus a derived boolean `archived`.

A timestamp is preferred over a `status` enum because nothing else in the
project lifecycle needs a state machine, and "when and by whom" is wanted
anyway. `archived_by` is taken from the authenticated caller, never from the
request body.

### 2.2 When may a project be archived?

| Rule | Recommendation |
| --- | --- |
| Tasks still `open`, `in_progress`, `blocked` or `backlogged` | Refuse with 422 and the count per status. |
| Override | `force: true` archives anyway, and then `reason` is required. Task statuses are not changed. |
| Already archived | Succeed as a no-op (200, no event), so agent retries are safe. |
| Reason | Optional free text, max 500 characters, required only with `force`. |

The refusal's 422 body carries the counts as data too:
`details: { code: 'project_has_unfinished_tasks', total, counts: { open, in_progress, blocked, backlogged } }`
(WFT #2530). `force` without `reason` is a validation error whose message
opens with `archive_reason_required`: 400 on REST, `InvalidParams` with the
same text on stdio and remote MCP.

### 2.3 What an archived project accepts

| Operation | Recommendation |
| --- | --- |
| Read by id (`get_project`, `get_task`, comments, dependencies, topology, WSJF ranking/history/health, dependency graph, completion report) | Works unchanged. |
| Create task or subtask | Rejected, 422 `project_archived`. |
| Update, claim or delete a task | Rejected, 422 `project_archived`. |
| Add or remove a dependency where either task is in an archived project | Rejected, 422 `project_archived`. Existing edges stay. |
| `rescore_project`, WSJF score writes | Rejected, 422 `project_archived`. |
| Add a comment | **Allowed.** A note such as "regression tracked in #N" on a finished task is useful and changes no state. |
| Update the project (`name`, `description`, charter, model policy, scm) | Rejected; unarchive first. |
| Delete the project | Allowed, `admin` scope as today. |
| Mint a project-bound token for it | Allowed (reads still work). |

The write freeze is the safety property. Because every mutation is refused at
the service layer, an agent that reaches an archived task through a stale id
or an old client cannot change it, whatever the listing defaults are.

### 2.4 Unarchive

Supported. It clears all three columns; the history stays in the audit trail
and the event stream. Project names stay unique while archived, so an archived
name cannot be reused without renaming after unarchive.

**Unarchive leaves the project in the state it would have had** (WFT #2522).
While a project is archived the workflow cascade skips its tasks, so after a
forced archive a task can stay `blocked` although every blocker has finished,
and a parent can stay open although every child is done. After an unarchive
has committed, the unarchive call itself (`ProjectService.unarchiveProject`)
has the workflow engine re-evaluate that project once. It is a direct call,
not a subscriber to `project.unarchived`, so that the outcome can be returned
to the caller (WFT #2542):

- each `blocked` task that has at least one blocker, all of them `done`,
  becomes `open`;
- each `open` or `in_progress` parent that has at least one child, all of them
  `done`, is auto-completed, and the normal cascade carries on from it (its
  own parent, the tasks it blocks).

These writes carry `source: 'workflow'` and emit the usual `task.updated` and
`task.status_changed` events. A task blocked by hand (no dependency edge), a
task with an unfinished blocker, and a `blocked`, `backlogged` or `closed`
parent are left alone. A task set to `blocked` by hand on top of blockers
that were already all `done` is opened too: the pass cannot tell it from a
task the archive held back (WFT #2532). The pass is idempotent, and does
nothing to a project that is archived.

Each candidate task is re-evaluated in its own transaction (WFT #2532). If its
write fails, only that task's cascade rolls back and is logged with the task
and project ids; the other tasks still change, and the project stays
unarchived. A repeated unarchive of a project that is not archived emits no
event but runs the pass again, which is the retry path for a task that
failed. The pass runs wherever the unarchive runs: REST, the remote bridge
(through REST), the stdio MCP server and Slack all reach the same
`ProjectService`, which `createApp` binds to the workflow engine.

**A partial failure is visible to the caller** (WFT #2542). The unarchive
still succeeds (200), and its result names the tasks whose re-evaluation
rolled back, in one shape on every surface: the project's fields plus
`reevaluation_failed_task_ids: number[]`, empty on a clean pass.

| Surface | Where the ids appear |
| --- | --- |
| REST `POST /projects/:id/unarchive` | `reevaluation_failed_task_ids` in the 200 body |
| stdio and remote `unarchive_project` | the same field in `structuredContent`, and a warning line in the text |
| CLI `tasks project-unarchive` | a warning on stderr (exit status stays 0); with `--json`, the field inside `project` |
| Slack `/tasks project-unarchive` | a warning block |

The warning names the tasks and says to unarchive again to retry them. A
response from a server older than #2542 has no field; clients treat it as
absent, not as "nothing failed".

### 2.5 Default visibility

One parameter, `archived`, with values `exclude` (default), `include`, `only`,
on every listing surface.

| Surface | Default | With the parameter |
| --- | --- | --- |
| `GET /projects`, `list_projects`, `tasks project-list`, Slack `project-list` | Archived projects omitted; `total` counts the filtered set. | `include` or `only`. |
| `GET /tasks`, `list_tasks`, `tasks list`, search — **no** `project_id` | Tasks of archived projects omitted. | `include` or `only`. |
| Same — **with** `project_id` of an archived project | Tasks returned. Asking for a project by id always works. | n/a |
| `completion_report` | Archived projects' tasks included. It is a historical report. | n/a |
| `/health/detailed` | `projects` stays the total (it is used as an upgrade fingerprint); a new `archived_projects` count is added. | n/a |

CLI spelling: `--include-archived` and `--archived-only`.

### 2.6 Who may archive

`write` scope for both archive and unarchive, on REST and MCP. Archiving
destroys nothing and is reversible, which matches `update_project` (`write`),
not `delete_project` (`admin`). A token bound to one project may archive that
project only; the existing project-binding table enforces this once the new
routes are classified in it.

Slack has no token scopes, so archive and unarchive from Slack require the
Slack user to map to a tracker user (the `findBySlackUserId` mapping other
Slack writes use). An unmapped user is refused with a clear message and
nothing is written; there is no fall-back to the slack-bot account or the raw
Slack id. `archived_by` is the mapped user's display name (WFT #2531).

### 2.7 Events and audit

- Two new event types, `project.archived` and `project.unarchived`, carrying
  the full project. They are sent over SSE and are valid `on:` values for
  `wft-router` rules. `project.updated` is **not** also emitted.
- Audit trail: the REST hook (`src/api/hooks/audit-trail.ts`) records every
  non-GET request automatically. Its resource is derived from the route
  pattern, which would record `archive` with no id; `archive` and `unarchive`
  are therefore listed as instance actions, so the row is `projects` plus the
  project id, as on MCP (WFT #2530). The MCP producer
  (`src/mcp/audit-trail.ts`) needs one table entry per new tool.

## 3. Surfaces that must change

Ordered roughly bottom-up. "Guard" names a test that already fails if the
surface is skipped.

### 3.1 Schema and migration

| File | Change |
| --- | --- |
| `src/db/migrations/021-project-archive.ts` (new) | `ALTER TABLE projects ADD COLUMN archived_at TEXT`, `archived_by TEXT`, `archive_reason TEXT`, inside `db.transaction`. `down` drops the three columns (same pattern as `017-scm-charter.ts`). |
| `src/db/__tests__/migration-021.test.ts` (new) | Seeds a pre-021 project, applies, asserts the columns are null and the row is intact; asserts `down` restores the prior column set. |
| `src/db/__tests__/__snapshots__/` | Regenerate the round-trip snapshot. Guard: `migrations-roundtrip.test.ts`. |

### 3.2 Types and Zod schemas

| File | Change |
| --- | --- |
| `src/types/task.ts` | `Project` gains `archived`, `archived_at`, `archived_by`, `archive_reason`. |
| `src/schemas/project.schema.ts` | New `ArchiveProjectSchema` (`reason?`, `force?`, refine: `force` needs `reason`) and `ArchivedFilterSchema` (`exclude` / `include` / `only`). |
| `src/schemas/task.schema.ts` | `TaskFiltersSchema` and `ListTasksMcpSchema` gain `archived`. This file also re-exports the project schemas. |
| `src/api/routes/projects/schemas.ts` | `ProjectResponseSchema` gains the four fields, all `.optional()`. It is a non-strict `z.object`, so a field missing from it is silently stripped from every response; this must land with the type change. |

### 3.3 Repositories and services

| File | Change |
| --- | --- |
| `src/repositories/project.repository.ts`, `interfaces.ts` | Map the new columns; `archive(id, by, reason)`, `unarchive(id)`; `findAll` and `count` take the filter. |
| `src/repositories/task.repository.ts` | `findByFilters` and `countByFilters` apply the filter (both already `INNER JOIN projects p`); a per-status count of non-terminal tasks for one project. |
| `src/services/project.service.ts` | `archiveProject`, `unarchiveProject`; reject `updateProject` on an archived project; pass the filter through `listProjects*`. |
| `src/services/task.service.ts` | One `assertProjectWritable` guard called from create, update, delete, claim and subtask creation. |
| `src/services/dependency.service.ts` | Same guard on add and remove. |
| `src/services/wsjf-rescore.service.ts`, `wsjf.service.ts` | Same guard on score writes. |
| `src/services/wsjf-health.service.ts` | New finding: an active task blocked by a non-terminal task in an archived project (possible after a forced archive). |
| `src/services/errors.ts` | The 422 is a `BusinessError` whose message starts with `project_archived`. |
| `src/services/claim-release.service.ts` | No change: releasing a stale claim on a force-archived task is still correct. Covered by a test. |

### 3.4 REST

| File | Change |
| --- | --- |
| `src/api/routes/projects/index.ts` | `POST /api/v1/projects/:id/archive` (body `{reason?, force?}`) and `POST /api/v1/projects/:id/unarchive`, both `requiredScope: 'write'`, both returning the project. `GET /` takes `archived`. |
| `src/api/routes/tasks/index.ts` | `QueryTaskFiltersSchema` takes `archived`. |
| `src/api/plugins/auth/project-binding.ts` | Classify the two new routes so project-bound tokens are checked against `:id`. |
| `src/api/routes/health.ts` | `archived_projects` in `/health/detailed`. |
| `src/api/server.ts` | Subscribe the SSE manager to the two new events. |
| `src/api/__tests__/__snapshots__/` | Regenerate the OpenAPI snapshot. Guards: `openapi-snapshot.test.ts`, `route-scope-coverage.test.ts`, `pat-project-binding.test.ts`. |

A dedicated pair of routes is preferred over `PUT /projects/:id {archived:true}`:
the state change gets its own audit action, its own scope setting and its own
precondition, and cannot be mixed into a field edit.

### 3.5 MCP — stdio **and** remote

`docs/retrospectives/2026-06-01-wsjf-remote-parity-planning-gap.md` records a
feature whose tools were registered only on stdio; production uses the remote
bridge, so nothing worked. Every row here is therefore a pair.

| stdio | Remote bridge | Change |
| --- | --- | --- |
| `src/mcp/tools/project-tools.ts` | `src/mcp/remote/register-tools.ts` + `rest-client.ts` | New tools `archive_project` and `unarchive_project`. |
| same | same | `list_projects` takes `archived`; `get_project` text summary shows the archived line. |
| `src/mcp/tools/task-tools.ts` | same | `list_tasks` takes `archived`. |
| `src/mcp/scope-gate.ts` | (shared) | Both new tools → `write` in `MUTATING_TOOL_SCOPES`. |
| `src/mcp/audit-trail.ts` | (shared) | Both new tools → `{resourceType: 'projects', resourceIdArg: 'id'}`. |
| `src/mcp/resources/events.ts` | (shared) | Document the two event types. |

Guards: `src/mcp/__tests__/stdio-remote-parity.test.ts` (a stdio tool with no
remote twin fails), `tool-count-drift.test.ts` (project tools go 5 → 7),
`scope-gate.test.ts`, `audit-trail.test.ts`, `events-resource.test.ts`.

### 3.6 CLI

| File | Change |
| --- | --- |
| `src/cli/api/client.ts` | `archiveProject`, `unarchiveProject`; listing helpers take `archived`. |
| `src/cli/commands/project-archive.ts`, `project-unarchive.ts` (new) | `tasks project-archive <id> [--reason <text>] [--with-unfinished]`, `tasks project-unarchive <id>`. Registered in `src/cli/bin/tasks.ts`. `--with-unfinished` sends `force: true` and requires `--reason` (refused before any request without one). |
| `src/cli/commands/project-list.ts`, `list.ts` | `--include-archived`, `--archived-only`. |
| `src/cli/commands/project-show.ts`, `src/cli/output/formatters.ts` | Show archived date, actor and reason. |
| `src/cli/commands/completions.ts` | New commands and flags. |
| `src/cli/statusline/resolve-project.ts`, `format-segment.ts` | Name auto-match ignores archived projects; an explicitly linked archived project renders with an `archived` marker. |

Guards: `cli-surface-coverage-link` runs `--help` for every registered
command; `tests/smoke/cli-e2e.sh` gets an archive round trip.

Flag name (changed from this design's first draft, WFT #2477 / PR #171):
the draft spelled the override `--force`, but the program already has a
global `--force` ("skip confirmation prompts"), and commander gives that flag
to the program wherever it appears on the line. Reading both spellings, the
first implementation, made the global flag plus a `--reason` force-archive a
project with unfinished tasks (a reason is legitimate on an ordinary archive,
so it does not show intent), and made the global flag alone turn a clean
archive of a finished project into a 400 `archive_reason_required`. The
override is therefore `--with-unfinished`; the global `--force` only skips
prompts and never forces an archive.

The direct-SQLite commands (`topology`, `stats`, `completed`, `wsjf`) do not
go through REST. They need no change for this feature, but see WFT #2370:
they read whichever database `resolveDbPath()` picks, which on a remote setup
is not the server's.

### 3.7 Skills (`skills/tasks/`, built to `dist/skills/` and the Codex set)

| File | Change |
| --- | --- |
| `loop.md`, `loop-dag.md`, `loop-shared.md`, `decompose.md` | After resolving the project, stop with a clear message if it is archived. |
| `create-task.md`, `log-bug.md`, `new-project.md`, `search.md` | Project pickers rely on the default (archived hidden); say so, and say how to include them. |
| `project-status.md` | Show archived state; offer to archive when every task is `done` or `closed`. |
| `my-work.md`, `pick-up.md`, `blocked.md` | No call change: a cross-project listing drops archived tasks by default. One line of text where they list. |
| `_enums.md` | The `archived` filter values. |

Guards: `src/api/routes/tasks/__tests__/skill-enums.test.ts`;
`npm run build:skills` rebuilds both skill sets.

### 3.8 wft-router (`packages/wft-router/`)

| File | Change |
| --- | --- |
| `src/config/event-types.ts` | Add the two event types. Guard: `src/events/__tests__/wft-router-event-types-sync.test.ts`. |
| `src/dispatch/startup-sweep.ts` | A rule with a numeric `project:` queries `GET /tasks?project_id=N`, which by rule 2.5 still returns an archived project's tasks. The sweep must fetch the project once and skip it when archived. Rule for a failed lookup (WFT #2544): only a definite answer (2xx, `archived: true`) skips the rule. A 404, a 403, any other non-2xx, a transport error or an unparseable body logs `wft_router_sweep_project_lookup_failed` with the project id and the rule runs as before. Lookups, failed ones included, are cached per project per sweep: one cold-start sweep shares one cache across its rules, and each periodic tick starts a new one. A project-bound token can read its own project at the `read` tier and gets 403 for any other (pinned in `src/api/__tests__/pat-project-binding.test.ts`). |
| `src/dispatch/predicate.ts`, `src/config/triggers-schema.ts` | No new `where:` key. Task events carry no archived flag and a frozen project emits no task events. |
| `src/handlers/create-task-in-project.ts` | No code change: a 4xx is already non-retryable. Add a test for the 422. |
| `triggers.example.yaml`, `README.md` | An example rule on `project.archived`. |

### 3.9 Topology, WSJF, health, completion report

Read paths are unchanged (rule 2.3). Changes are the write guards and the new
health finding in 3.3, and `archived_projects` in 3.4. `completion_report`
keeps counting archived projects' tasks; a test pins that.

### 3.10 Slack (`src/slack/`)

| File | Change |
| --- | --- |
| `commands/tasks-command.ts` | `project-archive <id> [reason]`, `project-unarchive <id>`; `project-list` hides archived unless `--all`; help text. |
| `formatters/project-formatter.ts` | Archived field in `project-show`. |
| `notifier.ts` | No change. It forwards task events only; an archived project emits none. Channel subscriptions are kept so unarchive restores them. |

### 3.11 SSE and event types

`src/events/types.ts` (the union and the list), `src/events/event-bus.ts` (the
typed map and the listener count), `src/api/server.ts` (SSE subscription),
plus the router copy in 3.8.

### 3.12 Docs

`docs/API.md`, `docs/MCP.md`, `docs/CLI.md`, `docs/SLACK.md`,
`docs/INTERFACES.md` (route, tool and command counts — guard:
`scripts/agent-context/__tests__/interfaces-counts.test.ts`), `README.md`
(MCP tool total and "20 migrations" — guard: `tool-count-drift.test.ts`),
`docs/ARCHITECTURE.md`, `docs/event-router-design.md`, `docs/WORKFLOWS.md`,
`docs/RELEASE.md` (migration note), `CHANGELOG.md`, then
`npm run agent-context:gen`.

## 4. Compatibility, migration safety, version

**Existing clients and OSS users.** Nothing changes until somebody archives a
project: no existing row is archived, and every default equals today's
behaviour for unarchived projects.

| Pairing | Result |
| --- | --- |
| Old CLI or old remote MCP → new server | Works. The response schema is non-strict, so the new fields are dropped on parse. Archived projects are hidden from the old client's lists, and it has no flag to show them. Writes into an archived project fail with a readable 422. |
| New CLI or new remote MCP → old server | Listing works; the new response fields are optional, so their absence reads as "not archived". `archive_project` gets a 404 from the missing route. An unknown `archived` query parameter is ignored by the old server. |
| SSE consumers | Two new event names. A consumer that rejects unknown event types would break; the bundled `wft-router` ships in the same package, so it moves in step. |

**Migration on a live database.** Three `ADD COLUMN` statements with no
default and no `NOT NULL`. SQLite implements that as a schema-table edit: no
table rewrite, no backfill, time independent of row count. The runner holds
`BEGIN EXCLUSIVE` (`src/db/migrate.ts`), and `deploy/upgrade.sh` stops the
service and copies the database first. `down` uses `DROP COLUMN`, which does
rewrite the table; with tens of projects that is immediate. It is neither
forward-only nor backup-sensitive under the definitions in `docs/RELEASE.md`.

**Version.** Additive API, new tools, new commands, one additive migration:
a **minor** release, `2.10.0`.

## 5. Test plan

| Layer | What is tested |
| --- | --- |
| Migration | `migration-021.test.ts` up and down on seeded data; round-trip snapshot. |
| Repository | Column mapping; archive and unarchive; each filter value for `findAll`, `count`, `findByFilters`, `countByFilters`. |
| Service | Precondition per non-terminal status; `force` needs `reason`; idempotent archive; events emitted once; every guarded mutation rejects with `project_archived`; comments still allowed; update rejected; delete allowed. |
| REST | Both routes: 200, 404, 422, scope 403 with a `read` token, project-bound token on another project; `archived` on both list routes; `archived_by` is the caller. |
| MCP stdio | Both tools; scope gate; audit row; `archived` on `list_projects` and `list_tasks`. |
| MCP remote | Same, through `register-tools.ts` against an in-process server; parity test stays green with an empty allowlist. |
| End to end through the remote bridge | Archive → `list_projects` omits it → `create_task` rejected → unarchive → `create_task` succeeds. This is the reachability gate the retrospective asked for. |
| CLI | Unit tests per command; `cli-e2e.sh` round trip. |
| Router | Event-type sync; sweep skips an archived project; handler treats 422 as permanent. |
| Slack | Command handlers and formatter. |
| Drift guards | Tool count, interface counts, skill enums, agent-context. |
| Whole suite | `npm run quality` green. |

## 6. Work breakdown

24 leaf tasks, none over 90 minutes, 1,560 minutes (26 hours) in total. Every
acceptance criterion is a command that exits 0 or a grep with a stated result.
`vitest` means `npx vitest run`.

| ID | Task | Min | Depends on | Acceptance criteria |
| --- | --- | --- | --- | --- |
| A01 | Migration 021 and its test | 60 | — | `vitest src/db/__tests__/migration-021.test.ts src/db/__tests__/migrations-roundtrip.test.ts` exits 0; `ls src/db/migrations \| wc -l` prints 21. |
| A02 | Types and Zod schemas (3.2) | 45 | — | `npx tsc --noEmit` exits 0; `vitest src/schemas` exits 0; `grep -c archived_at src/api/routes/projects/schemas.ts` ≥ 1. |
| A03 | Event types on bus, SSE, router copy, MCP events resource | 60 | — | `vitest src/events src/mcp/__tests__/events-resource.test.ts` exits 0; `grep -c "project.archived" packages/wft-router/src/config/event-types.ts` = 1. |
| A04 | Project repository: columns, archive, unarchive, list filter | 75 | A01, A02 | `vitest src/repositories/__tests__/project.repository.test.ts` exits 0 and includes cases named `archive`, `unarchive`, `archived=only`. |
| A05 | Task repository: `archived` filter and non-terminal count | 75 | A01, A02 | `vitest src/repositories/__tests__/task.repository.test.ts` exits 0 and includes a case asserting an archived project's task is absent without `project_id` and present with it. |
| A06 | Project service: archive, unarchive, update guard, events | 90 | A03, A04, A05 | `vitest src/services/__tests__/project.service.test.ts` exits 0 with cases for each non-terminal status, `force` without `reason`, idempotent archive, one event per transition. |
| A07 | Write guard in task service | 75 | A04 | `vitest src/services/__tests__/task.service.test.ts src/services/__tests__/task-claim.test.ts` exits 0; cases reject create, update, delete, claim and subtask with a message matching `/^project_archived/`. |
| A08 | Write guard in dependency and WSJF write services; comments stay allowed | 60 | A04 | `vitest src/services/__tests__/dependency.service.test.ts src/services/__tests__/comment.service.test.ts src/services/__tests__/wsjf-rescore.test.ts` exits 0 with one archived-project case each. |
| A09 | WSJF-health finding for blockers in archived projects | 60 | A04 | `vitest src/services/__tests__/wsjf.health.test.ts` exits 0 with a case producing the new finding code. |
| A10 | REST: archive and unarchive routes, list filter, project-binding entries | 90 | A06 | `vitest src/api/__tests__/projects.test.ts src/api/__tests__/pat-project-binding.test.ts src/api/__tests__/route-scope-coverage.test.ts src/api/__tests__/openapi-snapshot.test.ts` exits 0; cases cover 200, 404, 422, 403 for a `read` token, and a token bound to a different project. |
| A11 | REST: `archived` on `GET /tasks` | 30 | A05 | `vitest src/api/__tests__/tasks.test.ts src/api/__tests__/tasks-search.test.ts src/api/__tests__/openapi-snapshot.test.ts` exits 0 with a case per filter value. |
| A12 | `/health/detailed` reports `archived_projects` | 30 | A01 | `vitest src/api/__tests__/health-detailed.test.ts` exits 0 with a case asserting `archived_projects`. |
| A13 | stdio MCP: two tools, `list_projects` filter, scope gate, audit table | 75 | A06 | `vitest src/mcp/__tests__/project-tools.test.ts src/mcp/__tests__/scope-gate.test.ts src/mcp/__tests__/audit-trail.test.ts` exits 0; `grep -c "registerTool" src/mcp/tools/project-tools.ts` = 7. |
| A14 | stdio MCP: `archived` on `list_tasks` | 30 | A05 | `vitest src/mcp/__tests__/task-tools.test.ts` exits 0 with a case per filter value. |
| A15 | Remote MCP: client methods, two tools, both filters | 75 | A10, A11, A13, A14 | `vitest src/mcp/remote src/mcp/__tests__/stdio-remote-parity.test.ts` exits 0; the parity allowlist is still empty. |
| A16 | CLI: client functions and the two commands | 60 | A10 | `vitest src/cli` exits 0; after `npm run build`, `node dist/cli/bin/tasks.js project-archive --help` and `project-unarchive --help` exit 0. |
| A17 | CLI: list flags, formatters, completions | 60 | A10, A11 | `vitest src/cli` exits 0; `node dist/cli/bin/tasks.js project-list --help \| grep -c archived` ≥ 2. |
| A18 | Status line: archived marker, auto-match skips archived | 45 | A17 | `vitest src/cli/statusline src/cli/commands/statusline.test.ts` exits 0 with a case for the marker and a case for the skipped match. |
| A19 | Slack: two subcommands, list filter, formatter | 75 | A06 | `vitest src/slack` exits 0 with a case per new subcommand. |
| A20 | Router: sweep skips archived, 422 test, example rule | 60 | A03, A10 | `vitest packages/wft-router` exits 0; `npm run check:vendor-neutrality` exits 0; `grep -c "project.archived" packages/wft-router/triggers.example.yaml` ≥ 1. |
| A21 | Skills (3.7) | 75 | A13, A14 | `npm run build:skills` exits 0; `vitest src/api/routes/tasks/__tests__/skill-enums.test.ts` exits 0; `grep -l archived skills/tasks/*.md \| wc -l` ≥ 9. |
| A22 | End-to-end through the remote bridge, and `cli-e2e.sh` round trip | 75 | A15, A16 | The new remote e2e test file exits 0 under `vitest`; `bash tests/smoke/cli-e2e.sh` exits 0 and its log contains `project-archive`. |
| A23 | Docs and counts (3.12) | 90 | A15, A17, A19, A20, A21 | `vitest src/mcp/__tests__/tool-count-drift.test.ts scripts/agent-context` exits 0; `npm run agent-context:check` exits 0; `grep -c "project-archive" docs/CLI.md` ≥ 1. |
| A24 | Full gate and 2.10.0 release prep | 90 | A07, A08, A09, A12, A18, A22, A23 | `npm run quality` exits 0; `node -p "require('./package.json').version"` prints `2.10.0`; `grep -c "^## \[2.10.0\]" CHANGELOG.md` = 1. |

Dependency edges, blocker → blocked:

```
A01 -> A04, A05, A12
A02 -> A04, A05
A03 -> A06, A20
A04 -> A06, A07, A08, A09
A05 -> A06, A11, A14
A06 -> A10, A13, A19
A10 -> A15, A16, A17, A20
A11 -> A15, A17
A13 -> A15, A21
A14 -> A15, A21
A15 -> A22, A23
A16 -> A22
A17 -> A18, A23
A19 -> A23
A20 -> A23
A21 -> A23
A07, A08, A09, A12, A18, A22, A23 -> A24
```

The graph is acyclic with three roots (A01, A02, A03), so it classifies as
`DAG`. The longest chain is A01 → A04 → A06 → A10 → A15 → A23 → A24, 570
minutes.

## 7. Decisions for Stuart

1. **Strict or forced archive.** Recommended: refuse while any task is
   `open`, `in_progress`, `blocked` or `backlogged`, with `force` + `reason`
   as the override. The alternative is strict only, which makes you close or
   move every stale backlog item first.
2. **How frozen.** Recommended: no task, dependency or score writes, and no
   project edits, but comments stay allowed. The alternatives are fully
   read-only (simpler to explain) or allowing task updates (which defeats the
   point).
3. **Listing defaults.** Recommended: hidden everywhere by default, except
   that naming an archived project's id always returns its tasks. The
   alternative hides them there too, which is safer for agents but makes
   `list_tasks project_id=N` return nothing with no explanation.
4. **Scope.** Recommended: `write` for archive, unarchive and `force`. The
   alternative is `admin`, matching delete; then the producer bot needs an
   admin token to tidy up finished projects.
5. **Events.** Recommended: new `project.archived` and `project.unarchived`
   types. The alternative is to reuse `project.updated`, which avoids a new
   event name on the wire but stops router rules from triggering on archive.

Smaller points settled in the text unless you object: the three stored
columns (2.1), names staying unique while archived (2.4), `completion_report`
including archived work (2.5), and version `2.10.0` (section 4).

Settled during the build, where the text above was silent: `updated_at` bumps
on a real archive or unarchive and not on a no-op; `archived_at` is a JS ISO
timestamp (`2026-11-23T12:00:00.000Z`), so any SQL comparison against it must
wrap both sides in `datetime()`; the first archive wins (re-archiving keeps
the original time, actor and reason, and the repository reports that nothing
changed); `reason` is trimmed before it is validated and stored, and a
whitespace-only `reason` is invalid with or without `force`; and
`TaskRepository.count()` with no argument stays the raw total of every task,
archived projects included.

## 8. Out of scope

- Archiving individual tasks.
- Automatic archiving when the last task closes. `project-status` only
  offers it.
- Fixing WFT #2370. Reproduced during this work; root cause is in the
  pull-request description.
