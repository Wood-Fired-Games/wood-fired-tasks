# Research Summary: Wood Fired Bugs

**Domain:** LLM-Accessible Task Tracking Service
**Researched:** 2026-02-13
**Overall confidence:** HIGH

## Executive Summary

Wood Fired Bugs is an API-first task tracking service optimized for LLM agent consumption. The research validates this as a greenfield opportunity with clear differentiation: existing task trackers (Jira, Linear, GitHub Issues) are human-centric with web UIs, lacking native LLM integration. This project fills the gap by providing MCP server integration, structured JSON responses, and OpenAPI specifications that enable agents to discover and use the API programmatically.

The recommended stack (Node.js 22 with TypeScript, Fastify, SQLite via better-sqlite3, MCP TypeScript SDK) aligns with the LLM-first architecture goals. Node.js 22's native SQLite support and the MCP SDK's maturity make this a proven, production-ready foundation. The layered architecture (Interface → Service → Repository → Database) enables sharing business logic across three interfaces: REST API, MCP server, and CLI.

Critical success factors identified through research:
1. **SQLite WAL mode + write queuing** to handle concurrent agent writes without SQLITE_BUSY errors
2. **Schema-driven validation** with Zod for predictable LLM consumption
3. **Structured error responses** with machine-readable error codes for agent error handling
4. **Cycle detection** in dependency graphs to prevent impossible task states

The feature landscape research reveals a lean MVP: focus on core CRUD, filtering, multi-project support, and dual interfaces (REST + MCP). Defer complex features like parent/child relationships, webhooks, and natural language query translation until usage patterns emerge. Anti-features clearly identified: no web UI, no real-time sync (polling suffices), no custom workflows (simple status model with tags for flexibility).

## Key Findings

**Stack:** Node.js 22 + TypeScript + Fastify for REST, MCP TypeScript SDK for agent integration, better-sqlite3 for zero-config local storage, systemd for Ubuntu service management

**Architecture:** Layered architecture with shared service layer across REST/MCP/CLI interfaces. Repository pattern for database abstraction. Single-writer queue pattern for SQLite concurrency.

**Critical pitfall:** SQLite write lock contention kills multi-agent workflows. Mitigation required from day one: WAL mode, write queuing, busy timeout configuration.

## Implications for Roadmap

Based on research, suggested phase structure:

### Phase 1: Foundation (Database + Core Services)
**Rationale:** Cannot build interfaces without working data layer. Services must be shared across REST/MCP/CLI to avoid duplication.

**Addresses:**
- Database schema with migrations (Drizzle Kit or raw SQL)
- Core domain models (Task, Project, Tag, Comment)
- Repository pattern implementation
- Service layer with business logic
- SQLite optimization (WAL mode, indexes, pragmas)

**Avoids:**
- Pitfall: Missing migration strategy
- Pitfall: Over-normalized schema

**Duration:** 3-5 days

---

### Phase 2: REST API
**Rationale:** Easiest interface to build and test first. Validates service layer design. OpenAPI spec becomes documentation for MCP and CLI.

**Addresses:**
- Fastify REST server with routes
- API key authentication middleware
- Request validation with Zod schemas
- OpenAPI spec generation
- Error handling with structured responses
- Health check endpoint

**Avoids:**
- Pitfall: Business logic in route handlers
- Pitfall: Unstructured error responses
- Pitfall: No health check

**Duration:** 4-6 days

---

### Phase 3: CLI
**Rationale:** Validates that service layer is truly reusable. Provides human interface for testing and debugging. Builds confidence before tackling MCP.

**Addresses:**
- Commander.js CLI framework
- HTTP client calling REST API
- Pretty terminal output with Rich/Chalk
- Subcommands: task create/list/update, project list, tag management

**Avoids:**
- Pitfall: CLI duplicating business logic
- Anti-pattern: Reimplementing validation

**Duration:** 2-3 days

---

### Phase 4: MCP Server Integration
**Rationale:** Core differentiator. Enables Claude Code native integration. Builds on proven REST API and service layer.

**Addresses:**
- MCP TypeScript SDK integration
- Tool definitions (create_task, get_task, update_task, list_tasks, add_comment)
- Zod schema reuse from REST API
- JSON-RPC transport configuration
- Error handling adapted for MCP protocol

**Avoids:**
- Pitfall: Duplicating business logic
- Pitfall: Inconsistent validation

**Duration:** 3-4 days

---

### Phase 5: Production Deployment
**Rationale:** Real-world testing requires running as persistent service. Deployment complexity isolated from development work.

**Addresses:**
- systemd service configuration
- Environment variable management (dotenvx)
- Automated backups (daily SQLite file copy)
- Logging with Pino to journald
- LAN network binding

**Avoids:**
- Pitfall: Running in tmux/screen
- Pitfall: No backup strategy

**Duration:** 2-3 days

---

### Phase 6: Advanced Features (v1.x - Post-Launch)
**Rationale:** Validate core functionality with real agent usage before building complex features. Let usage patterns guide priorities.

**Deferred features:**
- Parent/child task relationships
- Task dependencies (blocks/requires)
- Comments and activity log
- Change history/audit log
- Bulk operations
- Time tracking

**Research flag:** Dependency cycle detection is HIGH complexity. Requires graph traversal algorithm (DFS) and thorough testing. Budget extra time if dependencies are prioritized.

---

## Phase Ordering Rationale

**Why Database First:** All interfaces depend on working data layer. Services must exist before routes/tools/commands can call them.

**Why REST Before MCP:** REST is more familiar, easier to test with curl/Postman. OpenAPI spec generated from REST routes informs MCP tool schemas. Debugging is simpler without JSON-RPC layer.

**Why CLI Third:** Validates service reusability across different interfaces. Catches service design flaws before MCP integration. Provides debugging tool for production issues.

**Why MCP After REST+CLI:** MCP is core value but highest risk. Building on proven service layer reduces risk. If MCP integration has issues, REST and CLI still work.

**Why Deployment Last:** Production environment config shouldn't block development. Can test locally with `npm run dev` throughout phases 1-4.

## Research Flags for Phases

**Phase 1: Database Schema**
- Standard patterns, unlikely to need research
- SQLite documentation is excellent
- Migration tools (Drizzle Kit) are well-documented

**Phase 2: REST API**
- Standard patterns, unlikely to need research
- Fastify documentation covers all use cases
- OpenAPI generation is automatic

**Phase 3: CLI**
- Standard patterns, unlikely to need research
- Commander.js examples cover Git-style subcommands

**Phase 4: MCP Server**
- **Likely needs deeper research**
- MCP TypeScript SDK is new (v1.x in 2026), fewer examples than REST frameworks
- Tool schema design for LLM consumption may require iteration
- Error handling patterns for MCP are less established than REST
- stdio vs SSE transport decision needs validation

**Phase 5: Deployment**
- Standard patterns, unlikely to need research
- systemd service files well-documented
- Ubuntu LAN binding is straightforward

**Phase 6: Advanced Features**
- **Dependency cycle detection needs deeper research**
- Graph algorithms (DFS, topological sort) require careful implementation
- Testing complex dependency chains is time-consuming
- Parent/child relationships may have subtle edge cases

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | Node.js 22 + Fastify + SQLite recommended by recent 2025-2026 sources. MCP TypeScript SDK production-ready. |
| Features | HIGH | Feature landscape validated against Jira/Linear/GitHub Issues. Table stakes vs differentiators clearly identified from multiple sources. |
| Architecture | HIGH | Layered architecture pattern proven across 10+ sources. Repository pattern, dependency injection standard for Node.js services. |
| Pitfalls | HIGH | SQLite concurrency issues documented extensively. API design for LLMs validated by recent research (RestGPT, Gravitee). |

## Gaps to Address

### Not Fully Researched

**MCP Tool Design Patterns:**
- **Gap:** Limited examples of MCP tools for task management. Most MCP servers expose file systems, databases, or external APIs.
- **Action:** Phase 4 may require experimentation with tool schemas. Follow MCP best practices documentation closely.

**Dependency Graph Visualization:**
- **Gap:** Unclear if agents need graph export functionality.
- **Action:** Defer to v2+. Wait for agent usage patterns to clarify value.

**Natural Language Query Translation:**
- **Gap:** Feasibility unclear. LLMs might generate filter parameters directly, making NL translation unnecessary.
- **Action:** Mark as v2+ experimental feature. Test whether agents struggle with structured filters before building.

### Explicitly Out of Scope (Per PROJECT.md)

- Web UI implementation
- Mobile app development
- Cloud hosting strategies
- Multi-user authentication systems
- Real-time push notification infrastructure

## Technology Decision Rationale

### Why Node.js Over Python?

Node.js 22 chosen over Python based on:
1. **Native SQLite support** in Node.js 22.5.0+ reduces dependencies
2. **MCP TypeScript SDK maturity** - production-ready v1.x with official support
3. **Fastify performance** - 2.7x faster than Express, built-in schema validation
4. **Single-language stack** - TypeScript for REST, MCP, CLI simplifies development
5. **better-sqlite3** is faster and more mature than Python's sqlite3

Python (FastAPI) would work well but adds language context-switching overhead for Stuart as primary developer.

### Why Fastify Over Express?

Fastify chosen over Express based on:
1. **Performance:** 2.7x faster (45k vs 15k req/sec) matters for multi-agent load
2. **Auto-gen OpenAPI:** Built-in schema validation generates OpenAPI spec automatically
3. **Modern architecture:** HTTP/2, async/await native, plugin system
4. **Type safety:** First-class TypeScript support

Express is proven but stagnant. Fastify is modern standard for 2026 Node.js APIs.

### Why SQLite Over PostgreSQL?

SQLite chosen over PostgreSQL based on:
1. **Zero configuration:** Single file, no server process to manage
2. **Local performance:** Faster for read-heavy workloads on same machine
3. **Simple backups:** Copy file = backup. No pg_dump complexity.
4. **Scale sufficient:** Handles 100K+ tasks with proper indexing
5. **Open source:** No licensing, runs anywhere

PostgreSQL offers better write concurrency but adds operational overhead unnecessary for LAN service with known agent count.

### Why better-sqlite3 Over node:sqlite?

better-sqlite3 chosen over node:sqlite based on:
1. **Production ready:** Proven in production, node:sqlite is experimental (v1.1)
2. **Performance:** 5-10x faster than async node-sqlite3
3. **Synchronous API:** Perfect for single-writer pattern, simpler code
4. **Maturity:** Most popular SQLite library for Node.js, extensive documentation

node:sqlite will likely mature but better-sqlite3 is safer choice for 2026.

## Feature Prioritization Summary

### Must-Have (P1) for Launch

1. Task CRUD via REST API
2. MCP server with basic tools (create, get, update, list)
3. Task search and filtering (status, project, assignee, tags)
4. Multi-project support
5. API key authentication
6. CLI for human use
7. OpenAPI specification
8. Tags/labels for categorization
9. Due dates for time-sensitive tasks

### Should-Have (P2) After Validation

10. Parent/child task relationships
11. Task dependencies (blocks/requires)
12. Comments/activity log
13. Change history/audit log
14. Bulk operations
15. Automated task linking (#TASK-123 mentions)
16. Time tracking (estimate + actual)

### Nice-to-Have (P3) Future Consideration

17. Webhooks for task events
18. Task templates
19. Dependency graph visualization
20. Natural language query translation
21. Rich semantic search context fields

## Critical Success Metrics

### Technical Success
- [ ] API response time p95 < 100ms for simple queries
- [ ] Zero SQLITE_BUSY errors in production
- [ ] 100% OpenAPI spec coverage of all endpoints
- [ ] All MCP tools tested with Claude Code agents

### Product Success
- [ ] Claude Code agent creates task via MCP without errors
- [ ] Stuart uses CLI daily for task management
- [ ] 10+ agents on local network use service without conflicts
- [ ] Zero data loss incidents in first month

### Quality Gates
- [ ] Integration tests with 10K+ task database
- [ ] Concurrent write tests (5+ agents simultaneously)
- [ ] Dependency cycle detection validated
- [ ] Migration system tested with up/down reversibility

## Next Steps (For Orchestrator)

1. **Create roadmap** based on phase structure above
2. **Define milestones:**
   - Milestone 1: Foundation + REST API
   - Milestone 2: CLI + MCP Server
   - Milestone 3: Production Deployment
3. **Flag Phase 4 (MCP)** as requiring deeper research during implementation
4. **Budget extra time** for dependency cycle detection if Phase 6 includes dependencies
5. **Defer v2 features** (webhooks, templates, NL query) until v1 validates core value

## Sources

All research files (FEATURES.md, STACK.md, ARCHITECTURE.md, PITFALLS.md) contain detailed source citations. Key high-confidence sources:

- [Fastify Official Documentation](https://fastify.dev/) - Performance benchmarks, v5 features
- [Model Context Protocol Specification](https://modelcontextprotocol.io/specification/2025-11-25) - Official MCP protocol definition
- [Architecture of SQLite](https://sqlite.org/arch.html) - Official SQLite architecture
- [Designing APIs for LLM Apps](https://www.gravitee.io/blog/designing-apis-for-llm-apps) - API design for LLM consumption
- [Linear vs Jira Comparison](https://everhour.com/blog/linear-vs-jira/) - Competitor feature analysis

---
*Research summary for: Wood Fired Bugs*
*Researched: 2026-02-13*
