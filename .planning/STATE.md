# Project State: Wood Fired Bugs

**Last Updated:** 2026-02-14T16:03:53Z

## Project Reference

**Core Value:** Any agent on the local network can reliably create, find, and update work items in real time — making this the single source of truth for all Wood Fired Games task tracking.

**Current Focus:** v1.3 Multi-Agent Coordination — Enable AI-driven multi-agent task orchestration with real-time event streaming, workflow automation, and atomic task claiming.

## Current Position

**Milestone:** v1.3 Multi-Agent Coordination
**Phase:** 15 - Atomic Claim Protocol
**Plan:** 02 (2/3 plans complete)
**Status:** Executing Phase 15 - Plan 02 complete (REST claim endpoint & auto-release)

**Progress Bar:**
```
v1.0 ████████████████████ 100% (6/6 phases complete)
v1.1 ████████████████████ 100% (4/4 phases complete)
v1.2 ████████████████████ 100% (3/3 phases complete)
v1.3 ██████████░░░░░░░░░░  50% (1/3 phases, 6/12 plans complete)
```

## Performance Metrics

**Previous Milestones:**
- v1.0 MVP: 6 phases, 13 plans, shipped 2026-02-13 (386 tests passing)
- v1.1 Interface Parity & CLI Polish: 4 phases, 10 plans, shipped 2026-02-13 (same day)
- v1.2 Claude Code Skills & Installer: 3 phases, 7 plans, shipped 2026-02-14

**Current Milestone:**
- Phases: 3 (14-16)
- Requirements: 17 total (EVT: 7, CLM: 5, WFL: 5)
- Plans: 6/12 completed (Phase 14: 4/4 COMPLETE, Phase 15: 2/3)
- Tests: 479 passing (0 failing)

## Accumulated Context

### Key Decisions

| Decision | Rationale | Phase |
|----------|-----------|-------|
| @fastify/sse over WebSocket | Official Fastify plugin, simpler server→agent push, sufficient for notifications | 14 |
| Native EventEmitter over external pub/sub | Zero dependencies, TypeScript generics since @types/node July 2024, follows existing patterns | 14 |
| Wrap handlers in try/catch for error isolation | Prevents one subscriber from crashing EventBus or blocking other subscribers | 14-01 |
| Define task.claimed type but defer emission to Phase 15 | Type safety now, implementation when atomic claim endpoint exists | 14-01 |
| MCP resource (not tool) for SSE discovery | SSE streams are long-lived connections; resource provides discovery docs, not streaming | 14-04 |
| Optimistic locking with version field | Better for LAN latency + SQLite WAL mode than pessimistic row locks | 15 |
| BEGIN IMMEDIATE for claims | Acquire write lock early, avoid transaction upgrade SQLITE_BUSY | 15 |
| CAS with version column for atomic claim | Prevents double-claim without row locks, clear error messages | 15-01 |
| Service pre-validates before CAS attempt | Returns clear errors for status/assignee conflicts before hitting DB | 15-01 |
| Idempotency keys in SQLite with 24h TTL | Simple approach, no external cache needed, periodic cleanup | 15-02 |
| Stale detection via claimed_at AND updated_at | Activity on task resets staleness clock, prevents false release | 15-02 |
| BusinessError maps to 409 for claim conflicts | Clearer HTTP semantics for concurrent claim operations | 15-02 |
| Event-driven workflow triggers | Decouple SSE from automation, EventBus enables parallel development | 16 |
| Max cascade depth = 5 levels | Prevent infinite loops from circular task hierarchies | 16 |

### Open Questions

None (research completed, all architectural decisions made).

### Blockers

None (roadmap approved, awaiting plan-phase execution).

### TODOs

- [ ] Validate connection cleanup strategy prevents memory leaks (1000 connect/disconnect cycles)
- [ ] Measure WAL checkpoint timing under SSE load to confirm 10-50ms post-commit delay suffices
- [ ] Audit prepared statement reuse for async safety before Phase 15 claim concurrency tests

### Recent Completions

- [x] Phase 15 Plan 02 complete (2026-02-14) — REST claim endpoint with idempotency + auto-release (277s, 26 new tests, 479 total)
- [x] Phase 15 Plan 01 complete (2026-02-14) — Atomic claim core with CAS + BEGIN IMMEDIATE (206s, 10 new tests, 453 total)
- [x] Phase 14 COMPLETE (2026-02-14) — SSE Event Infrastructure fully operational (4 plans, 56 tests, 443 total passing)
- [x] Phase 14 Plan 04 complete (2026-02-14) — MCP events resource for SSE stream discovery (141s, 9 new tests)
- [x] Phase 14 Plan 03 complete (2026-02-14) — SSE endpoint with connection management (787s, 22 new tests)
- [x] Phase 14 Plan 02 complete (2026-02-14) — Service integration with EventBus (399s, 17 new tests)
- [x] Phase 14 Plan 01 complete (2026-02-14) — EventBus foundation with TDD (127s, 8 tests)
- [x] v1.3 milestone research completed (2026-02-14) — identified 10 critical pitfalls with prevention strategies
- [x] v1.3 roadmap created (2026-02-14) — 3 phases covering 17 requirements with 100% coverage
- [x] Requirement traceability mapped (2026-02-14) — EVT→14, CLM→15, WFL→16

## Session Continuity

**What Just Happened:**
Completed Phase 15 Plan 02 (REST Claim Endpoint & Auto-Release). Added POST /api/v1/tasks/:id/claim endpoint with idempotency support (X-Idempotency-Key header, 24h TTL). Created IdempotencyService and ClaimReleaseService. Auto-release sweeps stale claims after 30-min timeout. 26 new tests, 479 total passing, zero TypeScript errors.

**What's Next:**
Phase 15 Plan 03 - MCP tool and CLI command for claiming tasks.

**Context for Next Session:**
- Phase 15 Plans 01-02 complete: full claim flow from repo through REST API
- POST /api/v1/tasks/:id/claim returns 200 (claimed), 409 (conflict), 404 (not found)
- X-Idempotency-Key header prevents duplicate claim processing (IdempotencyService)
- X-Claim-Source header sets metadata.source to 'user' or 'workflow'
- ClaimReleaseService sweeps stale claims every 5 min (30-min timeout default)
- IdempotencyService cleanup runs hourly to purge expired keys
- Server onClose hook stops all intervals and SSEManager
- ClaimRequestSchema, ClaimResponseSchema, ConflictResponseSchema in schemas.ts
- idempotencyService decorated on Fastify instance
- 479 tests passing across full suite

---
*State tracking started: 2026-02-14 for v1.3*
