# Roadmap: Wood Fired Bugs

## Milestones

- ✅ **v1.0 MVP** - Phases 1-6 (shipped 2026-02-13)
- ✅ **v1.1 Interface Parity & CLI Polish** - Phases 7-10 (shipped 2026-02-13)
- 🚧 **v1.2 Claude Code Skills & Installer** - Phases 11-13 (in progress)

## Phases

<details>
<summary>✅ v1.0 MVP (Phases 1-6) - SHIPPED 2026-02-13</summary>

- [x] Phase 1: Foundation (3/3 plans) -- completed 2026-02-13
- [x] Phase 2: REST API (2/2 plans) -- completed 2026-02-13
- [x] Phase 3: CLI (2/2 plans) -- completed 2026-02-13
- [x] Phase 4: MCP Server (2/2 plans) -- completed 2026-02-13
- [x] Phase 5: Production Deployment (2/2 plans) -- completed 2026-02-13
- [x] Phase 6: Advanced Features (2/2 plans) -- completed 2026-02-13

See: [milestones/v1.0-ROADMAP.md](./milestones/v1.0-ROADMAP.md) for full details.

</details>

<details>
<summary>✅ v1.1 Interface Parity & CLI Polish (Phases 7-10) - SHIPPED 2026-02-13</summary>

- [x] Phase 7: Core CLI Infrastructure (3/3 plans) -- completed 2026-02-13
- [x] Phase 8: CLI Command Expansion (5/5 plans) -- completed 2026-02-13
- [x] Phase 9: MCP Tool Expansion (2/2 plans) -- completed 2026-02-13
- [x] Phase 10: Testing & Integration (0/0 plans, validation) -- completed 2026-02-13

See: [milestones/v1.1-ROADMAP.md](./milestones/v1.1-ROADMAP.md) for full details.

</details>

### 🚧 v1.2 Claude Code Skills & Installer (In Progress)

**Milestone Goal:** Make wood-fired-bugs accessible from any Claude Code session via curated slash command skills and a cross-platform installer.

- [ ] **Phase 11: MCP Server Verification** - Confirm stdio transport compliance
- [ ] **Phase 12: Skill File Authoring** - Create 10 workflow skills
- [ ] **Phase 13: Cross-Platform Installer** - Bash and PowerShell setup automation

### Phase 11: MCP Server Verification
**Goal**: MCP server confirmed stdio-compliant with no stdout logging violations
**Depends on**: Phase 10 (existing MCP server from v1.1)
**Requirements**: MCP-01, MCP-02
**Success Criteria** (what must be TRUE):
  1. MCP server produces only JSON-RPC on stdout (zero non-JSON output)
  2. All logging routed to stderr or log files (no console.log to stdout)
  3. Claude Code can invoke any MCP tool successfully via /mcp command
  4. Health check tool returns service status without transport errors
**Plans**: 1 plan

Plans:
- [ ] 11-01-PLAN.md — Fix stdout pollution (Umzug logger) and add automated stdio compliance tests

### Phase 12: Skill File Authoring
**Goal**: 10 curated workflow skills ready to use with verified MCP tool names
**Depends on**: Phase 11 (verified MCP server)
**Requirements**: SKILL-01, SKILL-02, SKILL-03, SKILL-04, SKILL-05, SKILL-06, SKILL-07, SKILL-08, SKILL-09, SKILL-10
**Success Criteria** (what must be TRUE):
  1. User can log a bug via /tasks:log-bug with title and description
  2. User can create a task via /tasks:create-task with project/priority/assignee options
  3. User can view assigned tasks via /tasks:my-work
  4. User can view full task details via /tasks:show-task
  5. User can search tasks by keyword via /tasks:search
  6. User can pick up a task via /tasks:pick-up (assigns to self, transitions to in_progress)
  7. User can mark task done via /tasks:done
  8. User can mark task blocked via /tasks:blocked with reason
  9. User can add comment to task via /tasks:add-comment
  10. User can view project overview via /tasks:project-status
**Plans**: TBD

Plans:
- [ ] 12-01: TBD

### Phase 13: Cross-Platform Installer
**Goal**: Bash and PowerShell installers that copy skills, configure MCP server, and validate connectivity
**Depends on**: Phase 12 (skill files exist)
**Requirements**: LINX-01, LINX-02, LINX-03, LINX-04, LINX-05, WIN-01, WIN-02, WIN-03, WIN-04, WIN-05
**Success Criteria** (what must be TRUE):
  1. Linux user can run Bash installer to set up skills and MCP config
  2. Windows user can run PowerShell installer to set up skills and MCP config
  3. Installer backs up existing Claude Code config before modification
  4. Installer merges MCP server config without breaking existing servers
  5. Installer writes API key to MCP config env section (not just shell profile)
  6. Installer validates connectivity to wood-fired-bugs service post-setup
  7. Skills are accessible in Claude Code after installer completes successfully
**Plans**: TBD

Plans:
- [ ] 13-01: TBD

## Progress

**Execution Order:**
Phases execute in numeric order: 11 → 12 → 13

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
| 11. MCP Server Verification | v1.2 | 0/TBD | Not started | - |
| 12. Skill File Authoring | v1.2 | 0/TBD | Not started | - |
| 13. Cross-Platform Installer | v1.2 | 0/TBD | Not started | - |
