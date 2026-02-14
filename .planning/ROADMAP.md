# Roadmap: Wood Fired Bugs

## Milestones

- ✅ **v1.0 MVP** - Phases 1-6 (shipped 2026-02-13)
- ✅ **v1.1 Interface Parity & CLI Polish** - Phases 7-10 (shipped 2026-02-13)
- ✅ **v1.2 Claude Code Skills & Installer** - Phases 11-13 (shipped 2026-02-14)
- 🚧 **v1.3 Multi-Agent Coordination** - Phases 14-16 (active)

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

<details>
<summary>✅ v1.2 Claude Code Skills & Installer (Phases 11-13) - SHIPPED 2026-02-14</summary>

- [x] Phase 11: MCP Server Verification (1/1 plans) -- completed 2026-02-13
- [x] Phase 12: Skill File Authoring (4/4 plans) -- completed 2026-02-14
- [x] Phase 13: Cross-Platform Installer (2/2 plans) -- completed 2026-02-14

See: [milestones/v1.2-ROADMAP.md](./milestones/v1.2-ROADMAP.md) for full details.

</details>

---

## 🚧 v1.3 Multi-Agent Coordination (Phases 14-16)

### Phase 14: SSE Event Infrastructure

**Goal:** Agents receive real-time task change notifications via Server-Sent Events, eliminating polling and enabling instant coordination.

**Dependencies:** None (foundation phase)

**Requirements:** EVT-01, EVT-02, EVT-03, EVT-04, EVT-05, EVT-06, EVT-07

**Plans:** 4 plans

Plans:
- [ ] 14-01-PLAN.md — EventBus implementation with TDD (type-safe pub/sub foundation)
- [ ] 14-02-PLAN.md — Service event emissions (TaskService and ProjectService emit domain events)
- [ ] 14-03-PLAN.md — SSE endpoint infrastructure (SSEManager, filtering, heartbeat, reconnection)
- [ ] 14-04-PLAN.md — MCP integration and verification (events resource + human testing)

**Success Criteria:**
1. Agent subscribes to GET /api/v1/events and receives real-time task lifecycle events (created, updated, deleted, claimed, status_changed) with <100ms latency
2. Agent filters event stream by project ID and event type, receiving only relevant events (verified by subscribing to Project A, creating task in Project B, confirming no event received)
3. Agent disconnects for 30 seconds, reconnects with Last-Event-ID header, and resumes stream with zero missed events
4. Agent queries API immediately after receiving task.created event and successfully retrieves task (no 404 race conditions)
5. Server maintains 1000 concurrent SSE connections for 10 minutes with flat memory usage (no connection registry leaks)

---

### Phase 15: Atomic Claim Protocol

**Goal:** Multiple agents safely compete for tasks using atomic claim operations with optimistic locking, preventing race conditions and stuck assignments.

**Dependencies:** Phase 14 (EventBus for task.claimed events)

**Requirements:** CLM-01, CLM-02, CLM-03, CLM-04, CLM-05

**Success Criteria:**
1. Agent atomically claims unassigned task via POST /api/v1/tasks/:id/claim (MCP: claim_task, CLI: tasks claim), transitioning assignee and status in single operation
2. Twenty agents simultaneously claim same task: exactly one succeeds with 200 OK, nineteen fail gracefully with 409 Conflict "already claimed" error (no SQLITE_BUSY crashes)
3. Agent duplicates claim request with same X-Idempotency-Key, receives 200 OK with cached result and no duplicate side effects
4. Claimed task with no activity (no updates, comments, status changes) auto-releases after 30 minutes, transitioning assignee to NULL and status back to open
5. Workflow-triggered claim (via automation rule) emits task.claimed event with source: workflow metadata, distinguishable from user-initiated claims

---

### Phase 16: Workflow Automation

**Goal:** Task state changes trigger automated workflows (parent auto-complete, dependency cascade), reducing manual coordination overhead while preventing infinite loops.

**Dependencies:** Phase 14 (EventBus for triggering workflows), Phase 15 (version field for atomic cascades)

**Requirements:** WFL-01, WFL-02, WFL-03, WFL-04, WFL-05

**Success Criteria:**
1. When all child tasks of parent transition to done, parent automatically transitions to done without manual intervention (verified by marking 3/3 subtasks complete, observing parent update)
2. When blocking dependency transitions to done, blocked task automatically transitions from blocked to open (verified by completing Task A which blocks Task B, observing Task B unblock)
3. Workflow-triggered state changes appear in SSE event stream with source: workflow attribution, distinguishable from user actions
4. Circular task hierarchy (Task A → Task B → Task C → Task A) detected before execution, preventing infinite cascade loops (max cascade depth = 5 levels enforced)
5. Server crash mid-workflow either completes ALL cascading updates atomically or rolls back entirely (no partial state: integration test kills process during parent auto-complete, verifies child statuses match parent post-restart)

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
| 11. MCP Server Verification | v1.2 | 1/1 | Complete | 2026-02-13 |
| 12. Skill File Authoring | v1.2 | 4/4 | Complete | 2026-02-14 |
| 13. Cross-Platform Installer | v1.2 | 2/2 | Complete | 2026-02-14 |
| 14. SSE Event Infrastructure | v1.3 | 0/4 | Pending | - |
| 15. Atomic Claim Protocol | v1.3 | 0/? | Pending | - |
| 16. Workflow Automation | v1.3 | 0/? | Pending | - |

---
*Last updated: 2026-02-14 for v1.3 Multi-Agent Coordination*
