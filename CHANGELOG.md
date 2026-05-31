# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Each release groups changes under `Added`, `Changed`, `Fixed`, and `Security`.
Security-relevant items (auth, secret handling, network exposure, dependency
vulnerabilities, supply-chain pinning) are always called out under `Security`.

## [Unreleased]

### Added
- **Loop evidence anti-fabrication guardrails** (#608): defense-in-depth against `/tasks:loop[-dag]` agents closing tasks on fabricated evidence. (1) Opt-in server gate `WFT_STRICT_EVIDENCE` (**default off**) — `update_task` rejects `verification_evidence` whose `verifier_session_id` is empty, equals the task assignee/author/caller, or matches a self-grading pattern (`^orchestrator`/`^self`/`^main-loop`), and rejects placeholder/empty check evidence text (`src/services/evidence-validation.ts`). (2) Optional client-side `PreToolUse` reference hook `docs/hooks/validate-sha.mjs` that blocks evidence citing git SHAs unknown to the local repo. (3) Anti-fabrication / one-state-mutation-per-turn / separate-verifier discipline in the loop skills. Full rationale and honest scope in [`docs/RELIABILITY.md`](docs/RELIABILITY.md).

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

[Unreleased]: https://github.com/Wood-Fired-Games/wood-fired-tasks/compare/v1.11...HEAD
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
