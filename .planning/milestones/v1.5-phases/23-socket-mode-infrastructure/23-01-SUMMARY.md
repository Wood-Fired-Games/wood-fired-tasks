---
phase: 23-socket-mode-infrastructure
plan: 01
subsystem: database
tags: [zod, sqlite, migrations, slack, better-sqlite3, umzug]

# Dependency graph
requires:
  - phase: 22-observability
    provides: "Existing config schema pattern and migration infrastructure (005-backlogged-status)"
provides:
  - "Zod configSchema with optional SLACK_BOT_TOKEN and SLACK_APP_TOKEN plus both-or-neither refine()"
  - "Migration 006 creating slack_channel_subscriptions table with UNIQUE constraint, FK cascade, and indexes"
  - "Config type (z.infer) exposing SLACK_BOT_TOKEN and SLACK_APP_TOKEN as string | undefined"
affects:
  - 23-02-SlackService (reads SLACK_BOT_TOKEN and SLACK_APP_TOKEN from config at startup)
  - 26-notification-pipeline (writes to slack_channel_subscriptions via SlackChannelRepository)
  - 24-formatters-identity (no direct dependency, but all v1.5 work builds on this foundation)

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "ZodEffects from .refine() is transparent — safeParse() and z.infer work identically to ZodObject"
    - "Both-or-neither token validation: refine() with path pointing to the dependent field"
    - "Migration pattern: wrapped in db.transaction()() with explicit index creation and typed up/down exports"

key-files:
  created:
    - src/db/migrations/006-slack-channel-subscriptions.ts
    - src/db/__tests__/migration-006.test.ts
  modified:
    - src/config/env.ts
    - src/config/__tests__/env.test.ts

key-decisions:
  - "Refine path set to SLACK_APP_TOKEN (dependent field) so error message targets the missing token"
  - "slack_channel_subscriptions uses ON DELETE CASCADE for project FK — subscriptions are meaningless without their project"
  - "Three separate indexes (channel_id, project_id, event_type) rather than compound — each query pattern benefits from single-column lookup"

patterns-established:
  - "Optional feature tokens: both-or-neither refine() on configSchema keeps feature optional with clear error when misconfigured"
  - "Migration test structure: describe table creation / constraints / indexes with beforeEach running full runMigrations()"

requirements-completed:
  - SLCK-03
  - SLCK-04
  - NTFY-04

# Metrics
duration: 3min
completed: 2026-02-18
---

# Phase 23 Plan 01: Socket Mode Infrastructure — Config and Migration Summary

**Optional Slack tokens added to Zod config schema with both-or-neither validation, plus migration 006 creating slack_channel_subscriptions with UNIQUE constraint, cascade FK, and indexes**

## Performance

- **Duration:** 3 min
- **Started:** 2026-02-18T02:33:23Z
- **Completed:** 2026-02-18T02:36:02Z
- **Tasks:** 2
- **Files modified:** 4 (2 created, 2 modified)

## Accomplishments

- Added SLACK_BOT_TOKEN and SLACK_APP_TOKEN as optional fields to configSchema, with a `.refine()` enforcing both-or-neither presence
- Created migration 006 for slack_channel_subscriptions table with UNIQUE(channel_id, project_id, event_type), ON DELETE CASCADE FK to projects, and three single-column indexes
- Added 15 new tests (5 config + 10 migration), bringing total from 636 to 651

## Task Commits

Each task was committed atomically:

1. **Task 1: Add Slack token config with both-or-neither Zod validation** - `a991cb4` (feat)
2. **Task 2: Create migration 006 for slack_channel_subscriptions with tests** - `0568883` (feat)

**Plan metadata:** [pending final commit] (docs: complete plan)

_Note: Both tasks followed TDD pattern (RED → GREEN) per plan spec_

## Files Created/Modified

- `src/config/env.ts` - Added SLACK_BOT_TOKEN and SLACK_APP_TOKEN optional fields plus .refine() both-or-neither constraint
- `src/config/__tests__/env.test.ts` - Added 5 Slack token validation tests, added token cleanup in beforeEach
- `src/db/migrations/006-slack-channel-subscriptions.ts` - Migration creating slack_channel_subscriptions table with UNIQUE constraint, cascade FK, indexes, and down migration
- `src/db/__tests__/migration-006.test.ts` - 10 integration tests covering table creation, constraints (UNIQUE, cascade delete), and all three indexes

## Decisions Made

- Used `.refine()` path `['SLACK_APP_TOKEN']` so the validation error targets the missing token — consistent with how Zod surfaces cross-field errors
- slack_channel_subscriptions uses ON DELETE CASCADE because subscriptions are meaningless without their project
- Three separate single-column indexes rather than a compound index — the primary query patterns (find by channel, find by project, filter by event type) each benefit from independent column lookups

## Deviations from Plan

None - plan executed exactly as written. TDD RED/GREEN cycles matched plan spec. The `.refine()` on ZodObject produces ZodEffects which is transparent to `safeParse()` and `z.infer<>` as documented in the plan.

## Issues Encountered

None — all test patterns matched existing migration-005 conventions. Foreign keys were already enabled in `initTestDatabase()` so the cascade delete test worked without modification.

## User Setup Required

None - no external service configuration required for this plan. (Slack app dashboard configuration is documented in STATE.md as a prerequisite for Phase 23 runtime testing, not for this plan's unit/integration tests.)

## Next Phase Readiness

- Config foundation ready: Phase 23 Plan 02 (SlackService) can access `config.SLACK_BOT_TOKEN` and `config.SLACK_APP_TOKEN`
- Database foundation ready: SlackChannelRepository (Phase 26) has the `slack_channel_subscriptions` table with correct schema
- Service startup behavior verified: when both tokens absent, config parses successfully — Slack feature remains optional

---
*Phase: 23-socket-mode-infrastructure*
*Completed: 2026-02-18*
