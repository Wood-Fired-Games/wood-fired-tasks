# Wood Fired Bugs

## What This Is

A centralized task tracking service for Wood Fired Games running as a persistent service on a local Ubuntu Linux machine. It provides a REST API (19 endpoints), MCP server (25 tools), and CLI (19 commands) for managing work items across all projects. LLM agents interact via REST or MCP; Stuart interacts via CLI. All three interfaces have full feature parity.

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

### Active

<!-- v1.2: Claude Code Skills & Installer -->
- [ ] Curated Claude Code skills for common task workflows (namespaced under /tasks:)
- [ ] Skills use MCP tools for all API interactions
- [ ] Cross-platform installer (Bash for Linux, PowerShell for Windows)
- [ ] Installer copies skills, configures MCP server, sets up auth

### Out of Scope

- Web UI — agents and CLI are the interfaces for now
- Mobile app — local network service only
- Real-time push notifications — agents poll or query as needed; webhooks in v2
- Cloud hosting — runs on local Ubuntu machine only
- User accounts / multi-user auth — API key auth is sufficient for single operator + agents
- CLI pagination — users can pipe to `less` or use filters
- CLI auto-update checking — manual update is fine
- CLI arbitrary command abbreviations — prevents adding new commands; use shell aliases

## Context

Shipped v1.1 with 13,795 lines of TypeScript.
357 tests passing across 32 test files. Zero TypeScript errors.

Tech stack: Node.js, Fastify, better-sqlite3, MCP SDK, Commander.js, @clack/prompts, Zod, Pino, chalk v4.

Primary consumers are LLM agents (Claude Code and others) running on the local network.
Stuart is the sole human user, interacting via the `tasks` CLI.
The machine is an Ubuntu Linux box (6.8.0-100-generic) that stays on.

Interface inventory:
- REST API: 19 endpoints (tasks CRUD, projects CRUD, dependencies, comments, subtasks, health)
- MCP Server: 25 tools (same coverage as REST)
- CLI: 19 commands (same coverage as REST + interactive prompts)

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
| process.argv for flag detection | Avoids circular dependencies with Commander option parsing | Good — reliable for --json, --no-input, --force detection |
| Flat hyphenated CLI commands | Commander subcommand nesting adds complexity for no benefit | Good — `project-create` is as discoverable as `project create` |
| Content-Type only with body | DELETE requests fail with empty JSON content-type | Good — fixed bug found during live demo |

## Current Milestone: v1.2 Claude Code Skills & Installer

**Goal:** Make wood-fired-bugs accessible from any Claude Code session via curated slash command skills and a cross-platform installer.

**Target features:**
- Curated workflow skills: log-bug, create-task, my-work, pick-up, done, blocked, search, project-status, add-comment, show-task
- Skills use MCP tools for API interaction, auth via environment variable
- Installer scripts for Linux (Bash) and Windows (PowerShell)
- Installer handles: skill file copy, MCP server config, API key setup, connectivity test

---
*Last updated: 2026-02-13 after v1.2 milestone started*
