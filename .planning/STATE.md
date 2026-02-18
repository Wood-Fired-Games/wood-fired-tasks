# Project State: Wood Fired Bugs

**Last Updated:** 2026-02-18 — Plan 23-02 complete

## Project Reference

See: .planning/PROJECT.md (updated 2026-02-17)

**Core Value:** Any agent on the local network can reliably create, find, and update work items in real time — making this the single source of truth for all Wood Fired Games task tracking.

**Current Focus:** v1.5 Slack Integration — Phase 23 complete, advance to Phase 24

## Current Position

**Milestone:** v1.5 Slack Integration — IN PROGRESS
**Phase:** 23 of 26 (Socket Mode Infrastructure) — COMPLETE
**Plan:** 2 of 2 in Phase 23 — Plan 02 complete
**Status:** Phase 23 complete — ready for Phase 24 (Formatters and Identity)
**Last activity:** 2026-02-18 — Plan 23-02 complete (SlackService + Fastify integration)

**Progress:**
```
v1.0 ████████████████████ 100% (6/6 phases, 13 plans) — shipped 2026-02-13
v1.1 ████████████████████ 100% (4/4 phases, 10 plans) — shipped 2026-02-13
v1.2 ████████████████████ 100% (3/3 phases, 7 plans)  — shipped 2026-02-14
v1.3 ████████████████████ 100% (3/3 phases, 12 plans) — shipped 2026-02-14
v1.4 ████████████████████ 100% (6/6 phases, 15 plans) — shipped 2026-02-17
v1.5 █████░░░░░░░░░░░░░░░  25% (1/4 phases, 2/TBD plans) — in progress
```

## Performance Metrics

**All Milestones:**
- v1.0 MVP: 6 phases, 13 plans, shipped 2026-02-13 (250 tests)
- v1.1 Interface Parity & CLI Polish: 4 phases, 10 plans, shipped 2026-02-13 (357 tests)
- v1.2 Claude Code Skills & Installer: 3 phases, 7 plans, shipped 2026-02-14 (386 tests)
- v1.3 Multi-Agent Coordination: 3 phases, 12 plans, shipped 2026-02-14 (513 tests)
- v1.4 Hardening and Polish: 6 phases, 15 plans, shipped 2026-02-17 (636 tests)

**Current:** 665 tests passing (59 test files), 24,500+ LOC TypeScript, 132+ files

**Phase 23 metrics:**
- Plan 23-01: 3 min, 2 tasks, 4 files, 15 tests added
- Plan 23-02: 2 min, 2 tasks, 5 files, 14 tests added

## Accumulated Context

### Key Decisions (v1.5)

See `.planning/PROJECT.md` Key Decisions table for full history.

Recent decisions for v1.5 work:
- Use `@slack/bolt@^4.6.0` in Socket Mode — eliminates public URL requirement, fits LAN deployment
- `@slack/types@^2.20.0` as dev dep only — Block Kit type safety at compile time, no runtime cost
- Bolt runs co-process in same Node.js process as Fastify — direct service injection, no IPC
- Slack feature is optional — service starts normally when SLACK_BOT_TOKEN absent
- Store Slack user IDs as canonical assignee identifier — display names are mutable and non-unique
- `ack()` must be first statement in every slash command handler — 3-second deadline is for ack only
- Fire-and-forget async in SlackNotifier — synchronous EventBus must not be blocked by Slack API calls
- `chat:write.public` scope — simpler than requiring bot channel membership for internal tool
- Refine path set to SLACK_APP_TOKEN (dependent field) so validation error targets the missing token
- slack_channel_subscriptions uses ON DELETE CASCADE — subscriptions are meaningless without their project
- Three separate single-column indexes on slack_channel_subscriptions rather than compound index
- SlackService not decorated onto Fastify instance — local const in server.ts; Phase 25/26 decides injection approach
- `started` boolean separate from `app !== null` guard — prevents stop() crash when start() threw partway through
- getApp() returns App | null — callers in Phase 25/26 guard with isEnabled() before using App instance
- Vitest ESM constructor mock requires vi.fn(function() {...}) not arrow fn for vi.mock + new App() pattern

### Open Questions

- Mixed assignee field format: existing tasks store human-readable strings; Slack tasks will store user IDs. Validate during Phase 25 whether display-name resolution layer is needed uniformly at service layer.
- SQLite `json_each()` query for event_type filtering: validate against real SQLite test DB during Phase 24 before SlackChannelRepository is used downstream.

### Blockers

None — all research complete, confidence HIGH, no external blockers.

### Slack App Prerequisite

Before Phase 25/26 runtime testing: Slack App must be manually configured in Slack Developer Console.
Required scopes: `chat:write`, `chat:write.public`, `commands`, `channels:read`, `connections:write`
Socket Mode must be enabled. Slash command `/tasks` must be registered.
See 23-02-SUMMARY.md User Setup Required section for full setup steps.

## Session Continuity

**What Just Happened:**
Plan 23-02 complete. Installed @slack/bolt@^4.6.0 and @slack/types@^2.20.0. Created SlackService with start/stop/isEnabled/getApp lifecycle. Integrated into server.ts with onClose hook. 14 new unit tests, 665 total. Phase 23 is now fully complete.

**What's Next:**
Phase 24: Formatters and Identity (Block Kit message formatters, Slack user identity resolution)

**Context for Next Session:**
- SlackService ready: getApp() returns the Bolt App instance for Phase 25/26 handler registration
- Config foundation ready: config.SLACK_BOT_TOKEN and config.SLACK_APP_TOKEN available
- Migration 006 in place: slack_channel_subscriptions table ready for Phase 26
- Phase 23 complete: both plans done (config+migration, SlackService+server integration)
- Phase 24 is independent foundation for both Phase 25 (slash commands) and Phase 26 (notifications)
- Slack app dashboard setup remains a manual prerequisite before any runtime Slack testing

---
*State tracking started: 2026-02-14 for v1.3*
*v1.5 roadmap created: 2026-02-17*
