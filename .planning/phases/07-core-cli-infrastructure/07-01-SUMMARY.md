---
phase: 07-core-cli-infrastructure
plan: 01
subsystem: cli-output-infrastructure
tags: [cli, json, output-abstraction, global-flags]
dependency_graph:
  requires: []
  provides:
    - json-output-utility
    - global-json-flag
    - output-mode-detection
  affects:
    - all-cli-commands
    - formatters
    - command-handlers
tech_stack:
  added:
    - JsonEnvelope type for consistent output format
    - Output abstraction (stdout for data, stderr for messages)
  patterns:
    - Global flag registration before subcommand registration
    - parseAsync() for async command handler support
    - process.argv inspection for JSON mode detection
key_files:
  created:
    - src/cli/output/json-output.ts
    - src/cli/prompts/interactive.ts
  modified:
    - src/cli/bin/tasks.ts
    - src/cli/output/formatters.ts
decisions:
  - Use process.argv.includes('--json') for mode detection to avoid circular dependencies
  - Keep parseAsync() for future async command handler compatibility
  - Return plain strings from formatters in JSON mode (no ANSI codes)
  - Auto-fix blocking TypeScript error in interactive.ts (deviation Rule 3)
metrics:
  duration_minutes: 2
  completed_at: "2026-02-13T22:39:56Z"
  tasks_completed: 2
  files_created: 2
  files_modified: 2
  tests_passing: 250
---

# Phase 07 Plan 01: Output Abstraction Layer Summary

**JSON output infrastructure with global --json flag for machine-readable CLI output**

## Objective

Created output abstraction layer that separates data (stdout) from messages (stderr) with consistent JSON envelope format, enabling reliable script consumption and setting the foundation for all 16 new CLI commands in Phase 8.

## Accomplishments

### Task 1: JSON Output Utility and Global --json Flag
- Created `src/cli/output/json-output.ts` with:
  - `JsonEnvelope<T>` type: `{success: boolean, data: T, metadata?: {...}}`
  - `jsonOutput()` function writes JSON envelope to stdout
  - `jsonError()` function writes error envelope to stdout
  - `messageOutput()` function writes informational messages to stderr (respects TTY)
- Updated `src/cli/bin/tasks.ts`:
  - Added global `--json` option BEFORE subcommand registration
  - Switched from `parse()` to `parseAsync()` for async handler support
  - Global option accessible to all commands via Commander.js
- **Commit:** afae4b9

### Task 2: Formatter JSON Mode Support
- Updated `src/cli/output/formatters.ts` with:
  - `isJsonMode()` helper detects --json flag via process.argv
  - `formatStatus()` returns plain text in JSON mode (no chalk colors)
  - `formatPriority()` returns plain text in JSON mode (no chalk colors)
  - `stripAnsiIfJsonMode()` utility for removing ANSI escape codes
- Fixed blocking TypeScript error in `src/cli/prompts/interactive.ts`
  - Validation function parameter could be undefined
  - Added null check before calling validate function
- **Commit:** 519ce9e

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Fixed TypeScript compilation error in interactive.ts**
- **Found during:** Task 2 verification (npx tsc --noEmit)
- **Issue:** `src/cli/prompts/interactive.ts(50,34)` - validate callback parameter type error. The `@clack/prompts` text input validate function receives `string | undefined` but code assumed always string.
- **Fix:** Added null check `if (!v || !options.validate!(v))` before validation call
- **Files modified:** src/cli/prompts/interactive.ts
- **Commit:** 519ce9e
- **Rationale:** Blocked Task 2 verification - TypeScript must compile to proceed. This is a pre-existing file (likely created during phase planning) that had a type safety issue.

## Verification Results

**TypeScript Compilation:**
```
npx tsc --noEmit
✓ No errors
```

**Test Suite:**
```
npm test
✓ 23 test files passed
✓ 250 tests passed
✓ Duration: 6.59s
```

**Global --json Flag:**
```
npx tsx src/cli/bin/tasks.ts --help
✓ --json flag visible in options
✓ Description: "Output as JSON (machine-readable)"
```

**Code Verification:**
- ✓ json-output.ts exports jsonOutput, jsonError, messageOutput
- ✓ json-output.ts exports JsonEnvelope type
- ✓ tasks.ts uses program.option('--json') before subcommand registration
- ✓ tasks.ts uses parseAsync() instead of parse()
- ✓ formatters.ts exports isJsonMode()
- ✓ formatters.ts checks process.argv.includes('--json')
- ✓ formatStatus/formatPriority return plain strings in JSON mode

## Must-Haves Validation

**Truths:**
- ✓ Global --json flag works on all CLI commands without per-command registration
- ✓ JSON output has consistent envelope: {success, data, metadata}
- ⏳ "User runs 'tasks list --json'" - deferred to Phase 8 (command integration)
- ⏳ "User pipes 'tasks list --json | jq'" - deferred to Phase 8 (command integration)

**Artifacts:**
- ✓ src/cli/output/json-output.ts provides JSON envelope formatting and output abstraction
- ✓ src/cli/output/json-output.ts exports jsonOutput, JsonEnvelope, OutputMode
- ✓ src/cli/bin/tasks.ts contains global --json option registration
- ✓ src/cli/output/formatters.ts updated formatters aware of output mode
- ✓ src/cli/output/formatters.ts meets min_lines: 120 (now 142 lines)

**Key Links:**
- ✓ src/cli/bin/tasks.ts → global --json option via program.option before subcommand registration
- ⏳ src/cli/commands/*.ts → jsonOutput function import/call - deferred to Phase 8 (retrofitting existing commands)

## Next Steps

**Phase 8 Prereq (CLI Command Expansion):**
1. Retrofit existing commands (create, list, update) to use jsonOutput() when --json flag set
2. Update command handlers to check isJsonMode() and output JSON instead of formatted tables
3. Ensure all commands respect stdout/stderr separation

**Foundation Complete:**
- Output abstraction layer ready for all 16 new CLI commands
- Global --json flag accessible to all commands via Commander.js
- Formatters detect JSON mode automatically
- Zero regressions - all 250 tests pass

## Self-Check: PASSED

**Created files exist:**
```bash
[ -f "/home/stuart/wood-fired-bugs/src/cli/output/json-output.ts" ] && echo "FOUND: src/cli/output/json-output.ts"
# FOUND: src/cli/output/json-output.ts

[ -f "/home/stuart/wood-fired-bugs/src/cli/prompts/interactive.ts" ] && echo "FOUND: src/cli/prompts/interactive.ts"
# FOUND: src/cli/prompts/interactive.ts
```

**Modified files exist:**
```bash
[ -f "/home/stuart/wood-fired-bugs/src/cli/bin/tasks.ts" ] && echo "FOUND: src/cli/bin/tasks.ts"
# FOUND: src/cli/bin/tasks.ts

[ -f "/home/stuart/wood-fired-bugs/src/cli/output/formatters.ts" ] && echo "FOUND: src/cli/output/formatters.ts"
# FOUND: src/cli/output/formatters.ts
```

**Commits exist:**
```bash
git log --oneline --all | grep -q "afae4b9" && echo "FOUND: afae4b9"
# FOUND: afae4b9

git log --oneline --all | grep -q "519ce9e" && echo "FOUND: 519ce9e"
# FOUND: 519ce9e
```

All files created, all commits recorded, all verifications passed.
