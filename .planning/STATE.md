# Project State: Wood Fired Bugs

**Last Updated:** 2026-02-17 (v1.5 roadmap created)

## Project Reference

See: .planning/PROJECT.md (updated 2026-02-17)

**Core Value:** Any agent on the local network can reliably create, find, and update work items in real time — making this the single source of truth for all Wood Fired Games task tracking.

**Current Focus:** v1.5 Slack Integration — Phase 23: Socket Mode Infrastructure

## Current Position

**Milestone:** v1.5 Slack Integration — IN PROGRESS
**Phase:** 23 of 26 (Socket Mode Infrastructure) — in progress
**Plan:** 1 of TBD in Phase 23 — Plan 01 complete
**Status:** In progress
**Last activity:** 2026-02-18 — Plan 23-01 complete (config schema + migration 006)

**Progress:**
```
v1.0 ████████████████████ 100% (6/6 phases, 13 plans) — shipped 2026-02-13
v1.1 ████████████████████ 100% (4/4 phases, 10 plans) — shipped 2026-02-13
v1.2 ████████████████████ 100% (3/3 phases, 7 plans)  — shipped 2026-02-14
v1.3 ████████████████████ 100% (3/3 phases, 12 plans) — shipped 2026-02-14
v1.4 ████████████████████ 100% (6/6 phases, 15 plans) — shipped 2026-02-17
v1.5 ░░░░░░░░░░░░░░░░░░░░   0% (0/4 phases, 0/TBD plans) — in progress
```

## Performance Metrics

**All Milestones:**
- v1.0 MVP: 6 phases, 13 plans, shipped 2026-02-13 (250 tests)
- v1.1 Interface Parity & CLI Polish: 4 phases, 10 plans, shipped 2026-02-13 (357 tests)
- v1.2 Claude Code Skills & Installer: 3 phases, 7 plans, shipped 2026-02-14 (386 tests)
- v1.3 Multi-Agent Coordination: 3 phases, 12 plans, shipped 2026-02-14 (513 tests)
- v1.4 Hardening and Polish: 6 phases, 15 plans, shipped 2026-02-17 (636 tests)

**Current:** 651 tests passing (58 test files), 24,425 LOC TypeScript, 130+ files

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

### Open Questions

- Mixed assignee field format: existing tasks store human-readable strings; Slack tasks will store user IDs. Validate during Phase 25 whether display-name resolution layer is needed uniformly at service layer.
- SQLite `json_each()` query for event_type filtering: validate against real SQLite test DB during Phase 23 before SlackChannelRepository is used downstream.

### Blockers

None — all research complete, confidence HIGH, no external blockers.

### Slack App Prerequisite

Before Phase 23 code testing: Slack App must be manually configured in Slack Developer Console.
Required scopes: `chat:write`, `chat:write.public`, `commands`, `channels:read`, `connections:write`
Socket Mode must be enabled. Slash command `/tasks` must be registered.

## Session Continuity

**What Just Happened:**
Plan 23-01 complete. Added SLACK_BOT_TOKEN and SLACK_APP_TOKEN optional fields to Zod configSchema with both-or-neither .refine(). Created migration 006 for slack_channel_subscriptions table. 15 new tests, 651 total.

**What's Next:**
Run next plan in Phase 23 (Plan 02: SlackService).

**Context for Next Session:**
- Config foundation ready: SLACK_BOT_TOKEN and SLACK_APP_TOKEN in configSchema as string | undefined
- Migration 006 in place: slack_channel_subscriptions with UNIQUE(channel_id, project_id, event_type), cascade FK, 3 indexes
- 4 phases defined: 23 (infrastructure+migration), 24 (formatters+identity), 25 (slash commands), 26 (notifications)
- Phases 25 and 26 both depend on 24 but are independent of each other
- Slack app dashboard setup is a manual prerequisite before Phase 23 runtime testing

---
*State tracking started: 2026-02-14 for v1.3*
*v1.5 roadmap created: 2026-02-17*
