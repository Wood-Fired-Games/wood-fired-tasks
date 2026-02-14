# Requirements: Wood Fired Bugs

**Defined:** 2026-02-13
**Core Value:** Any agent on the local network can reliably create, find, and update work items in real time — making this the single source of truth for all Wood Fired Games task tracking.

## v1.2 Requirements

Requirements for v1.2 Claude Code Skills & Installer. Each maps to roadmap phases.

### MCP Compliance

- [x] **MCP-01**: MCP server stdio transport produces only JSON-RPC on stdout (no logging)
- [x] **MCP-02**: MCP server passes end-to-end tool invocation test via Claude Code

### Skills

- [ ] **SKILL-01**: User can log a bug via /tasks:log-bug with title and optional description
- [ ] **SKILL-02**: User can create a task via /tasks:create-task with project, priority, and assignee options
- [ ] **SKILL-03**: User can view their assigned tasks via /tasks:my-work
- [ ] **SKILL-04**: User can view full task details via /tasks:show-task with task ID
- [ ] **SKILL-05**: User can search tasks by keyword via /tasks:search
- [ ] **SKILL-06**: User can pick up a task via /tasks:pick-up (assigns to self, sets in_progress)
- [ ] **SKILL-07**: User can mark a task done via /tasks:done with task ID
- [ ] **SKILL-08**: User can mark a task blocked via /tasks:blocked with reason
- [ ] **SKILL-09**: User can add a comment to a task via /tasks:add-comment
- [ ] **SKILL-10**: User can view project overview via /tasks:project-status

### Installer — Linux

- [ ] **LINX-01**: Bash installer copies skill files to ~/.claude/commands/tasks/
- [ ] **LINX-02**: Bash installer merges MCP server config into Claude Code settings preserving existing servers
- [ ] **LINX-03**: Bash installer writes API key to MCP config env section
- [ ] **LINX-04**: Bash installer backs up existing Claude Code config before modification
- [ ] **LINX-05**: Bash installer validates connectivity to wood-fired-bugs service after setup

### Installer — Windows

- [ ] **WIN-01**: PowerShell installer copies skill files to appropriate Windows location
- [ ] **WIN-02**: PowerShell installer merges MCP server config into Claude Code settings preserving existing servers
- [ ] **WIN-03**: PowerShell installer merges API key to MCP config env section
- [ ] **WIN-04**: PowerShell installer backs up existing Claude Code config before modification
- [ ] **WIN-05**: PowerShell installer validates connectivity to wood-fired-bugs service after setup

## Future Requirements

Deferred to future release. Tracked but not in current roadmap.

### Skills — Extended

- **SKILL-11**: User can perform batch status changes on multiple tasks
- **SKILL-12**: Skills auto-invoke based on conversation context via rich descriptions

### Installer — Extended

- **INST-01**: Installer supports dry run mode showing changes without applying
- **INST-02**: Uninstaller removes skills, cleans up config, removes env var

## Out of Scope

Explicitly excluded. Documented to prevent scope creep.

| Feature | Reason |
|---------|--------|
| GUI installer | Developer tool for LLM agents; target users are CLI-comfortable |
| Auto-update checker in skills | Adds latency on every invocation; users control their environment |
| Single "do-everything" skill | Loses discoverability; violates single-responsibility |
| REST API fallback in skills | Skills assume MCP is configured; installer validates this |
| Embedded API key in skills | Security anti-pattern; skills are plain text visible in backups |
| Auto-generated skills from OpenAPI | Generic skills don't capture workflow intent; curated > generated |
| Plugin marketplace packaging | Validate manual install first; marketplace is v2+ |

## Traceability

Which phases cover which requirements. Updated during roadmap creation.

| Requirement | Phase | Status |
|-------------|-------|--------|
| MCP-01 | Phase 11 | Complete |
| MCP-02 | Phase 11 | Complete |
| SKILL-01 | Phase 12 | Pending |
| SKILL-02 | Phase 12 | Pending |
| SKILL-03 | Phase 12 | Pending |
| SKILL-04 | Phase 12 | Pending |
| SKILL-05 | Phase 12 | Pending |
| SKILL-06 | Phase 12 | Pending |
| SKILL-07 | Phase 12 | Pending |
| SKILL-08 | Phase 12 | Pending |
| SKILL-09 | Phase 12 | Pending |
| SKILL-10 | Phase 12 | Pending |
| LINX-01 | Phase 13 | Pending |
| LINX-02 | Phase 13 | Pending |
| LINX-03 | Phase 13 | Pending |
| LINX-04 | Phase 13 | Pending |
| LINX-05 | Phase 13 | Pending |
| WIN-01 | Phase 13 | Pending |
| WIN-02 | Phase 13 | Pending |
| WIN-03 | Phase 13 | Pending |
| WIN-04 | Phase 13 | Pending |
| WIN-05 | Phase 13 | Pending |

**Coverage:**
- v1.2 requirements: 22 total
- Mapped to phases: 22
- Unmapped: 0 ✓

---
*Requirements defined: 2026-02-13*
*Last updated: 2026-02-13 after roadmap creation*
