# Roadmap: Wood Fired Bugs

## Overview

Wood Fired Bugs delivers an LLM-accessible task tracking service for Wood Fired Games in six phases. We start by building the data layer and business logic that all interfaces share, then expose that through REST API, CLI, and MCP server in succession. Production deployment hardens the service for always-on LAN operation, and advanced features round out the task model with relationships, comments, and time estimates.

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [ ] **Phase 1: Foundation** - Database schema, repositories, and service layer for core task management
- [ ] **Phase 2: REST API** - Fastify server exposing task operations with auth, validation, and OpenAPI
- [ ] **Phase 3: CLI** - Command-line interface for human task management
- [ ] **Phase 4: MCP Server** - Model Context Protocol server for native LLM agent integration
- [ ] **Phase 5: Production Deployment** - systemd service, LAN binding, logging, and backups
- [ ] **Phase 6: Advanced Features** - Task relationships, dependencies, comments, and time estimates

## Phase Details

### Phase 1: Foundation
**Goal**: A working data layer and service API that can create, query, update, and delete tasks across multiple projects -- the shared engine all interfaces will call
**Depends on**: Nothing
**Requirements**: TASK-01, TASK-02, TASK-03, TASK-04, TASK-05, TASK-06, ORG-01, ORG-02, ORG-03, ORG-04, ASGN-01, ASGN-02, INFRA-01, INFRA-02
**Success Criteria** (what must be TRUE):
  1. A task can be created with title, description, status, priority, project, assignee, tags, and due date -- and retrieved by ID with all fields intact
  2. A task's status follows the defined lifecycle (open, in_progress, done, closed, blocked) and rejects invalid transitions
  3. Tasks can be filtered by any combination of status, project, assignee, tags, and date range -- and searched by title/description text
  4. Multiple projects exist and every task belongs to exactly one project
  5. The SQLite database uses WAL mode, applies schema via migrations, and handles concurrent access without SQLITE_BUSY errors
**Plans**: 3 plans

Plans:
- [ ] 01-01: Database schema, migrations, and SQLite configuration (WAL mode, pragmas, indexes)
- [ ] 01-02: Repository layer for tasks, projects, tags, and assignments
- [ ] 01-03: Service layer with business logic, validation, filtering, and search

### Phase 2: REST API
**Goal**: Any HTTP client on the LAN can perform full task management through authenticated, well-documented JSON endpoints
**Depends on**: Phase 1
**Requirements**: API-01, API-02, API-03, API-04, API-05, API-06
**Success Criteria** (what must be TRUE):
  1. All task CRUD operations work via REST endpoints (POST, GET, PUT/PATCH, DELETE) and return structured JSON that an LLM can parse without ambiguity
  2. Every request without a valid API key is rejected with a 401 response
  3. Invalid requests return structured error responses with machine-readable error codes (not stack traces or HTML)
  4. An OpenAPI specification is generated from route definitions and accurately describes all endpoints
  5. A health check endpoint returns service status and is reachable without authentication
**Plans**: 2 plans

Plans:
- [ ] 02-01: Fastify server, task CRUD routes, and API key authentication middleware
- [ ] 02-02: Request/response validation (Zod schemas), structured errors, OpenAPI generation, and health check

### Phase 3: CLI
**Goal**: Stuart can manage tasks from the terminal without touching curl or JSON
**Depends on**: Phase 2
**Requirements**: CLI-01, CLI-02, CLI-03, CLI-04
**Success Criteria** (what must be TRUE):
  1. A task can be created from the command line with a single command specifying title, project, and optional fields
  2. Tasks can be listed with filters (status, project, assignee) and searched by text -- results display in a readable table
  3. A task's status, assignee, priority, and other fields can be updated from the command line by task ID
  4. All CLI output is formatted for human readability with aligned columns, color, and clear labels (not raw JSON)
**Plans**: 2 plans

Plans:
- [ ] 03-01: Commander.js setup, create/list/search/update task commands
- [ ] 03-02: Output formatting with tables, color, and human-friendly display

### Phase 4: MCP Server
**Goal**: Claude Code and other MCP-capable agents can natively create, query, and update tasks without HTTP knowledge
**Depends on**: Phase 1 (shares service layer; does not depend on REST API)
**Requirements**: MCP-01, MCP-02, MCP-03
**Success Criteria** (what must be TRUE):
  1. An MCP client can call tools for create_task, get_task, update_task, and list_tasks -- and receive structured results
  2. MCP tool inputs are validated using the same rules as the REST API (shared Zod schemas) so both interfaces reject the same invalid data
  3. MCP errors return structured, agent-readable responses with error codes (not unhandled exceptions or opaque messages)
**Plans**: 2 plans

Plans:
- [ ] 04-01: MCP server setup and tool definitions (create, get, update, list, delete)
- [ ] 04-02: Transport configuration, shared validation integration, and structured error handling

### Phase 5: Production Deployment
**Goal**: The service runs persistently on the Ubuntu LAN machine, survives reboots, and protects data with automated backups
**Depends on**: Phase 2 (REST server must exist to deploy; Phase 3/4 can deploy alongside)
**Requirements**: INFRA-03, INFRA-04, INFRA-05, INFRA-06
**Success Criteria** (what must be TRUE):
  1. The service starts automatically on boot via systemd and restarts on failure without manual intervention
  2. The service binds to the LAN interface and is reachable from other machines on the local network
  3. Structured logs (JSON via Pino) flow to journald and can be queried with journalctl
  4. SQLite database is automatically backed up daily to a separate location, and a backup can be restored
**Plans**: 2 plans

Plans:
- [ ] 05-01: systemd unit file, environment configuration, and LAN network binding
- [ ] 05-02: Pino structured logging to journald and automated daily SQLite backup script

### Phase 6: Advanced Features
**Goal**: Tasks can be organized into hierarchies with dependencies, annotated with comments, and estimated for effort
**Depends on**: Phase 1 (extends core task model)
**Requirements**: REL-01, REL-02, REL-03, COLLAB-01, COLLAB-02
**Success Criteria** (what must be TRUE):
  1. A task can have child tasks (subtasks), and querying a parent task shows its children
  2. A task can be marked as blocking or required-by another task, and circular dependency chains are detected and rejected
  3. Comments can be added to a task with author and timestamp, and retrieved in chronological order
  4. A task can have a time estimate, and the estimate is returned in task queries
**Plans**: 2 plans

Plans:
- [ ] 06-01: Parent/child relationships and dependency tracking with cycle detection
- [ ] 06-02: Comments system and time estimates

## Progress

**Execution Order:**
Phases execute in numeric order: 1 -> 2 -> 3 -> 4 -> 5 -> 6

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Foundation | 0/3 | Not started | - |
| 2. REST API | 0/2 | Not started | - |
| 3. CLI | 0/2 | Not started | - |
| 4. MCP Server | 0/2 | Not started | - |
| 5. Production Deployment | 0/2 | Not started | - |
| 6. Advanced Features | 0/2 | Not started | - |
