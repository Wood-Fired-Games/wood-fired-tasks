# Wood Fired Bugs

## What This Is

A centralized task tracking service for Wood Fired Games running as a persistent service on a local Ubuntu Linux machine. It provides a REST API (20 endpoints), MCP server (20 tools), and CLI (24 commands) for managing work items across all projects. LLM agents interact via REST or MCP; Stuart interacts via CLI. All three interfaces have full feature parity. Real-time SSE event streaming enables multi-agent coordination with atomic task claiming and workflow automation. Curated Claude Code skills provide workflow-driven slash commands, and cross-platform installers automate setup. The service includes self-service diagnostics, structured logging, graceful lifecycle management, and hardened systemd deployment.

## Core Value

Any agent on the local network can reliably create, find, and update work items in real time — making this the single source of truth for all Wood Fired Games task tracking.

## Requirements

### Validated

- Persistent service running on Ubuntu, always available — v1.0
- SQLite-backed storage with WAL mode, FTS5 search, and sub-second responses — v1.0
- REST API with API key authentication accessible on the local network (20 endpoints) — v1.0
- MCP server for native Claude Code agent integration via stdio transport (20 tools) — v1.0+v1.1
- CLI for human interaction: create, list, update tasks with colored table output — v1.0
- Full task data model: title, description, status, priority, project, assignee, created_by — v1.0
- Task relationships: parent/child subtasks, dependency tracking with cycle detection — v1.0
- Rich metadata: tags/labels, due dates, time estimates, comments with author/timestamp — v1.0
- Multi-project support with project CRUD — v1.0
- Full task lifecycle with enforced status transitions: open -> in_progress -> done -> closed, with blocked and backlogged states — v1.0+v1.4
- MCP server exposes tools for all REST API endpoints (20 tools: tasks, projects, deps, comments, subtasks, claim, health) — v1.1+v1.3
- CLI supports all REST API operations (24 commands: tasks, projects, deps, comments, subtasks, health, backup, doctor, stats, db-check, completions) — v1.1+v1.4
- CLI `--json` flag on all commands for machine-readable output with consistent envelope format — v1.1
- CLI interactive prompts when required fields are missing (`--no-input` to disable) — v1.1
- CLI improved table formatting with color-coded priorities/statuses, `NO_COLOR` support — v1.1+v1.4
- CLI confirmation prompts before destructive actions (`--force` to skip) — v1.1
- MCP server stdio compliance: stdout produces only JSON-RPC, all logging to stderr — v1.2
- 10 curated Claude Code skills for task workflows (/tasks: namespace) — v1.2
- Cross-platform installers: Bash (Linux/macOS) and PowerShell (Windows) — v1.2
- Installer config merge preserves existing MCP servers and backs up config — v1.2
- Server-Sent Events (SSE) endpoint for real-time task change notifications with filtering — v1.3
- Atomic task claim protocol with CAS + optimistic locking, 20-agent concurrency verified — v1.3
- Workflow automation: parent auto-complete and dependency auto-unblock with cascade depth limiting — v1.3
- Idempotent claim deduplication and auto-release of stale claims (30-min timeout) — v1.3
- Event stream, claim protocol, and workflows exposed via all interfaces (REST, MCP, CLI) — v1.3
- ✓ Structured JSON logging with Pino redaction, health check endpoint, graceful shutdown, config validation — v1.4
- ✓ SQLite hot backup command (`tasks backup`) with online backup API — v1.4
- ✓ Backlogged task status with triage workflow (backlogged -> open only) — v1.4
- ✓ Self-service diagnostics: `tasks doctor`, `tasks stats`, `tasks db-check` — v1.4
- ✓ Request ID propagation across REST, MCP, and CLI layers — v1.4
- ✓ SSE replay buffer (100 events) for client reconnection resilience — v1.4
- ✓ Mutation testing with Stryker (75.88% baseline), property-based tests with fast-check — v1.4
- ✓ Unused dependency detection with knip, GitHub Actions CI pipeline — v1.4
- ✓ Progress spinners, consistent colored output, bash/zsh shell completions — v1.4
- ✓ systemd resource limits and 19-directive security hardening — v1.4

### Active

(None — next milestone requirements TBD via `/gsd:new-milestone`)

### Out of Scope

- Web UI — agents and CLI are the interfaces for now
- Mobile app — local network service only
- Cloud hosting — runs on local Ubuntu machine only
- User accounts / multi-user auth — API key auth is sufficient for single operator + agents
- CLI pagination — users can pipe to `less` or use filters
- CLI auto-update checking — manual update is fine
- CLI arbitrary command abbreviations — prevents adding new commands; use shell aliases
- Agent registry / capability matching — validate coordination model first
- WebSocket transport — SSE is simpler and sufficient for push notifications
- Task templates / batch creation — existing MCP skills handle creation patterns
- Complex workflow DSL — predefined patterns sufficient, not Turing-complete scripts
- Distributed consensus (Paxos/Raft) — optimistic locking sufficient for LAN
- Rate limiting — single human + trusted agents; connection limits sufficient
- Circuit breakers — no external dependencies to fail; Fastify timeout handling sufficient
- Distributed tracing — single process; logs with request IDs sufficient
- Prometheus metrics server — log-based metrics sufficient for local service
- Database replication — single node; daily backups sufficient
- RBAC / per-user permissions — single user system
- JWT/OAuth2 authentication — API key auth sufficient for local service

## Context

Shipped v1.4 with 636 tests across 57 test files. 24,425 lines of TypeScript across 130+ files. Zero TypeScript errors. Mutation testing baseline: 75.88% covered mutation score. GitHub Actions CI active.

Tech stack: Node.js 22, Fastify, better-sqlite3, @fastify/sse, MCP SDK, Commander.js, @clack/prompts, Zod, Pino, chalk v4, Stryker, fast-check, knip.

Primary consumers are LLM agents (Claude Code and others) running on the local network.
Stuart is the sole human user, interacting via the `tasks` CLI.
The machine is an Ubuntu Linux box (6.8.0-100-generic) that stays on.

Interface inventory:
- REST API: 20 endpoints (tasks CRUD + claim, projects CRUD, dependencies, comments, subtasks, events, health)
- MCP Server: 20 tools (same coverage as REST) + events://stream resource
- CLI: 24 commands (same coverage as REST + interactive prompts + backup + doctor/stats/db-check + completions)
- Claude Code Skills: 10 workflow skills (/tasks: namespace)
- Installers: install.sh (Linux/macOS), install.ps1 (Windows)

Real-time infrastructure:
- EventBus: type-safe pub/sub with native EventEmitter (8 event types)
- SSEManager: connection registry with filtering, heartbeat, Last-Event-ID replay (100-event buffer)
- WorkflowEngine: parent auto-complete, dependency auto-unblock, cascade depth limiting

Reliability infrastructure:
- Structured JSON logging (Pino) with sensitive field redaction
- Health check endpoint (/health) with DB connectivity verification
- Graceful shutdown with connection draining and WAL checkpoint
- Config validation at startup with fail-fast on bad env vars
- sysexits.h standard exit codes

Documentation: README.md, docs/API.md, docs/CLI.md, docs/MCP.md, docs/SETUP.md

## Constraints

- **Database**: SQLite with WAL mode — fast local reads, zero config, single-file backup
- **Platform**: Ubuntu Linux, runs as systemd service with auto-restart, resource limits, security hardening
- **Network**: Binds to 0.0.0.0 (LAN), API key auth for all /api/v1 requests
- **Cost**: All open source, free software
- **Performance**: Sub-second response times with FTS5 full-text search

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| SQLite over PostgreSQL | Zero config, single-file backup, fast local access at required scale | ✓ Good — WAL mode handles concurrent access, .backup for safe backups |
| REST + MCP dual interface | REST for any HTTP-capable agent, MCP for native Claude Code integration | ✓ Good — shared service layer keeps both interfaces consistent |
| API key auth over no auth | LAN-accessible service needs basic access control | ✓ Good — simple shared-secret model, comma-separated keys for multiple clients |
| CLI over web UI | Stuart prefers terminal; agents don't need UI | ✓ Good — Commander.js CLI with colored table output works well |
| Fastify + Zod type provider | Schema-driven validation, auto OpenAPI generation | ✓ Good — Zod schemas shared across REST + MCP for consistent validation |
| Status lifecycle enforcement | Prevents invalid state transitions at service layer | ✓ Good — 14 tests verify all valid/invalid transitions |
| chalk v4 over v5 | CJS/ESM compatibility via esModuleInterop; v5 is ESM-only | ✓ Good — avoids module resolution issues |
| @clack/prompts over inquirer | Modern, lightweight, handles Ctrl+C automatically | ✓ Good — clean UX with minimal dependency footprint |
| Content-Type only with body | DELETE requests fail with empty JSON content-type | ✓ Good — fixed bug found during live demo |
| Custom Umzug logger to stderr | MCP stdio requires stdout = JSON-RPC only | ✓ Good — migration logging preserved with [migration] prefix |
| Dual stdio verification | Static grep guards + runtime spawn tests catch protocol violations | ✓ Good — prevents future regressions at test-time and runtime |
| API key in MCP env section | MCP servers don't inherit shell profile variables | ✓ Good — installer writes to mcpServers.env, not .bashrc |
| ConvertTo-Json -Depth 10 | PowerShell defaults to depth 2, truncating nested MCP config | ✓ Good — prevents silent data loss in installer |
| @fastify/sse over WebSocket | Official Fastify plugin, simpler server-to-agent push | ✓ Good — SSE sufficient for notification streaming |
| Native EventEmitter for EventBus | Zero deps, TypeScript generics, follows existing patterns | ✓ Good — type-safe pub/sub with error isolation |
| CAS + BEGIN IMMEDIATE for claims | Optimistic locking prevents SQLITE_BUSY, clear conflict errors | ✓ Good — 20 concurrent claims verified, exactly 1 winner |
| MCP resource (not tool) for SSE | SSE streams are long-lived; resource provides discovery docs | ✓ Good — agents discover endpoint via events://stream |
| Event-driven workflow triggers | Decouple automation from SSE, EventBus enables composition | ✓ Good — WorkflowEngine subscribes to EventBus, clean separation |
| Max cascade depth = 5 | Prevents infinite loops from circular task hierarchies | ✓ Good — depth tracked per cascade chain |
| Transaction wrapping for cascades | SQLite transaction ensures atomic rollback on error | ✓ Good — no partial state on crash |
| db.backup() over VACUUM INTO | Online Backup API is WAL-safe for hot backups while server runs | ✓ Good — readonly connection avoids write lock conflicts |
| Backlogged -> open only transition | Enforces triage workflow: must explicitly promote before agents can claim | ✓ Good — existing claimTask guard handles exclusion automatically |
| SQLite table rebuild for CHECK changes | ALTER TABLE cannot modify CHECK constraints; standard rebuild pattern | ✓ Good — migration 005 preserves data and recreates FTS triggers |
| configSchema.safeParse for CLI diagnostics | loadConfig() calls process.exit(78) on failure; safeParse enables reporting | ✓ Good — doctor command reports config issues instead of crashing |
| requestIdHeader: false | Prevent callers from injecting arbitrary request IDs into Fastify logs | ✓ Good — security hardening with no usability cost |
| Module-level _lastRequestId in CLI client | Expose request ID without breaking 20+ existing caller signatures | ✓ Good — getLastRequestId() available for debugging, zero API changes |
| SSE buffer 100 (not 1000) | Right-sized per OBSV-03 requirement; ~44KB memory at 100 events | ✓ Good — 5-min TTL still applies as secondary constraint |
| traceId on 5 key MCP tools only | Blast radius control; full coverage deferred to future hardening | ✓ Good — covers create/update/list/claim task + check_health |
| Removed @fastify/cors and fastify-plugin | knip detected as unused; grep confirmed zero imports in src/ | ✓ Good — cleaner dependency tree, faster installs |
| vitest.related: false for Stryker | Integration tests use createTestApp() factory; related:true misses them | ✓ Good — accurate mutation scores with full test execution |
| thresholds.break: null for initial run | Baseline score unknown; set threshold after observing results | ✓ Good — 75.88% covered established as baseline |
| @stryker-mutator/api in knip ignore | JSDoc type import not statically traceable by knip | ✓ Good — false positive resolved with documented exclusion |
| withSpinner 500ms delay | Fast enough to feel responsive, avoids flash on instant ops | ✓ Good — spinner is presentation concern in commands, not in apiRequest |
| Static shell completion scripts | Avoids API calls during tab completion; bash + zsh | ✓ Good — 25 commands, 6 statuses, 4 priorities covered |
| MemoryDenyWriteExecute NOT enabled | V8 JIT requires W+X pages; incompatible with this directive | ✓ Good — documented in service file |
| DynamicUser NOT used | SQLite needs stable file ownership for WAL/journal | ✓ Good — service runs as dedicated user with ReadWritePaths |

---
*Last updated: 2026-02-17 after v1.4 milestone*
