# Requirements: Wood Fired Bugs

**Defined:** 2026-02-14
**Core Value:** Any agent on the local network can reliably create, find, and update work items in real time — making this the single source of truth for all Wood Fired Games task tracking.

## v1.3 Requirements

Requirements for v1.3 Multi-Agent Coordination. Each maps to roadmap phases.

### Event Streaming

- [ ] **EVT-01**: Agent can subscribe to real-time SSE event stream via GET /api/v1/events
- [ ] **EVT-02**: Events include task lifecycle changes (created, updated, deleted, claimed, status changed)
- [ ] **EVT-03**: Agent can filter events by project ID via query parameter
- [ ] **EVT-04**: Agent can filter events by event type via query parameter
- [ ] **EVT-05**: Server sends heartbeat ping every 30 seconds to detect stale connections
- [ ] **EVT-06**: Agent can resume from Last-Event-ID after reconnection with zero missed events
- [ ] **EVT-07**: SSE event stream accessible via MCP resource or tool

### Atomic Claiming

- [ ] **CLM-01**: Agent can atomically claim an unassigned task via POST /api/v1/tasks/:id/claim
- [ ] **CLM-02**: Concurrent claims on the same task return 409 Conflict (not crash or corruption)
- [ ] **CLM-03**: Claimed tasks auto-release after configurable timeout (default 30 min) with no activity
- [ ] **CLM-04**: Claim operation exposed as MCP tool (claim_task)
- [ ] **CLM-05**: Claim operation exposed as CLI command (tasks claim)

### Workflow Automation

- [ ] **WFL-01**: When all subtasks of a parent complete, parent auto-transitions to done
- [ ] **WFL-02**: When a blocking dependency resolves, blocked task auto-transitions from blocked to open
- [ ] **WFL-03**: Workflow-triggered state changes emit events visible via SSE stream
- [ ] **WFL-04**: Workflow cascades enforce max depth limit (5 levels) to prevent infinite loops
- [ ] **WFL-05**: Automated actions are attributed with source metadata (workflow vs user)

## Future Requirements

Deferred to future release. Tracked but not in current roadmap.

### Agent Registry

- **AGT-01**: Agent can register with name and capabilities
- **AGT-02**: System routes tasks to agents based on declared capabilities
- **AGT-03**: Agent heartbeat tracks availability and current workload

### Advanced Workflows

- **AWF-01**: User can define conditional workflow rules (if priority = urgent AND unassigned, notify)
- **AWF-02**: Workflow undo/rollback for failed cascades
- **AWF-03**: Load-aware task distribution across agents

## Out of Scope

Explicitly excluded. Documented to prevent scope creep.

| Feature | Reason |
|---------|--------|
| WebSocket transport | SSE is simpler and sufficient for server-to-agent push notifications |
| Complex workflow DSL | 78% of teams over-automate; use predefined patterns, not Turing-complete scripts |
| Distributed consensus (Paxos/Raft) | Overkill for single SQLite instance; optimistic locking sufficient for LAN |
| Persistent task queues (Redis/RabbitMQ) | Complexity explosion for single-server; atomic DB updates + SSE suffices |
| Agent registry / capability matching | Validate coordination model first; registry is v1.4+ |
| Multi-stream HTTP/2 multiplexing | Premature optimization for <100 concurrent agents |
| Skill-based agent routing | Need product-market fit on coordination before auto-routing |

## Traceability

Which phases cover which requirements. Updated during roadmap creation.

| Requirement | Phase | Status |
|-------------|-------|--------|
| EVT-01 | Phase 14 | Pending |
| EVT-02 | Phase 14 | Pending |
| EVT-03 | Phase 14 | Pending |
| EVT-04 | Phase 14 | Pending |
| EVT-05 | Phase 14 | Pending |
| EVT-06 | Phase 14 | Pending |
| EVT-07 | Phase 14 | Pending |
| CLM-01 | Phase 15 | Pending |
| CLM-02 | Phase 15 | Pending |
| CLM-03 | Phase 15 | Pending |
| CLM-04 | Phase 15 | Pending |
| CLM-05 | Phase 15 | Pending |
| WFL-01 | Phase 16 | Pending |
| WFL-02 | Phase 16 | Pending |
| WFL-03 | Phase 16 | Pending |
| WFL-04 | Phase 16 | Pending |
| WFL-05 | Phase 16 | Pending |

**Coverage:**
- v1.3 requirements: 17 total
- Mapped to phases: 17/17 (100%)
- Unmapped: 0

---
*Requirements defined: 2026-02-14*
*Last updated: 2026-02-14 after roadmap creation*
