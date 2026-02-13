# Wood Fired Bugs

## What This Is

A centralized task tracking service for Wood Fired Games that runs as a persistent service on a local Ubuntu Linux machine. It provides a REST API and MCP server so any LLM agent on the local network can create, query, update, and manage work items across all Wood Fired projects. Stuart interacts via CLI.

## Core Value

Any agent on the local network can reliably create, find, and update work items in real time — making this the single source of truth for all Wood Fired Games task tracking.

## Requirements

### Validated

(None yet — ship to validate)

### Active

- [ ] Persistent service running on Ubuntu, always available
- [ ] SQLite-backed storage handling tens of thousands of tasks with fast response times
- [ ] REST API with API key authentication accessible on the local network
- [ ] MCP server for native Claude Code agent integration
- [ ] CLI for human interaction (query, create, update tasks)
- [ ] Full task data model: title, description, status, priority, project
- [ ] Assignment tracking (assigned to agent or person, created by)
- [ ] Task relationships: parent/child, dependencies, blocking/blocked-by
- [ ] Rich metadata: tags/labels, due dates, time estimates, comments
- [ ] Multi-project support across all Wood Fired Games work
- [ ] Full task lifecycle: create, assign, update status, comment, close

### Out of Scope

- Web UI — agents and CLI are the interfaces for now
- Mobile app — local network service only
- Real-time push notifications — agents poll or query as needed
- Cloud hosting — runs on local Ubuntu machine only
- User accounts / multi-user auth — API key auth is sufficient

## Context

- This will become THE work tracking system for Wood Fired Games, replacing whatever is currently used
- Primary consumers are LLM agents (Claude Code and others) running on the local network
- Must be open source and free — no licensed database engines
- Stuart is the sole human user; agents are the primary consumers
- The machine is an Ubuntu Linux box (6.8.0-100-generic) that stays on
- Wood Fired Games has multiple projects (including wood-fired-platform) that all need tracking

## Constraints

- **Database**: SQLite — fast local reads, zero config, handles scale, open source
- **Platform**: Ubuntu Linux, runs as a persistent service (systemd or similar)
- **Network**: Binds to LAN interface, API key auth for all requests
- **Cost**: Must use only open source, free software
- **Performance**: Sub-second response times with tens of thousands of tasks

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| SQLite over PostgreSQL | Zero config, single-file backup, fast local access at required scale, open source | — Pending |
| REST + MCP dual interface | REST for any HTTP-capable agent, MCP for native Claude Code integration | — Pending |
| API key auth over no auth | LAN-accessible service needs basic access control | — Pending |
| CLI over web UI | Stuart prefers terminal; agents don't need UI | — Pending |

---
*Last updated: 2026-02-13 after initialization*
