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

