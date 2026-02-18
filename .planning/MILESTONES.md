# Milestones

## v1.0 MVP (Shipped: 2026-02-13)

**Phases completed:** 6 phases, 13 plans, 8 tasks

**Key accomplishments:**
- SQLite-backed data layer with WAL mode, FTS5 full-text search, and status lifecycle enforcement
- REST API with API key auth, structured errors, and auto-generated OpenAPI documentation
- CLI tool (`tasks`) for human task management with colored table output and filtering
- MCP server for native LLM agent integration via stdio transport (12 tools)
- Production deployment infrastructure: systemd, Pino logging, automated SQLite backups
- Advanced features: subtask hierarchies, dependency tracking with cycle detection, comments, time estimates

**Stats:**
- 9,020 lines of TypeScript across 117 files
- 250 tests passing (zero errors, zero warnings)
- Built in 63 minutes across 13 plans
- Git range: d0fad97..eafd75a

---


## v1.1 Interface Parity & CLI Polish (Shipped: 2026-02-13)

**Phases completed:** 4 phases (7-10), 10 plans, 34 tasks

**Key accomplishments:**
- Output abstraction layer with `--json` flag, stdout/stderr separation, and `NO_COLOR` support across all CLI commands
- Interactive prompt infrastructure (@clack/prompts) with `--no-input` and `--force` global flags
- 19 CLI commands covering full REST API parity: tasks, projects, dependencies, comments, subtasks, health
- 25 MCP tools achieving full agent-accessible interface parity with REST API
- Comprehensive test suite: 357 tests across 32 files (1.36:1 test-to-source ratio)
- Milestone audit passed 31/31 requirements verified against source code

**Stats:**
- 9,722 lines added (13,795 total TypeScript)
- 67 files modified
- 357 tests passing (32 test files)
- Built in ~77 minutes across 10 plans
- Git range: afae4b9..ef9e499

---


## v1.2 Claude Code Skills & Installer (Shipped: 2026-02-14)

**Phases completed:** 3 phases (11-13), 7 plans, 11 tasks

**Key accomplishments:**
- MCP server stdio compliance: fixed Umzug stdout pollution, added static + runtime regression guards
- 10 curated Claude Code skill files (/tasks: namespace) covering full task lifecycle workflows
- Cross-platform installers: Bash (install.sh) for Linux/macOS and PowerShell (install.ps1) for Windows
- Installers handle skill copying, MCP config merge, API key setup, backup, and connectivity validation
- Comprehensive documentation: README, API reference, CLI reference, MCP reference, setup guide (2,664 lines)
- 386 tests passing across 36 files with dependency/comment MCP coverage and E2E regression tests

**Stats:**
- 59 files changed, 13,068 insertions
- 386 tests passing (36 test files)
- Built in ~7 minutes across 7 plans + 3 quick tasks
- Git range: ef9e499..HEAD

---


## v1.3 Multi-Agent Coordination (Shipped: 2026-02-14)

**Phases completed:** 3 phases (14-16), 10 plans

**Key accomplishments:**
- Real-time event streaming via SSE (GET /api/v1/events) with EventBus, filtering, heartbeat, and Last-Event-ID replay
- Atomic task claiming with CAS + BEGIN IMMEDIATE, 20-agent concurrency verified, zero SQLITE_BUSY errors
- Idempotent claim deduplication via X-Idempotency-Key header with 24h TTL
- Automatic stale claim release after 30 minutes of inactivity
- Workflow automation: parent auto-complete and dependency auto-unblock with cascade depth limiting (max 5) and transaction atomicity
- Full interface parity: all v1.3 features exposed via REST, MCP tools, and CLI with workflow source attribution

**Stats:**
- 38 files changed, 4,425 insertions
- 513 tests passing (47 test files)
- 29 commits across 10 plans
- Git range: a556fd3..621d817

---


## v1.4 Hardening and Polish (Shipped: 2026-02-17)

**Phases completed:** 6 phases (17-22), 15 plans

**Key accomplishments:**
- Structured JSON logging, /health endpoint, graceful shutdown, config validation, exit codes, WAL maintenance (Phase 17)
- SQLite hot backup command (`tasks backup`) and backlogged task status lifecycle with triage workflow (Phase 18)
- Self-service diagnostics (`tasks doctor`, `tasks stats`, `tasks db-check`), request ID propagation, SSE replay buffer (Phase 19)
- Mutation testing with Stryker (75.88% baseline), property-based tests with fast-check, knip unused dep detection + GitHub Actions CI (Phase 20)
- Progress spinners (@clack/prompts), consistent colored output across 24 commands with NO_COLOR support, bash/zsh shell completions (Phase 21)
- systemd resource limits (MemoryMax=512M, CPUQuota=100%, TasksMax=50) and 19 security hardening directives (Phase 22)

**Stats:**
- 24,425 lines of TypeScript across 130+ files
- 636 tests passing (57 test files)
- 123 files changed, 15,152 insertions
- Mutation testing baseline: 75.88% covered mutation score
- Git range: 8cc10d3..d3d4110

---


## v1.5 Slack Integration (Shipped: 2026-02-18)

**Phases completed:** 4 phases (23-26), 10 plans, 20 tasks

**Key accomplishments:**
- Socket Mode infrastructure with `@slack/bolt`, token-absent feature flag, graceful Fastify lifecycle integration, and `slack_channel_subscriptions` migration
- Pure Block Kit formatter functions producing typed `KnownBlock[]` for tasks, projects, and notifications with consistent emoji/priority/truncation conventions
- TTL-cached Slack user identity resolution (display name fallback chain, 5-min cache, 30s error cache) integrated into create/claim handlers
- All 26 `/tasks` subcommands with ack-first pattern achieving full CLI parity from Slack
- EventBus-driven notification pipeline with per-channel subscription routing, fire-and-forget async, `Promise.allSettled` error isolation, and transient retry with exponential backoff
- End-to-end Slack integration tested live: task creation and status change notifications delivered to subscribed channels

**Stats:**
- 48 files changed, 11,202 insertions (27,607 total LOC TypeScript)
- 839 tests passing (65 test files)
- 203 new tests added across 10 plans
- 15 feat commits across 4 phases
- Git range: v1.4..bfa2dff

---

