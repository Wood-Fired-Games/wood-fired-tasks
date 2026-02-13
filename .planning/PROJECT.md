# Wood Fired Bugs

## What This Is

A centralized task tracking service for Wood Fired Games running as a persistent service on a local Ubuntu Linux machine. It provides a REST API (19 endpoints), MCP server (12 tools), and CLI for managing work items across all projects. LLM agents interact via REST or MCP; Stuart interacts via CLI.

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

### Active

- MCP server exposes tools for all REST API endpoints (project CRUD, health) — v1.1
- CLI supports all REST API operations (projects, delete, dependencies, comments, subtasks, estimates, health) — v1.1
- CLI `--json` flag on all commands for machine-readable output — v1.1
- CLI interactive prompts when required fields are missing — v1.1
- CLI improved table formatting with color-coded priorities and statuses — v1.1

### Out of Scope

- Web UI — agents and CLI are the interfaces for now
- Mobile app — local network service only
- Real-time push notifications — agents poll or query as needed; webhooks in v2
- Cloud hosting — runs on local Ubuntu machine only
- User accounts / multi-user auth — API key auth is sufficient for single operator + agents

## Context

Shipped v1.0 with 9,020 lines of TypeScript across 117 files.
Tech stack: Node.js, Fastify, better-sqlite3, MCP SDK, Commander.js, Zod, Pino.
250 tests passing. Zero TypeScript errors. Zero warnings.

Primary consumers are LLM agents (Claude Code and others) running on the local network.
Stuart is the sole human user, interacting via the `tasks` CLI.
The machine is an Ubuntu Linux box (6.8.0-100-generic) that stays on.

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

## Current Milestone: v1.1 Interface Parity & CLI Polish

**Goal:** Full 1:1 feature parity across REST API, MCP server, and CLI — plus CLI UX improvements.

**Target features:**
- MCP tools for project CRUD and health check (closing the 7-tool gap)
- CLI commands for every REST endpoint (projects, task delete, dependencies, comments, subtasks, estimates, health)
- `--json` flag on all CLI commands for scripting and piping
- Interactive prompts when required fields are missing
- Better table formatting with color-coded statuses and priorities

---
*Last updated: 2026-02-13 after v1.1 milestone started*
