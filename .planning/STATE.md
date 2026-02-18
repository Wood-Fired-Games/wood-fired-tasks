# Project State: Wood Fired Bugs

**Last Updated:** 2026-02-18 — Plan 25-01 complete

## Project Reference

See: .planning/PROJECT.md (updated 2026-02-17)

**Core Value:** Any agent on the local network can reliably create, find, and update work items in real time — making this the single source of truth for all Wood Fired Games task tracking.

**Current Focus:** v1.5 Slack Integration — Phase 25 in progress (Plan 01 of 3 complete)

## Current Position

**Milestone:** v1.5 Slack Integration — IN PROGRESS
**Phase:** 25 of 26 (Slash Command Handlers) — IN PROGRESS
**Plan:** 1 of 3 in Phase 25 — Plan 01 complete
**Status:** In progress
**Last activity:** 2026-02-18 — Plan 25-01 complete (registerTasksCommand router skeleton, parseArgs, respondBlocks, respondError, formatServiceError, server.ts wiring, 18 tests)

**Progress:**
[██████████] 96%
v1.0 ████████████████████ 100% (6/6 phases, 13 plans) — shipped 2026-02-13
v1.1 ████████████████████ 100% (4/4 phases, 10 plans) — shipped 2026-02-13
v1.2 ████████████████████ 100% (3/3 phases, 7 plans)  — shipped 2026-02-14
v1.3 ████████████████████ 100% (3/3 phases, 12 plans) — shipped 2026-02-14
v1.4 ████████████████████ 100% (6/6 phases, 15 plans) — shipped 2026-02-17
v1.5 ███████░░░░░░░░░░░░░  38% (2/4 phases, 3/TBD plans) — in progress
```

## Performance Metrics

**All Milestones:**
- v1.0 MVP: 6 phases, 13 plans, shipped 2026-02-13 (250 tests)
- v1.1 Interface Parity & CLI Polish: 4 phases, 10 plans, shipped 2026-02-13 (357 tests)
- v1.2 Claude Code Skills & Installer: 3 phases, 7 plans, shipped 2026-02-14 (386 tests)
- v1.3 Multi-Agent Coordination: 3 phases, 12 plans, shipped 2026-02-14 (513 tests)
- v1.4 Hardening and Polish: 6 phases, 15 plans, shipped 2026-02-17 (636 tests)

**Current:** 752 tests passing (63 test files), 24,500+ LOC TypeScript, 138+ files

**Phase 23 metrics:**
- Plan 23-01: 3 min, 2 tasks, 4 files, 15 tests added
- Plan 23-02: 2 min, 2 tasks, 5 files, 14 tests added

**Phase 24 metrics (complete):**
- Plan 24-01: 5 min, 2 tasks, 2 files, 43 tests added
- Plan 24-02: 5 min, 2 tasks, 2 files, 14 tests added
- Plan 24-03: 2 min, 2 tasks, 2 files, 12 tests added

**Phase 25 metrics (in progress):**
- Plan 25-01: 4 min, 2 tasks, 3 files, 18 tests added

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
- UserIdentityCache takes WebClient not SlackService — dependency inversion enables unit testing with plain mock object, no vi.mock() needed
- ERROR_TTL_MS = 30,000ms hardcoded constant in UserIdentityCache — brief cache on error prevents API hammering; not configurable
- No logger parameter in UserIdentityCache — self-contained; Phase 25 handlers log context before calling resolve()
- truncate(text, N) produces N total chars (N-3 content + '...'), not N content chars + '...'
- formatProjectDetail fields: exactly 4 items (ID, Description, Created, Updated) — task count not included, caller responsibility
- DividerBlock between list items via index check (i < length-1), not after last item
- Title truncation boundary: title.length > 150 triggers truncation (not > 147) — 150-char title passes through untouched
- STATUS_EMOJI and PRIORITY_INDICATOR exported from task-formatter.ts for reuse by project-formatter
- toEndWith is not a Vitest matcher — use toMatch(/pattern/) for string suffix assertions
- Subcommand stubs use respondError('Not yet implemented') — gives useful feedback while Plans 02/03 fill in real implementations
- Use 'as unknown as UserIdentityCache' in test mocks — concrete class private fields (cache, client, ttlMs) cannot be satisfied by plain objects
- void services / void identityCache markers in stub phase — removed as Plans 02/03 implement the actual calls

### Open Questions

- Mixed assignee field format: existing tasks store human-readable strings; Slack tasks will store user IDs. Validate during Phase 25 whether display-name resolution layer is needed uniformly at service layer.
- SQLite `json_each()` query for event_type filtering: validate against real SQLite test DB during Phase 24 before SlackChannelRepository is used downstream.

### Blockers

None — all research complete, confidence HIGH, no external blockers.

### Slack App Prerequisite

Before Phase 25/26 runtime testing: Slack App must be manually configured in Slack Developer Console.
Required scopes: `chat:write`, `chat:write.public`, `commands`, `channels:read`, `connections:write`, `users:read`
Socket Mode must be enabled. Slash command `/tasks` must be registered.
See 23-02-SUMMARY.md User Setup Required section for full setup steps.
Also add `users:read` scope and reinstall app (required for UserIdentityCache.resolve() via users.info).

## Session Continuity

**What Just Happened:**
Plan 25-01 complete. Created registerTasksCommand router skeleton in src/slack/commands/tasks-command.ts with all 26 subcommand stubs, help handler, parseArgs, respondBlocks/respondError, formatServiceError utilities, and HELP_BLOCKS constant. Wired into server.ts after slackService.start() with UserIdentityCache constructed once. 18 unit tests added, 752 total tests across 63 test files.

**What's Next:**
Phase 25 Plan 02: Implement task subcommand handlers (list, show, create, update, delete, claim) filling in the router stubs.

**Context for Next Session:**
- Router skeleton ready in src/slack/commands/tasks-command.ts — Plans 02/03 fill in the switch case stubs
- parseArgs, respondBlocks, respondError, formatServiceError all exported and unit-tested — import them in Plans 02/03
- UserIdentityCache now wired in production (server.ts) — UIDENT-03 gap closed at infrastructure level
- void services / void identityCache markers at top of handler to be removed as Plans 02/03 implement actual calls
- All formatters ready: formatTaskList, formatTaskDetail in task-formatter.ts; formatProjectList, formatProjectDetail in formatters/project-formatter.ts
- STATUS_EMOJI and PRIORITY_INDICATOR exported from task-formatter.ts for cross-formatter reuse
- Slack app dashboard setup remains a manual prerequisite before any runtime Slack testing

---
*State tracking started: 2026-02-14 for v1.3*
*v1.5 roadmap created: 2026-02-17*
