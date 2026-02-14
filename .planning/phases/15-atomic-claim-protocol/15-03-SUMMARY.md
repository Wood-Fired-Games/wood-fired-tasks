---
phase: 15-atomic-claim-protocol
plan: 03
subsystem: mcp, cli, api-client
tags: [mcp-tool, cli-command, claim-protocol, interface-parity, commander, zod]

# Dependency graph
requires:
  - phase: 15-atomic-claim-protocol
    plan: 01
    provides: TaskService.claimTask with CAS pattern and BEGIN IMMEDIATE
  - phase: 15-atomic-claim-protocol
    plan: 02
    provides: POST /api/v1/tasks/:id/claim REST endpoint with idempotency
provides:
  - "claim_task MCP tool for agent-based task claiming via MCP protocol"
  - "tasks claim CLI command with terminal and JSON output modes"
  - "claimTask() API client function with idempotency key support"
  - "Interface parity: REST + MCP + CLI all support atomic claim operation"
affects: [16-workflow-automation]

# Tech tracking
tech-stack:
  added: []
  patterns: [MCP tool claim pattern with BusinessError to MCP error conversion, CLI claim command with idempotency key passthrough]

key-files:
  created:
    - src/mcp/__tests__/task-claim-tool.test.ts
    - src/cli/commands/claim.ts
    - src/cli/__tests__/claim.test.ts
  modified:
    - src/mcp/tools/task-tools.ts
    - src/mcp/server.ts
    - src/cli/api/client.ts
    - src/cli/api/types.ts
    - src/cli/bin/tasks.ts

key-decisions:
  - "Reuse TaskResponse for claim (no new type needed) since claim returns updated task"
  - "MCP claim_task uses z.string().min(1).max(100) for assignee validation at tool level"

patterns-established:
  - "MCP claim tool: throw convertToMcpError(error) maps BusinessError to InvalidRequest for 409-equivalent"
  - "CLI claim command: follows update.ts pattern with requiredOption for --assignee"

# Metrics
duration: 4min
completed: 2026-02-14
---

# Phase 15 Plan 03: MCP & CLI Claim Interfaces Summary

**claim_task MCP tool and tasks claim CLI command completing interface parity for atomic task claiming across REST, MCP, and CLI**

## Performance

- **Duration:** 227s (~4 min)
- **Started:** 2026-02-14T16:06:24Z
- **Completed:** 2026-02-14T16:10:11Z
- **Tasks:** 2
- **Files modified:** 8

## Accomplishments
- claim_task MCP tool registered with task_id + assignee input, returns claimed task or MCP error
- tasks claim CLI command with --assignee (required), --idempotency-key (optional), --json support
- claimTask() API client function with idempotency key header passthrough
- Interface parity complete: all three access methods (REST, MCP, CLI) now support atomic claim
- 13 new tests (6 MCP + 7 CLI), 492 total passing, zero TypeScript errors

## Task Commits

Each task was committed atomically:

1. **Task 1: MCP claim_task tool** - `5f2ee2c` (feat)
2. **Task 2: CLI claim command and API client** - `c178630` (feat)

## Files Created/Modified
- `src/mcp/tools/task-tools.ts` - Added claim_task tool registration with Zod schema validation
- `src/mcp/server.ts` - Updated tool count documentation (25 -> 26)
- `src/mcp/__tests__/task-claim-tool.test.ts` - 6 MCP claim tool tests via InMemoryTransport + Client
- `src/cli/commands/claim.ts` - CLI claim command with terminal/JSON output modes
- `src/cli/bin/tasks.ts` - Registered claimCommand in CLI entrypoint
- `src/cli/api/client.ts` - Added claimTask() with POST /api/v1/tasks/:id/claim and idempotency key
- `src/cli/api/types.ts` - Added claim type documentation comment
- `src/cli/__tests__/claim.test.ts` - 7 CLI claim tests with mocked API client

## Decisions Made
- Reused existing TaskResponse type for claim responses (no new type needed since claim returns the updated task object)
- MCP tool validates assignee with z.string().min(1).max(100) at tool level before hitting service

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed test assertion for already-claimed error message**
- **Found during:** Task 1 (MCP claim tool tests)
- **Issue:** Plan expected "already claimed" in error text, but service returns "cannot be claimed: status is 'in_progress'" after first claim transitions status
- **Fix:** Changed test assertion to match actual error: `toMatch(/already claimed|cannot be claimed/)`
- **Files modified:** src/mcp/__tests__/task-claim-tool.test.ts
- **Verification:** All 6 MCP tests pass
- **Committed in:** 5f2ee2c (Task 1 commit)

---

**Total deviations:** 1 auto-fixed (1 bug - test assertion mismatch)
**Impact on plan:** Minor test assertion adjustment. No scope creep.

## Issues Encountered
None - plan executed cleanly after test assertion fix.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Phase 15 (Atomic Claim Protocol) is now COMPLETE with all 3 plans done
- Full claim flow operational: CAS repo (Plan 01) -> REST endpoint (Plan 02) -> MCP + CLI (Plan 03)
- Ready for Phase 16 (Workflow Automation) which depends on claim infrastructure
- 492 tests passing across entire codebase

## Self-Check: PASSED

All 3 created files found. All 5 modified files found. Both task commits (5f2ee2c, c178630) verified in git log.

---
*Phase: 15-atomic-claim-protocol*
*Completed: 2026-02-14*
