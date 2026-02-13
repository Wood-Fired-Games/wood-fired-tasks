# Requirements: Wood Fired Bugs

**Defined:** 2026-02-13
**Core Value:** Any agent on the local network can reliably create, find, and update work items in real time — making this the single source of truth for all Wood Fired Games task tracking.

## v1.1 Requirements

Requirements for interface parity and CLI polish. Each maps to roadmap phases.

### CLI Infrastructure

- [ ] **INFRA-01**: All CLI commands support `--json` flag for machine-readable JSON output with consistent envelope format
- [ ] **INFRA-02**: CLI uses output abstraction (data to stdout, messages to stderr) to prevent JSON contamination
- [ ] **INFRA-03**: CLI prompts interactively for missing required fields when stdin is a TTY
- [ ] **INFRA-04**: CLI supports `--no-input` flag to disable interactive prompts and fail on missing fields
- [ ] **INFRA-05**: CLI shows confirmation prompt before destructive actions (delete) unless `--force` is set

### CLI Commands

- [ ] **CMD-01**: User can delete a task via `tasks delete <id>`
- [ ] **CMD-02**: User can view task details via `tasks show <id>`
- [ ] **CMD-03**: User can create a project via `tasks project-create`
- [ ] **CMD-04**: User can list projects via `tasks project-list`
- [ ] **CMD-05**: User can view project details via `tasks project-show <id>`
- [ ] **CMD-06**: User can update a project via `tasks project-update <id>`
- [ ] **CMD-07**: User can delete a project via `tasks project-delete <id>`
- [ ] **CMD-08**: User can add a dependency via `tasks dep-add <id> <blocks-id>`
- [ ] **CMD-09**: User can remove a dependency via `tasks dep-remove <id> <blocks-id>`
- [ ] **CMD-10**: User can list dependencies via `tasks dep-list <id>`
- [ ] **CMD-11**: User can add a comment via `tasks comment-add <id>`
- [ ] **CMD-12**: User can list comments via `tasks comment-list <id>`
- [ ] **CMD-13**: User can delete a comment via `tasks comment-delete <id>`
- [ ] **CMD-14**: User can create a subtask via `tasks subtask-create <parent-id>`
- [ ] **CMD-15**: User can list subtasks via `tasks subtask-list <parent-id>`
- [ ] **CMD-16**: User can check service health via `tasks health`

### MCP Tools

- [ ] **MCP-01**: Agent can create a project via `create_project` MCP tool
- [ ] **MCP-02**: Agent can get a project via `get_project` MCP tool
- [ ] **MCP-03**: Agent can list projects via `list_projects` MCP tool
- [ ] **MCP-04**: Agent can update a project via `update_project` MCP tool
- [ ] **MCP-05**: Agent can delete a project via `delete_project` MCP tool
- [ ] **MCP-06**: Agent can check service health via `check_health` MCP tool
- [ ] **MCP-07**: Agent can list subtasks via `list_subtasks` MCP tool

### CLI Polish

- [ ] **UX-01**: All CLI table output uses color-coded statuses and priorities with improved column formatting
- [ ] **UX-02**: CLI respects `NO_COLOR` environment variable to disable colors
- [ ] **UX-03**: All existing CLI commands (create, list, update) retrofitted with `--json` support

## v2 Requirements

Deferred to future release. Tracked but not in current roadmap.

### CLI Enhancements

- **CLI-F01**: User can run batch operations (`tasks update --status done --ids 1,2,3`)
- **CLI-F02**: User can set defaults via config file (`~/.wfbrc`)
- **CLI-F03**: User can use shell completions (bash/zsh tab completion)
- **CLI-F04**: CLI suggests corrections on typos ("Did you mean 'tasks list'?")
- **CLI-F05**: CLI infers project from `.wfb-project` file in current directory

### MCP Enhancements

- **MCP-F01**: Agent receives rich error context in structuredContent (error_code, validation_failures)
- **MCP-F02**: Agent can run batch tool execution (array of operations in single call)

## Out of Scope

| Feature | Reason |
|---------|--------|
| CLI arbitrary command abbreviations | Prevents adding new commands later; use shell aliases instead |
| CLI auto-update checking | Network I/O on every command slows startup; manual update is fine |
| CLI pagination | Users can pipe to `less` or use filters; avoids complexity |
| CLI --verbose flag | Use `DEBUG=wfb:*` environment variable instead; keeps output clean |
| MCP single "do_everything" tool | Agents can't discover capabilities; keep tools granular |
| Web UI | Agents and CLI are the interfaces for now |

## Traceability

Which phases cover which requirements. Updated during roadmap creation.

| Requirement | Phase | Status |
|-------------|-------|--------|
| INFRA-01 | — | Pending |
| INFRA-02 | — | Pending |
| INFRA-03 | — | Pending |
| INFRA-04 | — | Pending |
| INFRA-05 | — | Pending |
| CMD-01 | — | Pending |
| CMD-02 | — | Pending |
| CMD-03 | — | Pending |
| CMD-04 | — | Pending |
| CMD-05 | — | Pending |
| CMD-06 | — | Pending |
| CMD-07 | — | Pending |
| CMD-08 | — | Pending |
| CMD-09 | — | Pending |
| CMD-10 | — | Pending |
| CMD-11 | — | Pending |
| CMD-12 | — | Pending |
| CMD-13 | — | Pending |
| CMD-14 | — | Pending |
| CMD-15 | — | Pending |
| CMD-16 | — | Pending |
| MCP-01 | — | Pending |
| MCP-02 | — | Pending |
| MCP-03 | — | Pending |
| MCP-04 | — | Pending |
| MCP-05 | — | Pending |
| MCP-06 | — | Pending |
| MCP-07 | — | Pending |
| UX-01 | — | Pending |
| UX-02 | — | Pending |
| UX-03 | — | Pending |

**Coverage:**
- v1.1 requirements: 31 total
- Mapped to phases: 0
- Unmapped: 31

---
*Requirements defined: 2026-02-13*
*Last updated: 2026-02-13 after initial definition*
