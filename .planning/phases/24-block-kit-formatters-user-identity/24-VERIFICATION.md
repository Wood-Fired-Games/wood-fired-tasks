---
phase: 24-block-kit-formatters-user-identity
verified: 2026-02-17T22:10:00Z
status: gaps_found
score: 4/5 success criteria verified
re_verification: false
gaps:
  - truth: "Slack user ID lookups resolve to display names, cache results in memory with a TTL, AND tasks created or claimed from Slack show the resolved display name in CLI, REST, and MCP output"
    status: partial
    reason: "UserIdentityCache class fully implements UIDENT-01 and UIDENT-02 (resolve, fallback chain, TTL, error cache, clear), but no slash command handler or write path calls UserIdentityCache.resolve() to persist a resolved display name. UIDENT-03 requires Phase 25 to wire UserIdentityCache at task create/claim time. The tool exists but is unconnected to any production code path."
    artifacts:
      - path: "src/slack/user-identity.ts"
        issue: "Implementation is complete and correct. Issue is absence of a caller in any production write path — no file outside tests imports UserIdentityCache."
    missing:
      - "Phase 25 slash command handlers must call `await cache.resolve(command.user_id)` before writing created_by/assignee to DB to satisfy UIDENT-03"
      - "REQUIREMENTS.md maps UIDENT-03 to Phase 24, but all three plans only claimed UIDENT-01 and UIDENT-02; Phase 25 must complete UIDENT-03 or the requirement mapping must be corrected"
---

# Phase 24: Block Kit Formatters & User Identity Verification Report

**Phase Goal:** Pure TypeScript functions produce valid Block Kit JSON for every response type, and Slack user IDs are resolved to display names with a cached lookup
**Verified:** 2026-02-17T22:10:00Z
**Status:** gaps_found
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths (from ROADMAP Success Criteria)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Task list renders status emoji, priority indicators, and assignee (verified by unit test) | VERIFIED | 43 tests pass in task-formatter.test.ts; formatTaskList implementation is substantive (188 lines with STATUS_EMOJI, PRIORITY_INDICATOR maps, per-task SectionBlocks) |
| 2 | Task detail card includes all fields in structured layout (title, status, priority, assignee, description, due date, tags) | VERIFIED | Tests cover HeaderBlock, SectionBlock.fields with all 6 required fields plus optional tags and description; implementation at src/slack/task-formatter.ts lines 110-154 |
| 3 | Project list and detail use consistent Block Kit structure matching task formatting conventions | VERIFIED | 14 tests pass in project-formatter.test.ts; project-formatter.ts uses same HeaderBlock + SectionBlock.fields pattern |
| 4 | Notification includes task title, status change, assignee, project, and link to relevant slash command | VERIFIED | 13 notification tests pass; formatTaskNotification produces SectionBlock with event label, actor, task id/title, priority, assignee, `/tasks show <id>` |
| 5 | Slack user ID lookups resolve to display names, cache results in memory with TTL, AND tasks created/claimed from Slack show resolved display name in CLI/REST/MCP | PARTIAL — FAILED | UserIdentityCache fully implemented and 12 tests pass (UIDENT-01, UIDENT-02). However UserIdentityCache is not imported or called from any production write path. UIDENT-03 requires Phase 25 integration. |

**Score:** 4/5 success criteria verified

---

## Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/slack/task-formatter.ts` | formatTaskList, formatTaskDetail, formatTaskNotification pure functions | VERIFIED | 188 lines; all 3 functions exported; STATUS_EMOJI and PRIORITY_INDICATOR also exported. Note: PLAN 01 specified path `src/slack/formatters/task-formatter.ts` but implementation landed at `src/slack/task-formatter.ts` — documented as a plan decision in SUMMARY 01. Tests import correctly via `../../task-formatter.js`. |
| `src/slack/formatters/__tests__/task-formatter.test.ts` | Unit tests for all three formatter functions, min 100 lines | VERIFIED | 388 lines, 43 test cases covering formatTaskList (11 tests), formatTaskDetail (17 tests), formatTaskNotification (13 tests); makeTask() and makeTaskEvent() factories present |
| `src/slack/formatters/project-formatter.ts` | formatProjectList, formatProjectDetail pure functions | VERIFIED | 111 lines; both functions exported; truncate() helper present |
| `src/slack/formatters/__tests__/project-formatter.test.ts` | Unit tests for project formatter functions, min 60 lines | VERIFIED | 199 lines, 14 test cases covering formatProjectList (7 tests), formatProjectDetail (6 tests); makeProject() factory present |
| `src/slack/user-identity.ts` | UserIdentityCache class with resolve(), clear() methods | VERIFIED | 81 lines; class exported; resolve() with fallback chain and error handling; clear() implemented; ERROR_TTL_MS = 30_000 constant |
| `src/slack/__tests__/user-identity.test.ts` | Unit tests with mocked WebClient for all cache/fallback scenarios, min 80 lines | VERIFIED | 201 lines, 12 test cases covering all specified scenarios |

---

## Key Link Verification

### Plan 01 Key Links

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `src/slack/task-formatter.ts` | `@slack/types` | `import type ... from '@slack/types'` | WIRED | Line 1-8: imports KnownBlock, SectionBlock, HeaderBlock, DividerBlock, ContextBlock, MrkdwnElement from @slack/types |
| `src/slack/task-formatter.ts` | `src/types/task.ts` | `import type { Task } from '../types/task.js'` | WIRED | Line 9: imports Task type |
| `src/slack/task-formatter.ts` | `src/events/types.ts` | `import type { TaskEvent } from '../events/types.js'` | WIRED | Line 10: imports TaskEvent type |

### Plan 02 Key Links

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `src/slack/formatters/project-formatter.ts` | `@slack/types` | `import type ... from '@slack/types'` | WIRED | Line 1: imports KnownBlock, SectionBlock, HeaderBlock, DividerBlock |
| `src/slack/formatters/project-formatter.ts` | `src/types/task.ts` | `import type { Project } from '../../types/task.js'` | WIRED | Line 2: imports Project type |

### Plan 03 Key Links

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `src/slack/user-identity.ts` | `@slack/web-api` | `import type { WebClient } from '@slack/web-api'` | WIRED | Line 1: imports WebClient type |
| `src/slack/user-identity.ts` | `src/services/slack.service.ts` | Indirect — Phase 25 constructs UserIdentityCache from slackService.getApp()!.client | NOT_WIRED | By design: this link is Phase 25's responsibility per plan 03 objective. However its absence means UIDENT-03 is not satisfied. No production code calls `new UserIdentityCache(...)` or `cache.resolve(...)` outside tests. |

---

## Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|------------|-------------|--------|----------|
| BKIT-01 | 24-01 | Task list responses use Block Kit sections with status emoji, priority colors, and assignee | SATISFIED | formatTaskList produces SectionBlocks with STATUS_EMOJI[task.status], PRIORITY_INDICATOR[task.priority], and assignee. 11 tests verify this. |
| BKIT-02 | 24-01 | Task detail cards show all fields in structured Block Kit layout | SATISFIED | formatTaskDetail produces HeaderBlock + SectionBlock.fields for status, priority, assignee, due_date, project_id, created_by, optional tags, optional description. 17 tests verify this. |
| BKIT-03 | 24-02 | Project list and detail responses use consistent Block Kit formatting | SATISFIED | formatProjectList and formatProjectDetail use same HeaderBlock + SectionBlock.fields pattern. DividerBlocks between list items. 14 tests verify this. |
| BKIT-04 | 24-01 | Notification messages use Block Kit with task summary, status change, and link to relevant command | SATISFIED | formatTaskNotification produces SectionBlock with event label (from EVENT_LABELS map), actor, task status emoji + id/title, priority + assignee, `/tasks show <id>` command. 13 tests verify this. |
| UIDENT-01 | 24-03 | Slack user IDs are resolved to display names for task created_by/assignee fields | SATISFIED | UserIdentityCache.resolve() calls users.info and applies display_name -> real_name -> name -> userId fallback chain. 4 fallback chain tests verify this. |
| UIDENT-02 | 24-03 | User ID to display name mapping is cached in memory with TTL to avoid rate limiting | SATISFIED | UserIdentityCache uses in-memory Map with CacheEntry.expiresAt. Default 5min TTL, configurable. Error results cached at 30s (ERROR_TTL_MS). Cache tests and TTL expiry tests verify this. |
| UIDENT-03 | ORPHANED — required by Phase 24 per REQUIREMENTS.md; not claimed by any Phase 24 plan | Tasks created/claimed via Slack show the resolved display name in CLI/REST/MCP views | BLOCKED | UserIdentityCache provides the resolution mechanism but no Phase 24 production code path calls it. Requires Phase 25 slash command handlers to call `await cache.resolve(command.user_id)` before writing to DB. Plan 03 explicitly defers this to Phase 25 but REQUIREMENTS.md maps UIDENT-03 to Phase 24. |

**Note on UIDENT-03:** This is an ORPHANED requirement — REQUIREMENTS.md assigns it to Phase 24, but none of the three Phase 24 plans claim it in their `requirements` field (Plan 03 only claims UIDENT-01 and UIDENT-02). The ROADMAP success criterion 5 bundles all three behaviors into one statement, but the code only delivers the first two. UIDENT-03 is a Phase 25 dependency.

---

## Anti-Patterns Found

No anti-patterns found in implementation files.

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| — | — | No TODOs, stubs, empty returns, or placeholder comments found | — | — |

**TypeScript compilation:** One pre-existing error in `src/api/server.ts` (FastifyBaseLogger missing `msgPrefix` property — predates Phase 24, documented in Plan 02 SUMMARY as unrelated). The three Phase 24 files compile cleanly.

---

## Human Verification Required

None — all Phase 24 deliverables are pure functions and a cache class, fully verifiable via unit tests. No UI, real-time, or external service behavior to verify at this stage. Runtime behavior of `users.info` scope requires Slack App Dashboard configuration (documented in Plan 03 `user_setup`) but that is a deployment prerequisite, not a code gap.

---

## Gaps Summary

**One gap blocking full goal achievement:**

Success criterion 5 is only partially met. `UserIdentityCache` is a correct, tested implementation that satisfies the resolution mechanism (UIDENT-01) and caching behavior (UIDENT-02). However, the end-to-end requirement that "tasks created or claimed from Slack show the resolved display name in CLI, REST, and MCP output" (UIDENT-03) requires a Phase 25 slash command handler to call `await cache.resolve(command.user_id)` and pass the resolved name as `created_by` or `assignee` when writing tasks to the database.

No production code outside `src/slack/user-identity.ts` and its test file references `UserIdentityCache`. The artifact is an orphan relative to the production call graph.

**Root cause:** REQUIREMENTS.md maps UIDENT-03 to Phase 24, but Plan 03 explicitly scopes Phase 24's responsibility to providing the tool, with Phase 25 responsible for the write-path integration. The ROADMAP success criterion bundles these into one observable truth that cannot be verified until Phase 25 exists.

**Impact on phase advancement:** Phase 24 tooling is complete and Phase 25 can safely proceed with the understanding that UIDENT-03 must be delivered within Phase 25. If REQUIREMENTS.md tracking is important, the Phase 25 plan should claim UIDENT-03.

---

_Verified: 2026-02-17T22:10:00Z_
_Verifier: Claude (gsd-verifier)_
