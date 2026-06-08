# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Each release groups changes under `Added`, `Changed`, `Fixed`, and `Security`.
Security-relevant items (auth, secret handling, network exposure, dependency
vulnerabilities, supply-chain pinning) are always called out under `Security`.

## [Unreleased]

_No changes yet._

## [v2.0.0] - 2026-06-07

The **identity auth cutover** — a breaking major. The legacy `X-API-Key`
shared-secret auth path is **removed**; every API call now authenticates with a
per-user **Bearer personal access token (PAT)** minted through the identity
system. Onboarding gains an OIDC device flow and explicit setup modes, and the
CLI grows `statusline` and `link-project` commands. **No credential migration is
required** — pre-identity (`is_legacy=1`) rows are left **inert** and read back
unchanged — and the one schema migration that touches existing data
(migration 005) was hardened to preserve child rows (see _Fixed_).

### Changed
- **Auth is now Bearer-PAT only.** Every authenticated REST/MCP request carries
  `Authorization: Bearer <pat>`; the previously-supported `X-API-Key` shared-key
  header is no longer accepted. PATs are per-user, revocable, and optionally
  expiring (see [`docs/SETUP.md`](docs/SETUP.md)). This is the breaking change
  that makes v2.0 a major.
- **`setup` gains explicit Local/Service/Remote modes + an OIDC device flow.**
  Running `wood-fired-tasks setup` with no args on a TTY presents a
  Local/Service/Remote menu; `--local` / `--service` / `--remote <url>` pick a
  path non-interactively. `setup --remote <url>` probes the server's OIDC state
  and picks **device-flow** (OIDC ready) vs **manual-PAT** (OIDC
  disabled/degraded) automatically, replacing the old key-paste onboarding. The
  remote MCP entry is **URL-only** — the PAT is cached in the CLI credentials
  file, never written into `~/.claude.json` (#810).
- **`API_KEYS` is no longer an auth method.** It only seeds inert `is_legacy=1`
  identity rows; the dead production boot-gate that required it was removed.

### Added
- **OIDC device-flow onboarding** for `setup --remote`, minting a PAT without a
  hand-copied shared key when the server has OIDC enabled.
- **`statusline` CLI command** for a compact at-a-glance status line, and
  **`link-project`** to write a `.wft/project` marker that pins the working
  directory to a project (consumed by `statusline` and CLI project resolution).
- **`/tasks:update` slash command** (the packaged `/tasks:*` skill set is now 19).
- **Update-available notifier** with an opt-out: set `WFT_NO_UPDATE_CHECK=1`
  (env) or `update_check = false` (CLI config) to disable the best-effort
  "newer version available" check.

### Fixed
- **Unified DB-path resolution — fixes silent data loss on upgrade.** `serve`/the
  API defaulted `DATABASE_PATH` to the OS app-data dir while `migrate` and the
  `tasks db*` commands hardcoded `./data/tasks.db`; with `DATABASE_PATH` unset
  they could open **different** databases, silently abandoning an upgrading
  user's `./data/tasks.db`. A single `resolveDbPath()`
  ([`src/config/db-path.ts`](src/config/db-path.ts)) is now the source of truth:
  explicit `DATABASE_PATH` (or the `DB_PATH` alias) > adopt an existing legacy
  `./data/tasks.db` > app-data default.
- **Migration 005 no longer cascade-deletes data.** `PRAGMA foreign_keys = OFF`
  is a no-op inside a transaction, so 005's table rebuild CASCADE-deleted
  `task_comments` / `dependencies` / `tags` when run against a populated pre-005
  database. The migration now snapshots and restores child rows around the
  rebuild (covered by a populated-DB round-trip test).

### Security
- **Removed the `X-API-Key` shared-secret auth path entirely** (the v2.0
  cutover). A single long-lived shared key was the broadest part of the auth
  surface; replacing it with per-user, individually-revocable Bearer PATs scopes
  credentials to a user, makes revocation surgical, and bounds blast radius on
  leak. Legacy `is_legacy=1` rows are left inert — **no credential migration is
  required**.
- **Closed an upgrade-time data-loss path** (the migration-005 cascade delete;
  see _Fixed_) — a data-integrity fix for anyone upgrading across migration 005
  with populated tables.

## [v1.18.2] - 2026-06-06

A patch release: a Windows `self-update` fix plus two install-experience
follow-ups.

### Fixed
- **`wood-fired-tasks self-update` no longer crashes on Windows** (#793). It
  spawned `npm` (which is `npm.cmd`) without a shell; since the CVE-2024-27980
  hardening, Node refuses to spawn a `.cmd`/`.bat` directly and threw
  `spawn EINVAL` (errno -4071). The npm spawn now passes `shell: true` on
  Windows only (its args are constant — no quoting/injection hazard), with a
  win32 regression test. Workaround on 1.18.0/1.18.1: run
  `npm i -g wood-fired-tasks@latest` directly.

### Added
- **PATH remediation hint after global install** (#792). A child process can't
  change the parent shell's PATH, so a fresh `npm i -g` is sometimes not
  resolvable until a new shell. `setup` and the postinstall notice now detect
  this (npm global bin dir vs the process PATH — no `which`/`where` shell-out)
  and print a copy-pasteable fix per platform/shell: `hash -r` (bash, dir on
  PATH but stale cache), `export PATH=…` + persist (posix, dir off PATH), or the
  PowerShell `$env:Path` refresh (Windows). The postinstall path is
  try/catch-guarded so it can never fail an install.

### Changed
- **Documented the harmless npm deprecation warnings** (#789). `prebuild-install`
  (via `better-sqlite3`, latest still uses it) and `lodash.get`/`lodash.isequal`
  (via `umzug` → `@rushstack/ts-command-line` → `z-schema@5`) are upstream
  transitives — install succeeds and `npm audit` is clean. Recorded in
  `docs/SETUP.md` with the dependency chains; eliminating the lodash pair via a
  `z-schema@12` override is deferred (it must not risk the migration path).

## [v1.18.1] - 2026-06-06

A patch release fixing two regressions shipped in v1.18.0.

### Fixed
- **`tasks health` no longer crashes** (#790). The CLI's `formatHealthStatus`
  read `health.checks.database` unconditionally, but `checkHealth()` calls the
  basic `/health` endpoint, whose body omits `checks` (that field is only on the
  authenticated `/health/detailed`). `tasks health` exited with "Cannot read
  properties of undefined (reading 'database')" against any server — local or
  remote (`setup --remote`). The formatter now guards `health.checks?.database`,
  `HealthResponse.checks` is correctly typed optional, and the Database line
  renders only when detailed checks are present. Adds a regression test.
- **`deploy/upgrade.sh` ships `scripts/`** (#791). The v1.18 `postinstall` hook
  (`node scripts/postinstall.cjs`, #752) made `npm ci` in the deploy dir fail
  with `MODULE_NOT_FOUND` because the upgrade script copied only `package.json` +
  the lockfile, not `scripts/` — aborting the upgrade *after* the service was
  already stopped. The script now refreshes `scripts/` alongside the package
  files. (Remaining deploy hardening — pinning `DATABASE_PATH` so the checkout
  deploy doesn't inherit v1.18's OS-app-data DB default — tracked in #791.)

## [v1.18] - 2026-06-06

A **distribution + quality** release. The headline is frictionless single-command
npm distribution (#31); alongside it the codebase quality floor was raised with
evidence-backed, incremental compiler/lint/boundary gates (#32). No change to the
public MCP/REST/migration surface — still **27 MCP tools and 15 migrations** — the
new surface is the CLI (`wood-fired-tasks` / `wft` bins and their subcommands).

### Added
- **Frictionless npm distribution** (#31). `wood-fired-tasks` is now installable,
  configurable, updatable, and runnable from a single npm command with no `git
  clone` and no admin privileges, identically on Windows/Linux/macOS. Adds the
  `wood-fired-tasks` + `wft` bin aliases, ships the `/tasks:*` skills inside the
  tarball, defaults the database to the OS app-data dir, and migrates-on-start.
  New CLI subcommands:
  - `serve` (#733) — run the API with migrate-on-start + app-data DB default.
  - `mcp` (#734) — local stdio MCP server and remote bridge.
  - `setup` (#737) — merge `~/.claude.json` + copy skills, with `--fix-npm-prefix`;
    `--remote`/`--token` for a remote MCP entry + PAT cache (#738).
  - `update` (#739) — self-update with no-sudo EACCES remediation.
  - `service` (#740) — install/uninstall/status; Linux systemd `--user`, macOS
    launchd + Windows Scheduled-Task backends (#741), opt-in `--system`
    elevation variant (#742).
  - `docs` (#749) — list/show/path/open the shipped docs.
  Installer-parity hardening (#752): absolute MCP entry path, `0600` perms on the
  cached credential, a Node-version warning, and a postinstall notice.
- **API/CLI response validation** (#774). The CLI and remote MCP proxy now
  Zod-validate task/project/list REST responses against the same server schemas
  (single source of truth) instead of casting `response.json() as T`, turning a
  malformed/version-skewed body into a clear "bad response from server" error
  rather than a downstream `undefined`.
- **Advisory cognitive-complexity report** (#771) — `npm run quality:complexity`,
  continue-on-error in CI (calibration-first, gates only egregious outliers).
- **Benchmark / perf-regression policy** (#773) — `docs/BENCHMARK_POLICY.md`;
  fixed a vitest-bench worktree N+1 discovery bug.
- **Mutation-survivor tests** (#772) — killed the `cascadeDepth--` survivors;
  mutation-run policy documented.
- **Async-safety lint coverage audit + gate decision** (#785, F1) — documented
  audit of the #762 Biome floating/misused-promise gate; recorded the Biome-only
  decision and the fire-and-forget `void` convention
  (`docs/ASYNC_PROMISE_LINTING.md`).
- **Lint-posture calibration + decision** (#788, F5) — measured Biome
  `recommended:true` against the production tree (493 findings across 18 rules)
  and recorded the stay-minimal decision with rationale.

### Changed
- **Compiler strictness ratchets — all now ON, behaviour-preserving** (#32):
  `noPropertyAccessFromIndexSignature` (#763, 210 sites dot→bracket),
  `exactOptionalPropertyTypes` (#778→#779→#780, via an `omitUndefined` helper and
  a clean Fastify generic-variance fix), and `noUncheckedIndexedAccess`
  (#781→#784, 30 errors guarded with guard-and-bind / tuple / empty-state — no
  blanket `!`).
- **`client-package/` retired** (#743) — converted `install.sh`/`install.ps1` to
  deprecation shims; the skills it mirrored now ship in the npm tarball and via
  `tasks setup`.
- **Retired 4 pre-existing blanket non-null index assertions** (#786, F2) in
  `slack/` + `events/sse-manager`, bringing the no-blanket-`!` rule to 100% across
  the index-access surface. Runtime behaviour unchanged.

### Fixed
- **Windows ESM migration loading** — migrations are imported via a `file://` URL
  (`5f8e167`) and the migration glob resolves with POSIX separators (`d6f4150`),
  fixing `npm run serve`/migrate on Windows; the global-install smoke shell-spawns
  the installed `.cmd` bin on Windows (`7eab2ab`).
- **Vendor-neutrality exempt marker re-scoped** (#787, F3) — the
  `WFT-NEUTRALITY-EXEMPT-LINE` marker on the wft-router `cursor_gap` SSE log was
  tightened to the exact violating line.

### Security
- **Cached credential file hardened to `0600`** (#752) as part of installer-parity
  hardening, so a PAT cached by `tasks setup --remote` is not world-readable.

## [v1.17] - 2026-06-04

A **reliability + process-hardening** release in two halves, with no change to
the public API/MCP/CLI/migration surface (still 27 MCP tools and 15 migrations).

**1. New-user first-run reliability.** A new-user first-run audit + remediation
pass: every gap that could break a fresh-clone or fresh-install experience was
fixed, the Quick Start was made to work verbatim from a clean checkout, and
guards were added so the documented first-run path can't silently drift again.

**2. Loop / decompose process-hardening.** The `/tasks:loop`, `/tasks:loop-dag`,
and `/tasks:decompose` skills gained structural guards — derived from the
[2026-06-01 WSJF remote-MCP-parity retrospective](docs/retrospectives/2026-06-01-wsjf-remote-parity-planning-gap.md)
— that stop the "every task PASSed but the feature is unreachable in production"
failure class: planning now carries a surface-coverage matrix, decompose
auto-emits remote-parity coverage tasks, and the loops refuse to declare a clean
"drained → done" until an end-to-end reachability + parity audit is green.

### Fixed
- **`DATABASE_PATH` now honored when starting the API server** (#703). Starting
  the server (`npm start`) previously ignored `DATABASE_PATH` and opened the
  default DB, so a new user who set it saw their data land in the wrong file.
  The start path now resolves `DATABASE_PATH` consistently with the rest of the
  toolchain.
- **`npm run migrate` honors `DATABASE_PATH`** (#704), defaulting to
  `./data/tasks.db` when unset — so migrations and the running server now agree
  on which database file is in use. (#705) adds end-to-end regression coverage
  asserting the config path is honored across migrate + server start.
- **Expected-error test log noise downgraded** (#709). Routes that deliberately
  exercise client-error (4xx) paths in tests no longer emit error-level logs for
  those expected outcomes; genuine 5xx server errors still log at error level.
- **PAT `touchLastUsed` guarded against a shutdown race** (#710). Last-used
  bookkeeping on personal access tokens no longer attempts to write to an
  already-closed database during server shutdown, removing a spurious error on
  exit.
- **Decompose WSJF schema-drift dogfood finding** (#712). The live `create_task`
  MCP tool input (`CreateTaskClientSchema.extend({ wsjf_submission, wsjf_trigger })`)
  exposes *two* WSJF paths — the classified, gate-enforced `wsjf_submission` +
  `wsjf_trigger` envelope, and a raw pre-computed `wsjf` object (`WsjfWriteSchema`,
  the manual-override path). `skills/tasks/decompose.md` documented only the
  former, so an agent inspecting the raw schema could mistake the bare `wsjf`
  object for the decompose contract and bypass the column-anchored batch gate.
  Clarified the skill with an explicit "use `wsjf_submission`, NOT the raw `wsjf`
  object" callout disambiguating the two paths. Runtime behavior unchanged — the
  tool schema and scoring flow were already correct; only the skill text drifted.
  Added a `create_task` opt-out test asserting that omitting `wsjf_submission`
  materializes an unscored task (no history row, null components).
- **`docs/CLI.md` `--json` output paths corrected** (#716). The documented JSON
  paths for `--json` command output had drifted (e.g. `.data.id`); the examples
  now match the actual emitted shape.

### Added
- **Decompose surface-coverage matrix + invariant-rider** (#649). New
  `docs/superpowers/PLAN-TEMPLATE.md` plan/spec template carries a
  **surface-coverage matrix** — every capability is mapped across the 8 canonical
  deployment surfaces (`stdio MCP, remote MCP, REST, CLI, skills, client-package
  mirror, docs/tool-count, migration/backfill`), and every non-N/A cell must
  yield a task. `/tasks:decompose` gained a Step 8c **invariant-rider** pass that
  detects which surfaces a change touches and auto-emits the paired coverage
  tasks / AC riders (e.g. a new stdio MCP tool auto-emits a remote-proxy parity
  task) so a surface missing from the plan can't silently drop through
  decomposition. Documented in `docs/tasks-decompose-design.md`; gated by content
  tests.
- **Loop terminal completeness gate** (#650). `/tasks:loop` and `/tasks:loop-dag`
  no longer treat "0 open tasks" as sufficient to declare a backlog drained.
  Before exit they run a terminal **invariant + reachability audit** (loop-shared
  `§O`): the structural `stdio ⊆ remote` MCP parity test plus a reachability
  smoke that exercises newly-added MCP tools through the **real remote proxy
  path** (`dist/mcp/remote`), not in-process. On a detected gap the loop
  materializes a remediation task (an explicit, documented carve-out to the
  "don't create tasks during the loop" rule) and surfaces it in a new
  `## Coverage Gaps` LOOP-RUN.md section instead of declaring success.
- **Fresh-clone smoke recipe** (#708). `npm run smoke` boots a temporary server
  against an isolated `DATABASE_PATH`, runs the documented Quick Start flow
  (migrate → build → start → create project → create task → list) end-to-end,
  and tears the temp DB down — a one-command check that the new-user path works.
- **README Quick Start drift guard** (#713). A vitest spec
  (`src/__tests__/readme-quickstart-drift.test.ts`, runs in `npm test`) asserts
  the README Quick Start keeps using the in-tree `npm run cli --` invocation and
  never reintroduces a broken first-run pattern (e.g. a bare global `tasks`
  command or an assumed project id 1).
- **Codex CLI user-level MCP setup docs** (#711). `docs/MCP.md` now documents
  registering the server with `codex mcp add … -- ~/.local/bin/wft-mcp`,
  including that Codex stores the entry user-level and the launcher resolves the
  API key at spawn time.

### Changed
- **README Quick Start rewritten to work from a fresh clone** (#706). The Quick
  Start now runs entirely via `npm run cli -- <args>` with no `npm link` / no
  global `tasks` binary required, sets `DATABASE_PATH`, clarifies the separate
  `API_KEYS` (server) vs `API_KEY` (client) vars, and explicitly tells users to
  create a project and use the returned id rather than assuming id 1.
- **SETUP.md and CLI.md aligned with the fixed Quick Start** (#707). The CLI
  reference now frames every `tasks <command>` example as a documented alias for
  `npm run cli -- <command>`, with `npm link` called out as optional.
- **README CLI Summary notes the `tasks-cmd` alias** (#718). The CLI summary now
  records that `tasks-cmd` is an alias for the in-tree `npm run cli` invocation.

### Internal

- Test discovery excludes `.claude/worktrees/` so isolated-worktree subagent
  checkouts don't balloon or hang `npm test` (#717); removed a duplicated comment
  block in `src/api/start.ts` (#719). No runtime behavior change.

## [v1.16] - 2026-06-03

Ships **WSJF (Weighted Shortest Job First) economic prioritization**. Every task can be scored on its Cost of Delay (Business Value + Time Criticality + Risk/Opportunity-Enablement) divided by Job Size, so `/tasks:loop` and `/tasks:loop-dag` drain work by economic value rather than a hand-set `priority` enum. Scores are computed autonomously at task-creation time against a per-project **value charter**, every score carries a verbatim evidence trail plus append-only history, and a non-blocking degeneracy linter catches the classic WSJF anti-patterns. Fully backward-compatible: projects with no charter and no scores sort by `priority` then age exactly as before.

### Added
- **4 new WSJF MCP tools, with full stdio↔remote parity** (identical names, descriptions, and input schemas):
  - `wsjf_ranking` — rank a project's tasks by propagation-adjusted WSJF; `scope="frontier"` (default) excludes blocked/not-ready tasks, `scope="all"` ranks every task; returns the ordered list with components, base vs effective WSJF, and the downstream Cost-of-Delay `propagation` breakdown.
  - `wsjf_history` — a task's append-only WSJF score-history timeline (oldest-first), each entry annotated with a `deltas` map of per-component from→to changes vs the previous entry.
  - `rescore_project` *(mutation)* — deterministically rescore a project's already-scored tasks against the current value charter; opens a rescore run, writes one history row per changed task, skips locked components, returns evaluated/changed/skipped-locked counts.
  - `wsjf_health` — lint a project's WSJF state for degeneracies/pitfalls (non-blocking): near-identical scores, missing CoD `1` anchor, collapsed Job Size, past-deadline stale Time Criticality, high priority-fallback ratio, and score-churn. Empty findings ⇔ healthy.
  - Registered on both transports — stdio (`src/mcp/tools/wsjf-tools.ts`, wired in `src/mcp/server.ts`) and remote proxy (`src/mcp/remote/register-tools.ts`). MCP tool count rises from 23 to **27** on both transports. See [`docs/MCP.md`](docs/MCP.md).
- **New REST endpoints** (base scope `/api/v1`). See [`docs/API.md`](docs/API.md).
  - Task-scoped (`src/api/routes/tasks/wsjf.ts`): `GET /tasks/:id/wsjf` (read the four WSJF components + locks), `PUT /tasks/:id/wsjf` (manual-override set/lock of the four components; runs the enum + cross-component contradiction gate and writes a `manual` score-history row), `GET /tasks/:id/score-history` (append-only timeline with actor/charter/rescore-run provenance; backs `wsjf_history`).
  - Project-scoped (`src/api/routes/projects/wsjf.ts`): `GET /projects/:id/charter-history`, `GET /projects/:id/rescore-runs`, `GET /projects/:id/wsjf-ranking` (backs `wsjf_ranking`), `GET /projects/:id/wsjf-health` (backs `wsjf_health`), `POST /projects/:id/rescore` *(mutation, backs `rescore_project`)*.
- **New CLI commands** (`src/cli/commands/wsjf.ts`), all read commands emitting bare JSON:
  - `tasks wsjf-history <id>` — a task's append-only WSJF score history (oldest-first).
  - `tasks wsjf-set <id> --value <fib> --time-criticality <fib> --risk-opportunity <fib> --job-size <fib> [--lock <keys>]` — manual set/lock of a task's four components; all four flags required, each a Fibonacci tier (1,2,3,5,8,13); `--lock` takes comma-separated keys from `value,timeCriticality,riskOpportunity,jobSize`; runs the same enum + contradiction gate as REST/MCP.
  - `tasks charter-history <id>` — a project's value-charter history (oldest-first). See [`docs/CLI.md`](docs/CLI.md).
- **Migrations 013/014/015** (`src/db/migrations/`), bringing the migration count from 12 to **15**:
  - `013-wsjf-fields.ts` — adds the four nullable Fibonacci-CHECK component columns (`wsjf_value`, `wsjf_time_criticality`, `wsjf_risk_opportunity`, `wsjf_job_size`) plus five JSON metadata columns (`wsjf_evidence`, `wsjf_locked`, `wsjf_source`, `wsjf_classifications`, `wsjf_features`) on `tasks`. An all-four-or-none invariant is enforced at the Zod write boundary, not by a SQLite constraint.
  - `014-value-charter.ts` — adds the nullable JSON `value_charter` column on `projects`.
  - `015-wsjf-audit.ts` — adds three append-only audit tables: `wsjf_rescore_run`, `wsjf_score_history` (one immutable row per score write, storing classifications + features for LLM-free replay), and `project_charter_history`.
- **`value_charter` on projects + per-project setup interview.** The `/tasks:new-project` skill runs a STOP-and-wait, one-question-at-a-time interview capturing the project's value charter (mission, 2–4 Fibonacci-weighted value themes, time context, risk posture, out-of-scope). Skipping is valid — no charter is written and scoring falls back to the `priority` enum. The charter is the reference frame for User-Business-Value scoring.
- **Autonomous evidence-backed WSJF scoring at decompose/create.** `/tasks:decompose` (Step 8a) batch-scores the whole candidate set one Cost-of-Delay column at a time against the charter, anchoring the lowest candidate per column to the `1` tier. The LLM never emits a number: it submits classifications over closed enums (`theme + alignment`, `severity`, `decay`, a server-banded `jobSizeTier`) plus a verbatim evidence span per component, and the server (`validateScoreSubmission` in `src/services/wsjf.service.ts`) recomputes the four Fibonacci components deterministically and rejects degenerate batches (no `1` anchor, sub-floor variance).
- **`/tasks:loop` and `/tasks:loop-dag` select work by effective WSJF.** When a project has ≥ 1 scored task, the priority+ID sort is replaced by `wsjf_ranking` order (descending `effectiveWsjf`, unscored tasks slotted via a `priorityFallbackScore` map). Ranking gates on the ready frontier and propagates downstream Cost of Delay onto blockers (`effective_CoD = base_CoD + Σ dependents' base_CoD · γ^(dist−1)`, γ=0.5, capped at 3×), so a boring prerequisite that unblocks a large high-value subtree rises to the top. The ranking snapshot is written into `LOOP-RUN.md` for reproducibility, and `wsjf_health` is surfaced at loop start.

## [v1.15] - 2026-05-31

Makes the `wft-router` automation daemon actually reachable by npm users. It was advertised as a shipped feature since v1.13 but was a separate, never-published package (`@wood-fired-games/wft-router`), so it reached nobody via npm. It now ships **inside** the `wood-fired-tasks` package.

### Added
- **`wft-router` now ships in the `wood-fired-tasks` package.** Its built output and a `wft-router` bin are bundled into the published tarball; run it with `wft-router` / `npx wft-router` after install. The standalone `@wood-fired-games/wft-router` package is dropped (marked private). `pino` and `yaml` are now core runtime dependencies.

### Fixed
- **`wft-router` bin was a silent no-op when installed.** Its entry-point guard compared `import.meta.url` (symlink-resolved real path) against `process.argv[1]` (the `node_modules/.bin/wft-router` symlink path), which never matched, so `main()` never ran. The guard now resolves `argv[1]` to its real path. Regression-tested via `isEntryPoint`.

## [v1.14] - 2026-05-31

Ships loop-evidence anti-fabrication guardrails for `/tasks:loop` and `/tasks:loop-dag`. (First npm release since 1.12.0 — the 1.13.0 changeset was tagged `v1.13` but never published to npm, so this release also delivers everything under `[v1.13]` below.)

### Added
- **Loop evidence anti-fabrication guardrails** (#608): defense-in-depth against `/tasks:loop[-dag]` agents closing tasks on fabricated evidence. (1) Opt-in server gate `WFT_STRICT_EVIDENCE` (**default off**) — `update_task` rejects `verification_evidence` whose `verifier_session_id` is empty, equals the task assignee or the calling identity, or matches a self-grading pattern (`^orchestrator`/`^self`/`^main-loop`), and rejects placeholder/empty check evidence text (`src/services/evidence-validation.ts`). (2) Optional client-side `PreToolUse` reference hook `docs/hooks/validate-sha.mjs` that blocks evidence citing git SHAs unknown to the local repo. (3) Anti-fabrication / one-state-mutation-per-turn / separate-verifier discipline in the loop skills. Full rationale and honest scope in [`docs/RELIABILITY.md`](docs/RELIABILITY.md).

### Security
- Closes a trust gap where an orchestrating agent could self-grade `verification_evidence` (writing `verifier_session_id="orchestrator-…"` instead of dispatching a separate verifier) or cite nonexistent commit SHAs, leaving a live regression behind a `PASS`. Pieces A + B make these structural fabrications deterministically blockable when enabled; numeric truthfulness remains discipline-governed (not machine-enforceable) — stated explicitly in `docs/RELIABILITY.md`.

## [v1.13] - 2026-05-31

Ships the `wft-router` event-driven automation daemon, a `wait_for_unblock` MCP long-poll tool, and a `qs` DoS fix.

### Added
- **`wft-router` automation daemon** (`packages/wft-router`): a vendor-neutral service that subscribes to task lifecycle events over SSE and dispatches configured handlers. Includes a `triggers.yaml` Zod schema with a `--validate` flag, a predicate evaluator with templating, an idempotency store + dispatch state machine, a fetch-based SSE client with resume + watchdog, rate-limit/debounce/graceful-shutdown primitives, a pino logger, a cross-platform default path resolver, and a Prometheus `/metrics` endpoint (loopback by default).
- **`wft-router` handlers**: `create_task_in_project`, `webhook_post` (TLS posture guard), `shell_exec` (env scrubbing), and `agent_session_dispatch` (adapter extension), all on a shared handler contract.
- **`wait_for_unblock` MCP tool**: a long-poll tool to await dependency unblocking, available locally and SSE-backed on the remote server.
- `events.subscribeOnce` helper with deterministic teardown.
- **`wft-router` packaging**: OCI `Containerfile` + multi-arch `oci-build` CI job, host-platform manifests (systemd, launchd, Windows), reference adapters, deploy assets, and an example config.
- npm publish wiring: `prepublishOnly` gate (build + test + lint:deps + audit + pack-check) and a `pack-smoke` CI job.

### Changed
- README now leads with the AI-orchestration framing.
- `wft-router` assignee where-predicate to scope unblock dispatches.
- Stryker mutation CI re-sharded (api/mcp split, 7-way by mutant count).

### Fixed
- `wft-router` SSE client yields events incrementally instead of buffering until close, and applies an idle/read timeout so half-open sockets reconnect.
- `deploy/upgrade.sh` smoke test no longer hangs on a sudo TTY prompt.
- CI host-manifests systemd verify step no longer aborts under `errexit`.

### Security
- Forced `qs >= 6.15.2` to close GHSA-q8mj-m7cp-5q26 (prototype-pollution DoS).
- `wft-router` owner-uid hardening on adapter directory resolution; the `http://` posture guard is documented as a literal-host-only SSRF boundary.
- `wft-router` vendor-neutrality CI gate + denylist.
- `wft-router` pino logger redacts secret key-names and filesystem paths.

## [v1.12] - 2026-05-25

First public open-source release. OSS-launch readiness and CI sharding work landed since v1.11.

### Added
- `docs/TROUBLESHOOTING.md` operator recovery runbook (boot failures, wrong/stale DB, safe backup/restore); linked from AGENTS.md, README, and the docs index (task 355).
- Tool-count drift regression test for public docs (task 260).
- `.env.example` aligned with documented config (task 259).

### Changed
- License relicensed from ISC to MIT for OSS launch (task 253).
- SECURITY.md rewritten for the actual TypeScript/Fastify stack (task 254).
- OSS package metadata + npm `files` allowlist (task 255).
- Installer split into local vs. remote MCP paths; `--api-key` flag deprecated (still parsed and honored, emits a deprecation warning — prefer `WOOD_FIRED_TASKS_API_KEY`, the per-user secret file, or the interactive prompt) (task 258).
- Stryker mutation tests sharded across 4 parallel CI jobs; threshold raised to 75; workflow timeout extended (tasks 250, 252).
- Shipped systemd unit (`deploy/wood-fired-tasks.service`) now orders after `network-online.target` so OIDC discovery doesn't crash-loop the service on a cold boot; `StartLimitBurst` raised to 5 (task 353).
- `docs/MCP.md` now recommends the remote (REST) variant as the single-writer default, warns that the local direct-SQLite variant silently serves stale data, and documents a launcher-wrapper that keeps the API key out of client config (task 356).

### Fixed
- Test runs cleanly clean up `task.status_changed` listeners between runs (task 257).

## [v1.11] - 2026-05-21

Coverage ratchet, CLI bare-spot tests, and workflow engine cascade-rollback fix.

### Added
- Vitest coverage thresholds ratcheted past 80/80/70 (task 249).
- Test coverage for remote MCP rest-client + register-tools (task 249).
- Test coverage for CLI bare-spot commands `completed`/`completions`/`db-check`/`doctor` (task 249).
- Test coverage for CLI interactive prompts (task 249).
- Test coverage for CLI formatters + JSON output (task 249).

### Fixed
- Workflow engine no longer leaks phantom events during cascade rollback (task 244).

## [v1.10] - 2026-05-21

Pagination envelope, schema-derived CLI types, and a new MCP completion-report tool.

### Added
- `completion_report` tool on the remote MCP server (task 245).

### Changed
- List endpoints documented with paginated envelope shape (task 248).
- CLI `TaskResponse` derived from the server Zod schema instead of being hand-maintained (task 246).
- CLI shell-completions command list derived from the Commander registry (task 247).

### Fixed
- Dropped duplicate `metadata.range` field in `tasks completed --json` output.

## [v1.9] - 2026-05-20

Documentation sweep for OSS launch — README, CONTRIBUTING, CHANGELOG, API/CLI/MCP docs, and de-personalized fixtures/scripts.

### Added
- `CHANGELOG.md` with backfill of recent security-relevant changes (task 217).
- GitHub issue and PR templates (task 232).
- CONTRIBUTING.md expanded for external contributors (task 229).

### Changed
- README badges, refreshed test counts, canonical URLs, branding sweep (task 238).
- SETUP, Slack, data model, env vars, and architecture docs expanded (task 214).
- MCP docs corrected: tool count, remote server, events resource (task 220).
- CLI docs document 6 previously-missing commands; fixed `claim` JSON shape (task 223).
- API docs corrected: endpoint surface, `/health` & swagger, env, filters (task 227).
- Test fixtures de-personalized with generic names (task 237).
- Deploy scripts de-personalized via `WFT_SERVICE_USER` (task 236).

## [v1.8] - 2026-05-20

Pre-OSS hardening — test coverage, mutation testing, and performance regression
gates added as part of the open-source audit.

### Added
- Vitest `bench` suite for hot-path perf regression (task 212).
- v8 coverage reporter + CI threshold gate (task 199).
- Stryker mutation score enforcement in CI (task 203).
- Cross-platform install-script smoke tests + linters (task 202).
- OpenAPI snapshot for contract drift detection (task 207).

### Changed
- Expanded fast-check property tests over service invariants (tasks 200, 209).
- CLI snapshot + real-binary end-to-end tests (tasks 208, 211).
- Migrations verified via up→down→up schema snapshots (task 201).

### Fixed
- `install.sh` `TEMP_FILES` expansion under `set -u` on bash 3.2.
- CI shellcheck scoped to `install.sh`; tests excluded from `tsc` build.
- SSE fan-out and Slack request-signing regression coverage (tasks 205, 206).

### Security
- Generalized personal/internal examples in docs and tests pre-OSS.

## [v1.7] - 2026-05-20

Security audit remediation release — concentrated mitigation of pre-OSS
security review findings.

### Changed
- Default HTTP bind moved to `127.0.0.1` (task 188).
- `limit` / `offset` pagination on list endpoints (task 192).

### Fixed
- DELETE comment validates task ownership (task 191).
- Slack `subscribe` event types validated against allowlist (task 198).

### Security
- Untracked `.planning/` and internal agent dirs (task 186 prep).
- Documented `.env` handling, scrubbed working-tree secrets (task 187).
- Admin trust model documented + per-key labels (task 189).
- Removed live API key from events MCP resource markdown (task 196).
- Removed hardcoded internal LAN IP (task 190).
- SSE map stores hashed API-key fingerprint, not raw key (task 194).
- `install.sh` escapes API keys via `jq -n --arg` (task 195).
- All GitHub Actions pinned to commit SHAs (task 197).

## [v1.6] - 2026-05-20

First wave of security-audit fixes plus client-package / remote-MCP work.

### Added
- Remote MCP proxy server backed by the REST API for thin clients (quick-6).
- Client package with `setup.bat`/`uninstall.*` scripts and bundled CLI.
- `updated_after` / `updated_before` filters on `GET /tasks` (task 100).
- Completion-report dashboard (task 97).

### Changed
- `list_tasks` MCP response trimmed to compact summaries by default.
- Migration name normalization prevents `.ts` / `.js` mismatch crashes.

### Fixed
- Startup retries for transient SQLite errors in MCP entry point.
- Migrations serialized with exclusive SQLite transaction lock (quick-5).
- `SlackService` logger type widened to `FastifyBaseLogger`.
- Client install handles spaces in paths and PowerShell 5.1.

### Security
- Reduced unauthenticated public surface, bounded SSE connections (task 185).
- Hardened API-key auth against weak keys + brute force (task 182).
- Upgraded vulnerable prod deps + CI `npm audit` gate (task 181).
- Validated FTS search input, mapped syntax errors to 400 (task 183).
- Secured API-key handling across all installer scripts (task 184).

## [v1.5] - 2026-02-18

Slack integration milestone.

### Added
- Slack Bolt integration (`SlackService`) with channel subscriptions and
  `subscribe`/`unsubscribe` command surface (phases 23–26).
- `tasks` slash-command router with task/project/dep/comment/subtask/health
  subcommands and Block Kit formatters.
- `UserIdentityCache` for Slack user ID → display name resolution.
- `SlackNotifier` subscribed to EventBus with retry and per-channel error
  isolation.

### Changed
- Slack token config validated both-or-neither via Zod.

## [v1.4] - 2026-02-17

Reliability, UX polish, and CI quality gates.

### Added
- `tasks doctor`, `tasks stats`, `tasks db-check` diagnostics (phase 19).
- `tasks backup` CLI command + `backlogged` status (phase 18).
- Property-based tests for `CycleDetector` and status transitions (phase 20).
- Stryker mutation testing; knip unused-dep detection; GitHub Actions CI.
- Request IDs, MCP `traceId` logging, reduced SSE buffer.

### Changed
- Phase 17 Core Reliability work landed across 4 plans.
- Phase 21 UX polish: spinner, color utils, shell completions.

### Fixed
- Sweep no longer reverts `done`/`closed` tasks (quick-4).
- CLI `apiRequest` handles HTTP 204; SSE returns 400 on missing `Accept`.

### Security
- systemd unit gains resource limits + security hardening (phase 22).

## [v1.3] - 2026-02-14

Workflow engine, atomic task-claim protocol, and SSE event stream.

### Added
- `EventBus` with generics + Task/Project CRUD emissions (phase 14).
- `GET /api/v1/events` SSE endpoint, `SSEManager` with buffering.
- Atomic claim protocol (CAS + `BEGIN IMMEDIATE`), `claim_task` MCP tool,
  `tasks claim` CLI, stale-claim auto-release service (phase 15).
- `WorkflowEngine` parent auto-complete with cascade depth + dependency
  auto-unblock (phase 16).

### Changed
- `@fastify/sse` API usage corrected for v0.4.0.

## [v1.2] - 2026-02-14

Installers, Claude Code skills, and documentation.

### Added
- Bash and PowerShell installer scripts (phase 13).
- Claude Code skill files: `create-task`, `log-bug`, `my-work`, `show-task`,
  `pick-up`, `search`, `add-comment`, `done`, `blocked`, `project-status`
  (phase 12).
- `README.md`, `docs/SETUP.md`, `docs/API.md`, `docs/CLI.md`, `docs/MCP.md`.
- E2E regression suite and skill-file validation tests.

### Fixed
- Redirected Umzug logger to stderr so MCP stdio output stays clean.

## [v1.1] - 2026-02-13

CLI expansion, MCP tool surface, JSON mode.

### Added
- Project, dependency, comment, subtask, and health CLI commands
  (phases 08-01 through 08-05).
- MCP project tools, `list_subtasks` task tool, and `check_health` health
  tool (phase 09).
- Global `--json`, `--no-input`, `--force` flags and `@clack/prompts`
  interactive prompts (phase 07).
- `NO_COLOR` environment variable support.

### Fixed
- HTTP client only sends `Content-Type` when the request has a body.
- `dotenv` stdout contamination suppressed so JSON output stays clean.

## [v1.0] - 2026-02-13

Initial tagged release — REST API, CLI, MCP server, SQLite backing store,
and the task/project/dependency/comment/subtask domain model.

### Added
- Fastify REST API: task + project CRUD, auth, error handler, health,
  OpenAPI docs (phase 02).
- CLI with API client + task `create`/`list`/`update`/`delete`/`show`
  commands (phase 03).
- MCP server with task CRUD tools + error conversion (phase 04).
- systemd service unit + production entry point with graceful shutdown
  (phase 05-01).
- SQLite backup/restore scripts with cron schedule (phase 05-02).
- Task hierarchy (subtasks), dependency service, comments, time estimates
  (phase 06).

[Unreleased]: https://github.com/Wood-Fired-Games/wood-fired-tasks/compare/v2.0.0...HEAD
[v2.0.0]: https://github.com/Wood-Fired-Games/wood-fired-tasks/compare/v1.18.2...v2.0.0
[v1.15]: https://github.com/Wood-Fired-Games/wood-fired-tasks/compare/v1.14...v1.15
[v1.14]: https://github.com/Wood-Fired-Games/wood-fired-tasks/compare/v1.13...v1.14
[v1.13]: https://github.com/Wood-Fired-Games/wood-fired-tasks/compare/v1.12...v1.13
[v1.12]: https://github.com/Wood-Fired-Games/wood-fired-tasks/compare/v1.11...v1.12
[v1.11]: https://github.com/Wood-Fired-Games/wood-fired-tasks/compare/v1.10...v1.11
[v1.10]: https://github.com/Wood-Fired-Games/wood-fired-tasks/compare/v1.9...v1.10
[v1.9]: https://github.com/Wood-Fired-Games/wood-fired-tasks/compare/v1.8...v1.9
[v1.8]: https://github.com/Wood-Fired-Games/wood-fired-tasks/compare/v1.7...v1.8
[v1.7]: https://github.com/Wood-Fired-Games/wood-fired-tasks/compare/v1.6...v1.7
[v1.6]: https://github.com/Wood-Fired-Games/wood-fired-tasks/compare/v1.5...v1.6
[v1.5]: https://github.com/Wood-Fired-Games/wood-fired-tasks/compare/v1.4...v1.5
[v1.4]: https://github.com/Wood-Fired-Games/wood-fired-tasks/compare/v1.3...v1.4
[v1.3]: https://github.com/Wood-Fired-Games/wood-fired-tasks/compare/v1.2...v1.3
[v1.2]: https://github.com/Wood-Fired-Games/wood-fired-tasks/compare/v1.1...v1.2
[v1.1]: https://github.com/Wood-Fired-Games/wood-fired-tasks/compare/v1.0...v1.1
[v1.0]: https://github.com/Wood-Fired-Games/wood-fired-tasks/releases/tag/v1.0
