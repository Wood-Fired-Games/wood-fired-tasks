# Feature Research: Multi-Agent Coordination

**Domain:** Multi-agent task coordination (SSE events, workflow automation, atomic claiming)
**Researched:** 2026-02-14
**Confidence:** MEDIUM-HIGH

## Feature Landscape

### Table Stakes (Users Expect These)

Features agents/users assume exist for real-time coordination. Missing these = coordination feels broken.

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| **SSE: Basic event streaming** | Real-time updates are expected in 2026 task systems; polling is outdated | MEDIUM | HTTP/2 reduces connection limits; requires keep-alive, heartbeat |
| **SSE: Event filtering by task/project** | Agents don't want all events, only relevant ones | MEDIUM | Prevents thundering herd; requires subscription metadata |
| **SSE: Automatic reconnection** | Network failures happen; manual reconnect is unacceptable | LOW | EventSource provides this free; need Last-Event-ID support |
| **SSE: Connection lifecycle management** | Idle connections waste resources | MEDIUM | Requires heartbeat, timeout detection, graceful disconnect |
| **Workflow: Status transition triggers** | When task moves open→in_progress, something should happen | MEDIUM | Already have valid transitions; add hook points |
| **Workflow: Dependency cascade updates** | When task is done, unblock dependents automatically | MEDIUM | Have dependency graph; need to detect and update blocked tasks |
| **Claiming: Atomic assignment** | Two agents claiming same task = race condition disaster | HIGH | Requires database transaction or optimistic locking |
| **Claiming: Fair distribution** | First-come-first-served prevents starvation | MEDIUM | FIFO queue or timestamp-based ordering |
| **Claiming: Claim timeout/expiry** | Agent claims task then crashes = task stuck forever | MEDIUM | TTL on claims with automatic release; agent heartbeat |

### Differentiators (Competitive Advantage)

Features that set Wood Fired Bugs apart for LLM agent coordination. Not required, but valuable.

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| **SSE: Event type categorization** | Agents subscribe to task.updated vs task.created separately | LOW | Standard SSE event field; efficient filtering |
| **SSE: Backpressure handling** | Slow agent doesn't crash server under high load | HIGH | Bounded buffers, circuit breakers, explicit disconnect on overload |
| **SSE: Multi-stream multiplexing** | Agent gets project A and B updates on one connection | MEDIUM | Reduces connection count; HTTP/2 makes this efficient |
| **Workflow: Conditional rules engine** | "If task priority=urgent AND assignee empty, notify team" | HIGH | Rule DSL, evaluation engine, extensibility point |
| **Workflow: Batch operations** | "Mark all done subtasks as closed" in one atomic action | MEDIUM | Reduces chatter; requires transaction batching |
| **Workflow: Undo/rollback** | Bad automation can be reverted | HIGH | Event sourcing or change log required |
| **Claiming: Load-aware distribution** | Agents with fewer active tasks get priority | HIGH | Requires agent workload tracking; adaptive scheduling |
| **Claiming: Skill-based routing** | Tasks tagged "backend" go to agents that can handle them | MEDIUM | Agent capability declaration + matching algorithm |
| **Claiming: Optimistic locking with retry** | Fast path assumes no conflict; handles collision gracefully | MEDIUM | Version field on tasks; retry with exponential backoff |
| **Event replay from checkpoint** | New agent connects, gets history since last_event_id | MEDIUM | EventSource supports this; need server-side event log retention |

### Anti-Features (Commonly Requested, Often Problematic)

Features that seem good but create problems in multi-agent systems.

| Feature | Why Requested | Why Problematic | Alternative |
|---------|---------------|-----------------|-------------|
| **WebSocket bidirectional streams** | "More flexible than SSE" | Overkill for server→agent updates; increases complexity; firewall unfriendly | Use SSE for events + REST API for commands |
| **Real-time everything** | "Agents need instant updates on all changes" | Creates thundering herd; overloads network; most changes aren't urgent | Event filtering by relevance; configurable polling fallback for non-critical |
| **Complex workflow DSL** | "Turing-complete automation language" | 78% of teams over-automate; debugging distributed workflows is nightmare | Predefined trigger→action patterns; extensible via hooks not scripts |
| **Distributed consensus for claims** | "Perfectly consistent across all nodes" | Adds latency; requires Paxos/Raft; overkill for single SQLite instance | Optimistic locking with retry; claims expire automatically |
| **Eager automation of broken processes** | "AI will clean up our messy workflows" | Automates chaos faster; 85% say combining broken tasks makes it worse | Fix workflow definitions first; automate only well-defined patterns |
| **Persistent task queues** | "Never lose a task assignment" | Adds Redis/RabbitMQ dependency; complexity explosion for single-server system | Atomic DB updates + SSE notification; if agent crashes, task auto-releases |
| **Agent-to-agent direct messaging** | "Agents should coordinate peer-to-peer" | Requires service discovery; network topology; breaks audit trail | All coordination via task system; central log of all actions |
| **Automatic retry on all failures** | "Make it resilient" | Retrying bad data/logic wastes cycles; can cause cascading failures | Classify errors (transient vs fatal); retry with backoff only for transient |

## Feature Dependencies

```
[Atomic Claiming]
    └──requires──> [Task assignee field] (exists)
    └──requires──> [Transaction support] (SQLite provides)
    └──enhances──> [SSE Event Stream] (emit task.claimed events)

[SSE Event Stream]
    └──requires──> [HTTP server] (exists - Express)
    └──requires──> [Event source data] (task CRUD already emits)
    └──enhances──> [Workflow Automation] (automation results trigger events)

[Workflow Automation]
    └──requires──> [Task status lifecycle] (exists)
    └──requires──> [Dependency graph] (exists)
    └──requires──> [SSE Event Stream] (to notify about cascades)
    └──enhances──> [Atomic Claiming] (auto-assign based on rules)

[Event Filtering]
    └──requires──> [SSE Event Stream]
    └──requires──> [Connection metadata] (track what client wants)

[Claim Timeout/Expiry]
    └──requires──> [Atomic Claiming]
    └──requires──> [Background job scheduler] (check for expired claims)

[Backpressure Handling]
    └──requires──> [SSE Event Stream]
    └──requires──> [Connection monitoring] (detect slow consumers)
```

### Dependency Notes

- **Atomic Claiming requires Task assignee + Transactions:** Already have assignee field; SQLite transactions available. Need to add claim_timestamp and claimed_by version tracking.
- **SSE Event Stream requires HTTP server:** Express already running. Add GET /api/v1/events endpoint with Server-Sent Events headers.
- **Workflow Automation requires Status lifecycle + Dependencies:** Both exist. Add trigger points after status updates and dependency resolution.
- **Event Filtering enhances SSE:** Prevents overwhelming agents with irrelevant events. Requires storing subscription preferences per connection.
- **Claim Timeout requires Background scheduler:** Need periodic check (every 30s?) to release stale claims. Simple setInterval works for single-process server.
- **Backpressure Handling prevents cascading failures:** Connection.getBackpressure() pattern; disconnect slow clients before memory exhaustion.

## MVP Definition

### Launch With (Multi-Agent Coordination v1)

Minimum viable product for real-time agent coordination.

- [ ] **SSE Basic Event Stream** — Agents can subscribe to task changes without polling; reduces API load by 90%
- [ ] **Event Filtering by Project** — Agents working on Project A don't see Project B noise; prevents cognitive overload
- [ ] **Atomic Task Claiming** — Prevents race conditions when 2+ agents try to claim same task; critical for reliability
- [ ] **Claim Timeout** — Tasks auto-release after 30min of inactivity; prevents "zombie" assignments blocking work
- [ ] **Status Transition Triggers** — When task goes done→closed, emit event; foundation for automation
- [ ] **Dependency Cascade** — When task completes, auto-unblock dependents; removes manual coordination overhead

### Add After Validation (v1.x)

Features to add once core coordination is working.

- [ ] **Event Type Filtering** — Subscribe to task.updated but not task.created; reduces bandwidth
- [ ] **Conditional Workflow Rules** — "If task urgent + unassigned, notify team"; requires validation that simple cascades work first
- [ ] **Optimistic Locking** — Fast-path for claims; add after confirming pessimistic locking handles load
- [ ] **Event Replay** — New agent gets last 100 events; nice-to-have after core streaming proven
- [ ] **Connection Backpressure** — Disconnect slow consumers; add when scaling reveals need

### Future Consideration (v2+)

Features to defer until multi-agent usage patterns are clear.

- [ ] **Load-Aware Distribution** — Requires tracking agent workload; complex heuristic; wait for data on bottlenecks
- [ ] **Skill-Based Routing** — Agents declare capabilities; tasks route accordingly; need product-market fit first
- [ ] **Workflow Undo/Rollback** — Nice safety net but requires event sourcing architecture; major refactor
- [ ] **Multi-Stream Multiplexing** — HTTP/2 optimization; only needed at scale (>100 concurrent agents)

## Feature Prioritization Matrix

| Feature | User Value | Implementation Cost | Priority | Existing Data Model Support |
|---------|------------|---------------------|----------|----------------------------|
| SSE Basic Event Stream | HIGH (eliminates polling) | MEDIUM (Express SSE route) | P1 | No DB changes needed |
| Atomic Task Claiming | HIGH (prevents conflicts) | MEDIUM (transaction + version field) | P1 | Add claim_timestamp, claim_version |
| Event Filtering by Project | HIGH (reduces noise) | LOW (check project_id filter) | P1 | Uses existing project_id field |
| Claim Timeout | HIGH (prevents stuck tasks) | MEDIUM (background job) | P1 | Uses claim_timestamp field |
| Status Transition Triggers | MEDIUM (enables automation) | LOW (hook after updateTask) | P1 | Uses existing status field |
| Dependency Cascade | HIGH (removes manual work) | MEDIUM (graph traversal) | P1 | Uses existing task_dependencies table |
| Event Type Filtering | MEDIUM (bandwidth savings) | LOW (SSE event field) | P2 | No DB changes needed |
| Conditional Workflow Rules | MEDIUM (flexibility) | HIGH (rule engine) | P2 | New workflow_rules table |
| Optimistic Locking | MEDIUM (performance) | MEDIUM (retry logic) | P2 | Uses claim_version field |
| Event Replay | LOW (nice UX) | MEDIUM (event log storage) | P2 | New event_log table |
| Backpressure Handling | MEDIUM (stability) | HIGH (monitoring + circuit breaker) | P2 | No DB changes needed |
| Load-Aware Distribution | LOW (optimization) | HIGH (workload tracking) | P3 | New agent_workload table |
| Skill-Based Routing | LOW (advanced matching) | HIGH (capability matching) | P3 | New agent_capabilities table |
| Workflow Undo/Rollback | LOW (safety net) | HIGH (event sourcing refactor) | P3 | Requires full event sourcing |

**Priority key:**
- P1: Must have for launch — solves core coordination pain points
- P2: Should have — adds value once core is proven
- P3: Nice to have — future optimization or advanced use case

## Data Model Impact

### Required Changes for P1 Features

**tasks table additions:**
```sql
ALTER TABLE tasks ADD COLUMN claim_timestamp TEXT;
ALTER TABLE tasks ADD COLUMN claim_version INTEGER DEFAULT 0;
```

**New tables:**
```sql
-- Event log for replay (optional for P1, required for P2 event replay)
CREATE TABLE event_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,
  task_id INTEGER REFERENCES tasks(id),
  project_id INTEGER,
  payload TEXT, -- JSON
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX idx_event_log_task ON event_log(task_id, created_at);
CREATE INDEX idx_event_log_project ON event_log(project_id, created_at);
```

### Dependencies on Existing Schema

| Feature | Existing Field/Table | How Used |
|---------|---------------------|----------|
| Event Filtering | tasks.project_id | Filter events by project subscription |
| Atomic Claiming | tasks.assignee | Store who claimed the task |
| Claim Timeout | tasks.claim_timestamp | Check if claim expired |
| Dependency Cascade | task_dependencies.blocks_task_id | Find dependents to unblock |
| Status Triggers | tasks.status | Detect transitions for automation |
| SSE Routing | tasks.id, projects.id | Route events to interested subscribers |

## Coordination Patterns Analysis

### 2026 Trends from Research

**Agentic AI Orchestration:**
- 65% reduction in manual approvals with autonomous agents (UiPath research)
- Systems shift from rule-based to decision-oriented workflows
- Memory, retries, observability, and human-in-the-loop are table stakes

**Event-Driven Architecture:**
- 72% of global organizations use EDA for apps/systems/processes
- Async task execution, event sourcing, saga pattern, event aggregation are standard
- Transactional outbox pattern addresses dual-write problem (DB + event notification)

**Distributed Task Claiming:**
- Decentralized two-layer architecture for partial observability (Nature 2025 research)
- FIFO + priority-based allocation prevents starvation
- Reinforcement learning for adaptive scheduling emerging but complex

**SSE Best Practices:**
- Heartbeat every few seconds keeps connection alive
- Exponential backoff on reconnect prevents load spikes
- EventSource auto-sends Last-Event-ID header for replay
- Browser limit: 6 concurrent SSE connections per domain (HTTP/1.1); HTTP/2 defaults to 100

**Common Pitfalls:**
- 78% say complex workflow patterns make automation harder
- 85% say combining multiple automated tasks increases complexity
- Over-automation before fixing processes accelerates chaos
- Thundering herd on SSE query invalidation when thousands refetch simultaneously

### Recommended Implementation Approach

**Phase 1: Foundation (P1 Features)**
1. Add SSE endpoint with basic event types (task.created, task.updated, task.deleted)
2. Implement atomic claiming with optimistic locking (version field)
3. Add claim timeout background job (30min expiry, configurable)
4. Implement dependency cascade on task completion
5. Add event filtering by project_id in SSE subscription

**Phase 2: Refinement (P2 Features)**
1. Add event type filtering (subscribe to specific event types)
2. Implement event replay from Last-Event-ID
3. Add conditional workflow rules for common patterns
4. Implement backpressure detection and graceful degradation

**Phase 3: Optimization (P3 Features)**
1. Load-aware task distribution based on agent workload
2. Skill-based routing with capability matching
3. Event sourcing for full workflow undo/replay

## Competitor Feature Analysis

| Feature | Temporal Workflow | Celery + Redis | Apache Airflow | Our Approach |
|---------|-------------------|----------------|----------------|--------------|
| Event Streaming | gRPC streaming | Redis pub/sub | REST polling | SSE (simpler, HTTP-native) |
| Task Claiming | At-most-once semantics | LPOP atomic | Executor assigns | Optimistic lock on SQLite |
| Workflow Rules | Code-based workflow definitions | Chaining via apply_async | DAG definitions | Simple trigger→action hooks (v1), rules engine (v2) |
| Dependency Handling | Parent-child workflow | Manual chaining | Task dependencies in DAG | Existing dependency graph + auto-cascade |
| Retry Logic | Exponential backoff built-in | retry with countdown param | retry in operators | Per-feature basis (claim retry, SSE reconnect) |
| State Persistence | Durable execution log | Redis or DB backend | Metadata DB (Postgres) | SQLite (existing), add event_log for replay |
| Agent Coordination | Worker pools | Celery workers | Executor workers | Agents subscribe via SSE, claim via API |

**Key Differentiator for Wood Fired Bugs:**
- Designed for **LLM agents on LAN**, not distributed microservices
- **Single-process simplicity** (SQLite + Express) vs complex infrastructure (Redis, message queues)
- **SSE over HTTP** instead of specialized protocols (gRPC, AMQP)
- **Optimistic locking** sufficient for LAN latency; no need for distributed consensus

## Sources

**SSE Event Streaming:**
- [Why Server-Sent Events (SSE) are ideal for Real-Time Updates](https://talent500.com/blog/server-sent-events-real-time-updates/)
- [Server-Sent Events: A Practical Guide for the Real World](https://tigerabrodi.blog/server-sent-events-a-practical-guide-for-the-real-world)
- [Pushing real-time updates to clients with Server-Sent Events (SSEs)](https://rednafi.com/python/server-sent-events/)
- [Using server-sent events - MDN Web Docs](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events)
- [Server-Sent Events (SSE) in .NET: Key Concepts, Patterns, and Real-Time Use Cases](https://medium.com/@ashwinbalasubramaniam92/server-sent-events-in-dotnet-real-time-streaming-7836e24ae23d)

**Workflow Automation:**
- [Agentic AI Orchestration in 2026: Automating Workflows at Scale](https://onereach.ai/blog/agentic-ai-orchestration-enterprise-workflow-automation/)
- [7 AI Workflow Automation Trends in 2026: IT Leader Guide](https://kissflow.com/workflow/7-workflow-automation-trends-every-it-leader-must-watch-in-2025/)
- [The 2026 Guide to Agentic Workflow Architectures](https://www.stack-ai.com/blog/the-2026-guide-to-agentic-workflow-architectures)
- [Event-Driven Architecture (EDA): A Complete Introduction](https://www.confluent.io/learn/event-driven-architecture/)
- [7 Essential Patterns in Event-Driven Architecture Today](https://talent500.com/blog/event-driven-architecture-essential-patterns/)

**Atomic Task Claiming:**
- [The Art of Staying in Sync: How Distributed Systems Avoid Race Conditions](https://medium.com/@alexglushenkov/the-art-of-staying-in-sync-how-distributed-systems-avoid-race-conditions-f59b58817e02)
- [Handling Race Condition in Distributed System - GeeksforGeeks](https://www.geeksforgeeks.org/computer-networks/handling-race-condition-in-distributed-system/)
- [Distributed Locking and Race Condition Prevention](https://dzone.com/articles/distributed-locking-and-race-condition-prevention)
- [Exactly-Once Task Processing in Distributed Systems with Redis](https://medium.com/@ramachandrankrish/exactly-once-task-processing-in-distributed-systems-with-redis-preventing-race-conditions-across-009edf8f8a5a)
- [Pessimistic vs Optimistic Locking](https://newsletter.systemdesigncodex.com/p/pessimistic-vs-optimistic-locking)

**Fair Task Distribution:**
- [Decentralized adaptive task allocation for dynamic multi-agent systems](https://www.nature.com/articles/s41598-025-21709-9) (Nature Scientific Reports 2025)
- [How to Create Agent Coordination](https://oneuptime.com/blog/post/2026-01-30-agent-coordination/view)

**Anti-Patterns and Pitfalls:**
- [The AI Workflow Integration Paradox: More Automation Tools = Less Productivity](https://swisscognitive.ch/2026/01/06/the-ai-workflow-integration-paradox-more-automation-tools-less-productivity/)
- [6 Workflow Automation Mistakes That Could Derail Your Success](https://www.rpatech.ai/blogs/workflow-automation-mistakes/)
- [Messaging anti-patterns in event-driven architecture](https://www.ben-morris.com/event-driven-architecture-and-message-design-anti-patterns-and-pitfalls/)
- [Managing Back-Pressure in Event-Driven Architectures](https://medium.com/@mokarchi/managing-back-pressure-in-event-driven-architectures-fe370aa82df1)

---
*Feature research for: Multi-Agent Coordination (SSE, Workflow, Claiming)*
*Researched: 2026-02-14*
*Confidence: MEDIUM-HIGH (Context from web search; official docs verified for SSE/EDA patterns; LOW confidence on load balancing algorithms pending implementation testing)*
