# Feature Landscape

**Domain:** LLM-Accessible Task Tracking Service
**Researched:** 2026-02-13
**Confidence:** HIGH

## Table Stakes

Features users (LLM agents and humans) expect. Missing = product feels incomplete.

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| Task CRUD (Create, Read, Update, Delete) | Core task management requirement, every task tracker has this | LOW | Basic REST endpoints + MCP tools for create, get, update, delete operations |
| Task status tracking | Users must know if work is todo, in-progress, done, blocked | LOW | Simple state machine: open → in_progress → done/closed. Add blocked state |
| Task search and filtering | Finding specific tasks without scrolling hundreds of entries | MEDIUM | Filter by status, project, assignee, tags, date ranges. Full-text search on title/description |
| Multi-project support | Wood Fired Games has multiple projects that need separate organization | LOW | Project entity with FK on tasks. List tasks by project |
| Task assignment | Knowing who/what is working on what | LOW | assigned_to field (agent or human name), created_by field for tracking origin |
| Basic metadata (title, description, priority) | Minimum context to understand what needs doing | LOW | Text fields + priority enum (low/medium/high/urgent) |
| Due dates | Time-sensitive work needs deadlines | LOW | Optional due_date timestamp field |
| Tags/labels | Flexible categorization beyond projects | LOW | Many-to-many relationship, tags table |
| Comments/activity log | Discussion and status updates over time | MEDIUM | Comments table with FK to task, timestamp, author |
| Parent/child task relationships | Breaking down complex work into subtasks | MEDIUM | self-referential FK: parent_task_id. Query children, roll-up status |
| Task dependencies | Modeling "A blocks B" or "B requires A" relationships | MEDIUM | task_dependencies join table with type (blocks/requires/related) |
| API key authentication | LAN-accessible service needs access control | LOW | API key in header, validate before executing requests |
| CLI for humans | Human operators need terminal access | MEDIUM | Command-line interface using REST API client internally |
| Bulk operations | Agents creating/updating multiple tasks in one action | LOW | Batch create/update endpoints accepting arrays |

## Differentiators

Features that set this product apart. Not expected, but valuable for LLM-first architecture.

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| MCP server integration | Native Claude Code agent integration without REST overhead | MEDIUM | Expose tools via MCP protocol for create_task, get_task, update_task, list_tasks, add_comment |
| Structured JSON responses optimized for LLM parsing | LLMs consume structured data better than human-friendly formats | LOW | Consistent schema-driven JSON with no HTML, clear field names, no abbreviations |
| OpenAPI specification | Machine-readable API contract enables dynamic tool discovery by LLMs | LOW | Generate OpenAPI 3.0+ spec from routes, rich descriptions in schemas |
| Task templates for common patterns | Agents can spawn standardized work structures (e.g., "bug report" template) | MEDIUM | Template system with field defaults, subtask scaffolding |
| Semantic search context fields | Dedicated fields for LLM context (related files, code blocks, logs) | LOW | JSON field for structured context data agents can populate |
| Automated task linking via mentions | Detect "#TASK-123" in descriptions/comments and auto-link | LOW | Regex parsing on input, store as explicit relationship |
| Query by natural language intent | "Find all high-priority bugs assigned to Claude in wood-fired-platform" | HIGH | LLM-powered query translation to SQL filters (defer to v2+) |
| Change history/audit log | LLMs can review what changed when for debugging workflows | MEDIUM | task_history table tracking field changes with timestamp, actor |
| Webhook notifications for task events | External systems (agents, CI/CD) react to task state changes | MEDIUM | HTTP POST to registered URLs on create/update/status_change |
| Rich time tracking | Estimate vs actual time, multiple time entries | MEDIUM | time_estimate field, time_entries table for logging work |
| Dependency graph visualization endpoint | Export task graph as DOT/JSON for visualization tools | LOW | Recursive query returning nodes/edges |

## Anti-Features

Features to explicitly NOT build.

| Anti-Feature | Why Avoid | What to Do Instead |
|--------------|-----------|-------------------|
| Web UI | Scope creep, maintenance burden, not needed for agents or CLI-first human | Provide excellent CLI and document REST API for custom UIs if needed later |
| Real-time push notifications | Adds complexity (websockets/SSE), agents poll efficiently enough | Webhooks for event-driven integration, polling for status checks |
| User accounts with passwords | Overkill for single-human + agent use case, complicates auth | API key per agent/system is sufficient, simpler security model |
| Email integration | Feature bloat, external dependency, not needed for LAN service | Keep focus on API/MCP interfaces |
| Gantt charts / timeline views | Complex feature, low value for agent-driven workflows | Agents query dependency graphs and due dates to plan work |
| Advanced permission system (roles, ACLs) | Unnecessary complexity for single-operator environment | API key is sufficient access control |
| File attachments | Storage complexity, large data in DB or file management | Store file paths as text fields, let agents manage files separately |
| Built-in time tracking UI | Human-centric feature, agents track programmatically | Provide time_entries API, let CLI/agents log time as data |
| Sprint/iteration management | Agile ceremony overhead not needed for agent workflows | Use tags/filters to group tasks, let agents organize work their way |
| Customizable workflows | Over-engineering, adds UI complexity | Fixed, sensible state machine; tags for custom categorization |

## Feature Dependencies

```
Task CRUD (base requirement)
    ├──requires──> SQLite database schema
    ├──requires──> REST API framework
    └──requires──> API key auth

MCP server
    ├──requires──> Task CRUD endpoints
    └──requires──> MCP protocol implementation

Task search/filtering
    └──requires──> Task CRUD

Parent/child relationships
    ├──requires──> Task CRUD
    └──enhances──> Task search (filter by hierarchy)

Task dependencies
    ├──requires──> Task CRUD
    └──conflicts──> Circular dependency detection needed

Comments/activity log
    └──requires──> Task CRUD

Change history/audit log
    └──requires──> Task CRUD + database triggers or application-level tracking

Webhooks
    ├──requires──> Task CRUD
    └──requires──> Event system for state changes

Task templates
    └──requires──> Task CRUD + parent/child relationships

Automated task linking
    └──requires──> Task CRUD + comments

CLI
    ├──requires──> REST API
    └──optional──> MCP server for direct integration

OpenAPI spec
    └──requires──> REST API routes defined

Bulk operations
    └──requires──> Task CRUD
```

### Dependency Notes

- **Task CRUD is foundational** — everything depends on basic create/read/update/delete operations working correctly
- **MCP server enhances REST API** — both provide task access, MCP optimized for Claude Code integration
- **Parent/child + dependencies** — both model task relationships but serve different purposes (decomposition vs sequencing)
- **Circular dependency detection required** — if task A depends on task B which depends on task A, system must reject or warn
- **Audit log vs comments** — audit log is machine tracking, comments are intentional communication
- **Webhooks enable event-driven workflows** — agents can react to task changes without polling

## MVP Definition

### Launch With (v1.0)

Minimum viable product to validate LLM-agent task tracking concept.

- [x] Task CRUD via REST API — Core functionality for creating, reading, updating, deleting tasks
- [x] Task model: title, description, status, priority, project, assignee, created_by, due_date
- [x] Multi-project support — Separate Wood Fired Games projects cleanly
- [x] Tags/labels — Flexible categorization
- [x] Task search and filtering — Find tasks by status, project, assignee, tags
- [x] API key authentication — Secure LAN service
- [x] MCP server with basic tools — Native Claude Code integration (create_task, get_task, update_task, list_tasks)
- [x] CLI for human use — Stuart can manage tasks from terminal
- [x] OpenAPI specification — Machine-readable API contract for LLM discovery
- [x] Structured JSON optimized for LLM parsing — Clear schemas, no ambiguity

### Add After Validation (v1.x)

Features to add once core is working and validated with agent workflows.

- [ ] Parent/child task relationships — Task decomposition (wait for agents to request subtask workflows)
- [ ] Task dependencies (blocks/requires) — Sequencing work (add when agents need to model complex workflows)
- [ ] Comments/activity log — Communication on tasks (add when multi-agent collaboration emerges)
- [ ] Change history/audit log — Track who changed what when (useful for debugging agent behaviors)
- [ ] Bulk operations — Batch create/update for efficiency (add if agents frequently create task sets)
- [ ] Automated task linking via mentions — Detect #TASK-123 references (convenience feature)
- [ ] Time tracking (estimate, actual) — Work measurement (if agents start providing time data)

### Future Consideration (v2+)

Features to defer until product-market fit is established and usage patterns clarify.

- [ ] Webhooks for task events — Event-driven integration (requires clear external integration use cases)
- [ ] Task templates — Standardized work patterns (wait to observe common task structures)
- [ ] Dependency graph visualization — Export task relationships as graphs (nice-to-have, not critical)
- [ ] Natural language query translation — "Find all bugs in project X" → SQL (high complexity, unclear value)
- [ ] Semantic search context fields — Structured LLM context storage (experimental, needs validation)
- [ ] Rich time tracking with entries — Detailed work logging (unclear if agents/human need this granularity)

## Feature Prioritization Matrix

| Feature | User Value | Implementation Cost | Priority |
|---------|------------|---------------------|----------|
| Task CRUD via REST | HIGH | LOW | P1 |
| MCP server integration | HIGH | MEDIUM | P1 |
| Task search/filtering | HIGH | MEDIUM | P1 |
| Multi-project support | HIGH | LOW | P1 |
| API key auth | HIGH | LOW | P1 |
| CLI | HIGH | MEDIUM | P1 |
| OpenAPI spec | HIGH | LOW | P1 |
| Tags/labels | MEDIUM | LOW | P1 |
| Due dates | MEDIUM | LOW | P1 |
| Parent/child relationships | MEDIUM | MEDIUM | P2 |
| Task dependencies | MEDIUM | MEDIUM | P2 |
| Comments | MEDIUM | MEDIUM | P2 |
| Audit log | MEDIUM | MEDIUM | P2 |
| Bulk operations | MEDIUM | LOW | P2 |
| Automated linking | LOW | LOW | P2 |
| Time tracking | LOW | MEDIUM | P2 |
| Webhooks | LOW | MEDIUM | P3 |
| Task templates | LOW | MEDIUM | P3 |
| Dependency graph export | LOW | LOW | P3 |
| NL query translation | LOW | HIGH | P3 |

**Priority key:**
- P1: Must have for launch (validate LLM-agent integration)
- P2: Should have, add based on usage patterns (enhance workflows)
- P3: Nice to have, future consideration (wait for clear demand)

## Competitor Feature Analysis

| Feature | Jira | Linear | GitHub Issues | Wood Fired Bugs Approach |
|---------|------|--------|---------------|--------------------------|
| Task CRUD | Full-featured | Streamlined | Basic | Streamlined, LLM-optimized JSON |
| API access | REST + GraphQL | GraphQL | REST + GraphQL | REST (simple) + MCP (native) |
| Multi-project | Yes (complex) | Yes (clean) | Per-repo only | Yes, simple project FK |
| Parent/child tasks | Subtasks, epics | Yes | Tasklists | Simple parent_task_id FK |
| Dependencies | Links, blocks | Dependencies | Not native | blocks/requires relationship types |
| Search/filter | Advanced JQL | Fast, minimal | Basic | Filter by key fields, full-text on title/desc |
| CLI | Third-party | Official CLI | gh CLI | Built-in, first-class |
| LLM integration | None native | None native | None native | **MCP server, structured JSON, OpenAPI** |
| Auth | OAuth, users | OAuth, users | OAuth, users | **API keys (simpler)** |
| Comments | Rich, @mentions | Threaded | Comments + reactions | Simple comment log |
| Time tracking | Built-in | Via integrations | Not native | Estimate + actual (optional) |
| Webhooks | Yes | Yes | Yes | Planned for v2+ |
| Web UI | Complex, powerful | Fast, minimal | Integrated with code | **None (anti-feature)** |
| Self-hosted | Yes (expensive) | No | GitHub Enterprise | **Yes, SQLite on LAN** |

### Competitive Positioning

**Jira:** Over-engineered for single-operator + agents. Complex UI, heavyweight, requires database server.
**Linear:** Modern, fast, but cloud-only and human-centric UI. No native LLM integration.
**GitHub Issues:** Tightly coupled to repos. Not suitable for multi-project game studio work tracking.

**Wood Fired Bugs:** LLM-first architecture with MCP, simple self-hosted SQLite service, API-key auth, no UI bloat. Optimized for agent consumption with structured JSON and OpenAPI.

## Sources

### Task Tracking Ecosystem
- [13 best issue tracking software tools for 2026](https://www.zendesk.com/service/help-desk-software/issue-tracking-software/)
- [10 Most Effective Issue Tracking Software Tools in 2026](https://www.cflowapps.com/issue-tracking-software-tools/)
- [Linear vs Jira: A 2026 Guide](https://everhour.com/blog/linear-vs-jira/)
- [Jira vs GitHub Issues](https://www.atlassian.com/software/jira/comparison/jira-vs-github)
- [Jira vs Linear vs GitHub Issues in 2025](https://medium.com/@samurai.stateless.coder/jira-vs-linear-vs-github-issues-in-2025-what-real-web-dev-teams-actually-use-and-why-d808740317e6)

### API-First Design
- [Best Task Management Software with API 2026](https://www.getapp.com/project-management-planning-software/task-management/f/api/)
- [API Governance Best Practices for 2026](https://treblle.com/blog/api-governance-best-practices)
- [Guide to Project Management APIs](https://www.merge.dev/blog/guide-to-project-management-apis)

### LLM Integration
- [Designing APIs for LLM Apps](https://www.gravitee.io/blog/designing-apis-for-llm-apps)
- [RestGPT: Connecting LLMs with RESTful APIs](https://restgpt.github.io/)
- [Multi-Agent Multi-LLM Systems Guide 2026](https://dasroot.net/posts/2026/02/multi-agent-multi-llm-systems-future-ai-architecture-guide-2026/)
- [The Complete Guide to LLM & AI Agent Evaluation in 2026](https://www.adaline.ai/blog/complete-guide-llm-ai-agent-evaluation-2026)

### MCP Protocol
- [Model Context Protocol Specification](https://modelcontextprotocol.io/specification/2025-11-25)
- [Model Context Protocol - Anthropic](https://www.anthropic.com/news/model-context-protocol)
- [Top 10 MCP Servers in 2026](https://www.intuz.com/blog/best-mcp-servers)
- [How MCP Servers Enable Cross-Platform AI Integration 2026](https://goldeneagle.ai/blog/artificial-intelligence/mcp-servers-cross-platform-ai-2026/)

### Task Dependencies & Relationships
- [What are task dependencies and how to manage them](https://activecollab.com/blog/project-management/task-dependencies-for-better-project-management)
- [Jira Issue Links and dependencies management](https://bigpicture.one/blog/jira-bigpicture-dependencies/)
- [Parent-Child Relationships - Google Issue Tracker](https://developers.google.com/issue-tracker/concepts/parent-child-relationships)

### Anti-Patterns
- [Sprint Anti-Patterns: 29 Examples to Avoid](https://age-of-product.com/sprint-anti-patterns-2/)
- [25+ Anti-patterns of Sprint Planning](https://agilemania.com/anti-patterns-of-sprint-planning-task-creation)
- [Eight project management anti-patterns and how to avoid them](https://www.catalyte.io/insights/project-management-anti-patterns/)

### MVP Principles
- [How to Prioritize and Identify Key Features for Your MVP](https://www.lowcode.agency/blog/how-to-choose-mvp-features)
- [How to Build a Task Management App [2026 Guide]](https://www.freshcodeit.com/blog/how-to-create-task-management-app-mvp)
- [How to Define Your MVP's Core Features](https://designli.co/blog/how-to-define-your-mvps-core-features)

---
*Feature research for: Wood Fired Bugs (LLM-Accessible Task Tracking Service)*
*Researched: 2026-02-13*
