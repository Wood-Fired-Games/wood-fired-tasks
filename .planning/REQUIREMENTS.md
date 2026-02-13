# Requirements: Wood Fired Bugs

**Defined:** 2026-02-13
**Core Value:** Any agent on the local network can reliably create, find, and update work items in real time — making this the single source of truth for all Wood Fired Games task tracking.

## v1 Requirements

Requirements for initial release. Each maps to roadmap phases.

### Core Task Management

- [ ] **TASK-01**: Agent or human can create a task with title, description, status, and priority
- [ ] **TASK-02**: Agent or human can retrieve a task by ID
- [ ] **TASK-03**: Agent or human can update any task field
- [ ] **TASK-04**: Agent or human can delete a task
- [ ] **TASK-05**: Tasks follow a status lifecycle (open, in_progress, done, closed, blocked)
- [ ] **TASK-06**: Tasks support optional due dates

### Organization

- [ ] **ORG-01**: Tasks belong to a project; multiple projects are supported
- [ ] **ORG-02**: Tasks can have multiple tags/labels for flexible categorization
- [ ] **ORG-03**: Tasks can be filtered by status, project, assignee, tags, and date range
- [ ] **ORG-04**: Tasks can be searched by title and description text

### Assignment

- [ ] **ASGN-01**: Tasks can be assigned to an agent or person
- [ ] **ASGN-02**: Tasks track who created them (created_by)

### REST API

- [ ] **API-01**: Full task CRUD available via REST endpoints
- [ ] **API-02**: All REST requests require API key authentication
- [ ] **API-03**: All responses are structured JSON optimized for LLM parsing
- [ ] **API-04**: OpenAPI specification is generated from route definitions
- [ ] **API-05**: Health check endpoint reports service status
- [ ] **API-06**: Error responses use machine-readable codes and structured format

### CLI

- [ ] **CLI-01**: Tasks can be created from the command line
- [ ] **CLI-02**: Tasks can be listed and searched from the command line
- [ ] **CLI-03**: Task fields and status can be updated from the command line
- [ ] **CLI-04**: CLI output is formatted for human readability

### MCP Server

- [ ] **MCP-01**: MCP server exposes tools for task CRUD (create, get, update, list)
- [ ] **MCP-02**: MCP tools share validation logic with REST API
- [ ] **MCP-03**: MCP errors are structured for agent consumption

### Relationships

- [ ] **REL-01**: Tasks support parent/child relationships (subtasks)
- [ ] **REL-02**: Tasks support dependency relationships (blocks/requires)
- [ ] **REL-03**: Circular dependencies are detected and rejected

### Collaboration

- [ ] **COLLAB-01**: Comments can be added to tasks with author and timestamp
- [ ] **COLLAB-02**: Tasks support time estimates

### Infrastructure

- [ ] **INFRA-01**: Data is stored in SQLite with WAL mode enabled
- [ ] **INFRA-02**: Database schema changes are managed via migrations
- [ ] **INFRA-03**: Service runs persistently via systemd on Ubuntu
- [ ] **INFRA-04**: Service binds to LAN interface for local network access
- [ ] **INFRA-05**: Service produces structured logs (Pino to journald)
- [ ] **INFRA-06**: Automated daily SQLite backups

## v2 Requirements

Deferred to future release. Tracked but not in current roadmap.

### Advanced Features

- **ADV-01**: Change history/audit log tracking field changes with timestamp and actor
- **ADV-02**: Bulk create/update operations accepting arrays
- **ADV-03**: Automated task linking detecting #TASK-123 mentions
- **ADV-04**: Webhooks for task events (create, update, status change)
- **ADV-05**: Task templates for common work patterns
- **ADV-06**: Dependency graph export as DOT/JSON
- **ADV-07**: Natural language query translation to filters
- **ADV-08**: Semantic search context fields for LLM-specific metadata
- **ADV-09**: Rich time tracking with multiple time entries per task

## Out of Scope

Explicitly excluded. Documented to prevent scope creep.

| Feature | Reason |
|---------|--------|
| Web UI | Agents and CLI are the interfaces; no browser needed |
| Mobile app | Local network service only |
| Real-time push notifications | Agents poll or query as needed; webhooks in v2 |
| Cloud hosting | Runs on local Ubuntu machine only |
| User accounts / multi-user auth | API key auth is sufficient for single operator + agents |
| Email integration | Not needed for LAN service |
| Gantt charts / timeline views | Low value for agent-driven workflows |
| Advanced permissions (roles, ACLs) | Unnecessary for single-operator environment |
| File attachments | Store file paths as text; agents manage files separately |
| Sprint/iteration management | Tags and filters are sufficient |
| Customizable workflows | Fixed status model; tags for flexibility |

## Traceability

Which phases cover which requirements. Updated during roadmap creation.

| Requirement | Phase | Status |
|-------------|-------|--------|
| TASK-01 | Phase 1 | Pending |
| TASK-02 | Phase 1 | Pending |
| TASK-03 | Phase 1 | Pending |
| TASK-04 | Phase 1 | Pending |
| TASK-05 | Phase 1 | Pending |
| TASK-06 | Phase 1 | Pending |
| ORG-01 | Phase 1 | Pending |
| ORG-02 | Phase 1 | Pending |
| ORG-03 | Phase 1 | Pending |
| ORG-04 | Phase 1 | Pending |
| ASGN-01 | Phase 1 | Pending |
| ASGN-02 | Phase 1 | Pending |
| INFRA-01 | Phase 1 | Pending |
| INFRA-02 | Phase 1 | Pending |
| API-01 | Phase 2 | Pending |
| API-02 | Phase 2 | Pending |
| API-03 | Phase 2 | Pending |
| API-04 | Phase 2 | Pending |
| API-05 | Phase 2 | Pending |
| API-06 | Phase 2 | Pending |
| CLI-01 | Phase 3 | Pending |
| CLI-02 | Phase 3 | Pending |
| CLI-03 | Phase 3 | Pending |
| CLI-04 | Phase 3 | Pending |
| MCP-01 | Phase 4 | Pending |
| MCP-02 | Phase 4 | Pending |
| MCP-03 | Phase 4 | Pending |
| INFRA-03 | Phase 5 | Pending |
| INFRA-04 | Phase 5 | Pending |
| INFRA-05 | Phase 5 | Pending |
| INFRA-06 | Phase 5 | Pending |
| REL-01 | Phase 6 | Pending |
| REL-02 | Phase 6 | Pending |
| REL-03 | Phase 6 | Pending |
| COLLAB-01 | Phase 6 | Pending |
| COLLAB-02 | Phase 6 | Pending |

**Coverage:**
- v1 requirements: 36 total
- Mapped to phases: 36
- Unmapped: 0

---
*Requirements defined: 2026-02-13*
*Last updated: 2026-02-13 after initial definition*
