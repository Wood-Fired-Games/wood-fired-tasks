# Roadmap: Wood Fired Bugs

## Milestones

- v1.0 MVP -- Phases 1-6 (shipped 2026-02-13)
- v1.1 Interface Parity & CLI Polish -- Phases 7-10 (active)

## Phases

<details>
<summary>v1.0 MVP (Phases 1-6) -- SHIPPED 2026-02-13</summary>

- [x] Phase 1: Foundation (3/3 plans) -- completed 2026-02-13
- [x] Phase 2: REST API (2/2 plans) -- completed 2026-02-13
- [x] Phase 3: CLI (2/2 plans) -- completed 2026-02-13
- [x] Phase 4: MCP Server (2/2 plans) -- completed 2026-02-13
- [x] Phase 5: Production Deployment (2/2 plans) -- completed 2026-02-13
- [x] Phase 6: Advanced Features (2/2 plans) -- completed 2026-02-13

See: [milestones/v1.0-ROADMAP.md](./milestones/v1.0-ROADMAP.md) for full details.

</details>

### v1.1 Interface Parity & CLI Polish (Phases 7-10)

Active milestone. Full CLI/MCP parity with REST API.

---

## Phase 7: Core CLI Infrastructure

**Goal:** CLI has robust foundation for output formatting, interactive prompts, and global options

**Dependencies:** v1.0 complete

**Requirements:** INFRA-01, INFRA-02, INFRA-03, INFRA-04, INFRA-05, UX-01, UX-02, UX-03

**Success Criteria:**

1. User can run any CLI command with `--json` flag and receive parseable JSON on stdout (messages on stderr)
2. User forgets required field when creating task, CLI prompts interactively with clean UX
3. User runs CLI command in script with `--no-input` flag, CLI fails fast with clear error instead of hanging on prompt
4. User attempts to delete a task, CLI shows confirmation prompt unless `--force` flag is set
5. User views task list with color-coded statuses (green=done, yellow=in_progress, red=blocked) and priorities

**Plans:** 3 plans

Plans:
- [x] 07-01-PLAN.md — Output abstraction layer and global --json flag
- [x] 07-02-PLAN.md — Interactive prompts with @clack/prompts
- [x] 07-03-PLAN.md — Retrofit existing commands with JSON and prompts

---

## Phase 8: CLI Command Expansion

**Goal:** CLI supports every REST API operation with consistent UX

**Dependencies:** Phase 7

**Requirements:** CMD-01, CMD-02, CMD-03, CMD-04, CMD-05, CMD-06, CMD-07, CMD-08, CMD-09, CMD-10, CMD-11, CMD-12, CMD-13, CMD-14, CMD-15, CMD-16

**Success Criteria:**

1. User can manage projects end-to-end via CLI (create, list, show, update, delete) without touching the REST API
2. User can manage task dependencies via CLI (add, remove, list) and see cycle detection errors
3. User can manage comments via CLI (add, list, delete) with author/timestamp display
4. User can manage subtasks via CLI (create under parent, list all children)
5. User can check service health via `tasks health` and see database status, uptime, version

**Plans:** 5 plans

Plans:
- [x] 08-01-PLAN.md — Task delete and show commands
- [x] 08-02-PLAN.md — Project CRUD commands (create, list, show, update, delete)
- [x] 08-03-PLAN.md — Dependency management commands (add, remove, list)
- [x] 08-04-PLAN.md — Comment management commands (add, list, delete)
- [x] 08-05-PLAN.md — Subtask and health check commands

---

## Phase 9: MCP Tool Expansion

**Goal:** MCP server exposes tools for all REST API endpoints

**Dependencies:** Phase 7 (can run parallel with Phase 8)

**Requirements:** MCP-01, MCP-02, MCP-03, MCP-04, MCP-05, MCP-06, MCP-07

**Success Criteria:**

1. Agent can manage projects via MCP tools (create_project, get_project, list_projects, update_project, delete_project)
2. Agent can check service health via check_health MCP tool and receive structured response
3. Agent can list subtasks via list_subtasks MCP tool with consistent parameter naming (task_id)
4. All MCP tools follow snake_case naming convention (resource_action pattern)

**Plans:** 2 plans

Plans:
- [x] 09-01-PLAN.md — Project CRUD MCP tools (create, get, list, update, delete)
- [x] 09-02-PLAN.md — Health check and subtask list MCP tools

---

## Phase 10: Testing & Integration

**Goal:** All CLI commands and MCP tools verified working with comprehensive test coverage

**Dependencies:** Phase 8, Phase 9

**Requirements:** All v1.1 requirements (validation phase)

**Success Criteria:**

1. User runs any CLI command with `--json` flag, pipes to `jq`, and receives valid JSON (no stdout contamination)
2. Developer runs test suite and sees coverage for all 18 CLI commands in both table and JSON output modes
3. Developer runs MCP inspector and sees all 19 tools with no stdout pollution
4. Integration tests verify CLI → REST → Service flow for all new commands
5. Documentation updated with examples for all new commands and tools

**Plans:** 0/0 (validation phase — verified via milestone audit)

---

## Progress

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 1. Foundation | v1.0 | 3/3 | Complete | 2026-02-13 |
| 2. REST API | v1.0 | 2/2 | Complete | 2026-02-13 |
| 3. CLI | v1.0 | 2/2 | Complete | 2026-02-13 |
| 4. MCP Server | v1.0 | 2/2 | Complete | 2026-02-13 |
| 5. Production Deployment | v1.0 | 2/2 | Complete | 2026-02-13 |
| 6. Advanced Features | v1.0 | 2/2 | Complete | 2026-02-13 |
| 7. Core CLI Infrastructure | v1.1 | 3/3 | Complete | 2026-02-13 |
| 8. CLI Command Expansion | v1.1 | 5/5 | Complete | 2026-02-13 |
| 9. MCP Tool Expansion | v1.1 | 2/2 | Complete | 2026-02-13 |
| 10. Testing & Integration | v1.1 | 0/0 | Complete | 2026-02-13 |
