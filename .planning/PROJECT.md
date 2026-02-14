# Wood Fired Bugs

## What This Is

A centralized task tracking service for Wood Fired Games running as a persistent service on a local Ubuntu Linux machine. It provides a REST API (20 endpoints), MCP server (26 tools), and CLI (20 commands) for managing work items across all projects. LLM agents interact via REST or MCP; Stuart interacts via CLI. All three interfaces have full feature parity. Real-time SSE event streaming enables multi-agent coordination with atomic task claiming and workflow automation. Curated Claude Code skills provide workflow-driven slash commands, and cross-platform installers automate setup.

## Core Value

Any agent on the local network can reliably create, find, and update work items in real time — making this the single source of truth for all Wood Fired Games task tracking.

## Requirements

### Validated

- Persistent service running on Ubuntu, always available — v1.0
- SQLite-backed storage with WAL mode, FTS5 search, and sub-second responses — v1.0
- REST API with API key authentication accessible on the local network (19 endpoints) — v1.0
- MCP server for native Claude Code agent integration (12 tools via stdio) — v1.0
- CLI for human interaction: create, list, update tasks with colored table output — v1.0
- Full task data model: title, description, status, priority, project, assignee, created_by — v1.0
- Task relationships: parent/child subtasks, dependency tracking with cycle detection — v1.0
- Rich metadata: tags/labels, due dates, time estimates, comments with author/timestamp — v1.0
- Multi-project support with project CRUD — v1.0
- Full task lifecycle with enforced status transitions: open -> in_progress -> done -> closed, with blocked state — v1.0
- MCP server exposes tools for all REST API endpoints (25 tools: tasks, projects, deps, comments, subtasks, health) — v1.1
- CLI supports all REST API operations (19 commands: tasks, projects, deps, comments, subtasks, health) — v1.1
- CLI `--json` flag on all commands for machine-readable output with consistent envelope format — v1.1
- CLI interactive prompts when required fields are missing (`--no-input` to disable) — v1.1
- CLI improved table formatting with color-coded priorities/statuses, `NO_COLOR` support — v1.1
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

### Active

(No active requirements — next milestone not yet planned)

### Out of Scope

- Web UI — agents and CLI are the interfaces for now
- Mobile app — local network service only
- Cloud hosting — runs on local Ubuntu machine only
- User accounts / multi-user auth — API key auth is sufficient for single operator + agents
- CLI pagination — users can pipe to `less` or use filters
- CLI auto-update checking — manual update is fine
- CLI arbitrary command abbreviations — prevents adding new commands; use shell aliases
- Agent registry / capability matching — validate coordination model first, registry is v1.4+
- WebSocket transport — SSE is simpler and sufficient for push notifications
- Task templates / batch creation — existing MCP skills handle creation patterns
- Complex workflow DSL — predefined patterns sufficient, not Turing-complete scripts
- Distributed consensus (Paxos/Raft) — optimistic locking sufficient for LAN

## Context

Shipped v1.3 with 513 tests passing across 47 test files. Zero TypeScript errors.

Tech stack: Node.js, Fastify, better-sqlite3, @fastify/sse, MCP SDK, Commander.js, @clack/prompts, Zod, Pino, chalk v4.

Primary consumers are LLM agents (Claude Code and others) running on the local network.
Stuart is the sole human user, interacting via the `tasks` CLI.
The machine is an Ubuntu Linux box (6.8.0-100-generic) that stays on.

Interface inventory:
- REST API: 20 endpoints (tasks CRUD + claim, projects CRUD, dependencies, comments, subtasks, events, health)
- MCP Server: 26 tools (same coverage as REST) + events://stream resource
- CLI: 20 commands (same coverage as REST + interactive prompts)
- Claude Code Skills: 10 workflow skills (/tasks: namespace)
- Installers: install.sh (Linux/macOS), install.ps1 (Windows)

Real-time infrastructure:
- EventBus: type-safe pub/sub with native EventEmitter (8 event types)
- SSEManager: connection registry with filtering, heartbeat, Last-Event-ID replay
- WorkflowEngine: parent auto-complete, dependency auto-unblock, cascade depth limiting

Documentation: README.md, docs/API.md, docs/CLI.md, docs/MCP.md, docs/SETUP.md

## Constraints

- **Database**: SQLite with WAL mode — fast local reads, zero config, single-file backup
- **Platform**: Ubuntu Linux, runs as systemd service with auto-restart
- **Network**: Binds to 0.0.0.0 (LAN), API key auth for all /api/v1 requests
- **Cost**: All open source, free software
- **Performance**: Sub-second response times with FTS5 full-text search

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| SQLite over PostgreSQL | Zero config, single-file backup, fast local access at required scale | Good — WAL mode handles concurrent access, .backup for safe backups |
| REST + MCP dual interface | REST for any HTTP-capable agent, MCP for native Claude Code integration | Good — shared service layer keeps both interfaces consistent |
| API key auth over no auth | LAN-accessible service needs basic access control | Good — simple shared-secret model, comma-separated keys for multiple clients |
| CLI over web UI | Stuart prefers terminal; agents don't need UI | Good — Commander.js CLI with colored table output works well |
| Fastify + Zod type provider | Schema-driven validation, auto OpenAPI generation | Good — Zod schemas shared across REST + MCP for consistent validation |
| Status lifecycle enforcement | Prevents invalid state transitions at service layer | Good — 14 tests verify all valid/invalid transitions |
| chalk v4 over v5 | CJS/ESM compatibility via esModuleInterop; v5 is ESM-only | Good — avoids module resolution issues |
| @clack/prompts over inquirer | Modern, lightweight, handles Ctrl+C automatically | Good — clean UX with minimal dependency footprint |
| Content-Type only with body | DELETE requests fail with empty JSON content-type | Good — fixed bug found during live demo |
| Custom Umzug logger to stderr | MCP stdio requires stdout = JSON-RPC only | Good — migration logging preserved with [migration] prefix |
| Dual stdio verification | Static grep guards + runtime spawn tests catch protocol violations | Good — prevents future regressions at test-time and runtime |
| API key in MCP env section | MCP servers don't inherit shell profile variables | Good — installer writes to mcpServers.env, not .bashrc |
| ConvertTo-Json -Depth 10 | PowerShell defaults to depth 2, truncating nested MCP config | Good — prevents silent data loss in installer |
| @fastify/sse over WebSocket | Official Fastify plugin, simpler server-to-agent push | Good — SSE sufficient for notification streaming |
| Native EventEmitter for EventBus | Zero deps, TypeScript generics, follows existing patterns | Good — type-safe pub/sub with error isolation |
| CAS + BEGIN IMMEDIATE for claims | Optimistic locking prevents SQLITE_BUSY, clear conflict errors | Good — 20 concurrent claims verified, exactly 1 winner |
| MCP resource (not tool) for SSE | SSE streams are long-lived; resource provides discovery docs | Good — agents discover endpoint via events://stream |
| Event-driven workflow triggers | Decouple automation from SSE, EventBus enables composition | Good — WorkflowEngine subscribes to EventBus, clean separation |
| Max cascade depth = 5 | Prevents infinite loops from circular task hierarchies | Good — depth tracked per cascade chain |
| Transaction wrapping for cascades | SQLite transaction ensures atomic rollback on error | Good — no partial state on crash |

---
*Last updated: 2026-02-14 after v1.3 Multi-Agent Coordination shipped*
