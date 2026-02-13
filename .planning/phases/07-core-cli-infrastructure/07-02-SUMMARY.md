---
phase: 07-core-cli-infrastructure
plan: 02
subsystem: cli
tags: [interactive-prompts, tty-detection, flags, user-experience]
dependency_graph:
  requires:
    - phase: 07
      plan: 01
      reason: "Builds on output abstraction layer for proper stdout/stderr separation"
  provides:
    - "Interactive prompt infrastructure with @clack/prompts"
    - "Global --no-input flag for script-friendly operation"
    - "Global --force flag for skipping confirmations"
    - "TTY detection to prevent hanging in non-interactive environments"
  affects:
    - subsystem: cli-commands
      impact: "All future create/update/delete commands can now prompt interactively"
tech_stack:
  added:
    - "@clack/prompts@^1.0.1 - Interactive CLI prompts with cancellation support"
  patterns:
    - "Global flag inheritance via Commander.js program.option()"
    - "TTY detection using process.stdin.isTTY for environment safety"
    - "process.argv inspection for flag detection in utilities"
key_files:
  created:
    - "src/cli/prompts/interactive.ts - Prompt utilities (shouldPrompt, promptForMissing, confirmAction)"
  modified:
    - "src/cli/bin/tasks.ts - Added global --no-input and --force flags"
    - "package.json - Added @clack/prompts dependency"
decisions:
  - what: "Use @clack/prompts over inquirer or prompts"
    why: "Modern, lightweight, handles Ctrl+C automatically, clean API"
  - what: "Check --no-input and --force via process.argv instead of program.opts()"
    why: "Consistent with formatters approach, works from any module without passing options"
  - what: "Fail fast with error when prompts disabled and field missing"
    why: "Better for CI/scripts - immediate feedback rather than silent failure"
  - what: "Return true immediately on --force for confirmAction()"
    why: "Allows destructive operations in scripts/automation without blocking"
metrics:
  duration_minutes: 3
  completed_at: "2026-02-13T22:41:34Z"
  tasks_completed: 2
  files_modified: 3
  commits: 2
  tests_added: 0
  tests_passing: 250
---

# Phase 07 Plan 02: Interactive Prompt Infrastructure Summary

**One-liner:** Interactive CLI prompts with TTY detection and script-friendly --no-input/--force flags using @clack/prompts

## What Was Built

Created interactive prompt infrastructure to enable user-friendly CLI experiences while maintaining script/automation compatibility.

**Core Components:**

1. **Prompt Utilities** (`src/cli/prompts/interactive.ts`):
   - `shouldPrompt()` - TTY detection + --no-input flag check
   - `promptForMissing<T>()` - Prompt for required fields or fail fast
   - `confirmAction()` - Y/N confirmation with --force override

2. **Global Flags** (`src/cli/bin/tasks.ts`):
   - `--no-input` - Disable all interactive prompts
   - `--force` - Skip confirmation prompts

3. **Safety Features**:
   - TTY detection prevents hanging in CI/scripts
   - Ctrl+C cancellation handled automatically by @clack/prompts
   - Clear error messages when prompts disabled

## Tasks Completed

| Task | Name                                             | Commit  | Files                                                       |
| ---- | ------------------------------------------------ | ------- | ----------------------------------------------------------- |
| 1    | Install @clack/prompts and create prompt utilities | 7e40869 | package.json, package-lock.json                             |
| 2    | Add global --no-input and --force flags to CLI   | 928a535 | src/cli/bin/tasks.ts                                        |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed TypeScript type error in promptForMissing**
- **Found during:** Task 1 - TypeScript compilation check
- **Issue:** `defaultValue` parameter type mismatch - @clack/prompts expects string but generic T could be any type
- **Fix:** Used conditional spread with String() coercion: `...(options?.defaultValue !== undefined && { defaultValue: String(options.defaultValue) })`
- **Files modified:** src/cli/prompts/interactive.ts
- **Commit:** 7e40869 (included in Task 1)

**2. [Rule 1 - Bug] Fixed validation function return type**
- **Found during:** Task 1 - TypeScript compilation check
- **Issue:** Validation function must return `string | void`, but wasn't explicitly returning undefined on success
- **Fix:** Added explicit `return undefined` in validation success case
- **Files modified:** src/cli/prompts/interactive.ts
- **Commit:** 7e40869 (included in Task 1)

**3. [Rule 1 - Bug] Fixed validate parameter type handling**
- **Found during:** Task 1 - TypeScript compilation check
- **Issue:** @clack/prompts passes `string | undefined` to validate function, but our callback expected just `string`
- **Fix:** Added null check before calling validate: `if (!v || !options.validate!(v))`
- **Files modified:** src/cli/prompts/interactive.ts
- **Commit:** 7e40869 (included in Task 1)

## Context for Next Agent

**What works:**
- Interactive prompts available via 3 exported functions
- Global flags registered and visible in --help
- TTY detection prevents hanging
- All 250 tests still passing
- TypeScript compiles with no errors

**What's ready for use:**
```typescript
import { promptForMissing, confirmAction, shouldPrompt } from '../prompts/interactive.js';

// Prompt for missing field
const title = await promptForMissing('title', undefined, {
  validate: (v) => v.length > 0
});

// Confirm destructive action
const confirmed = await confirmAction('Delete this task?');
if (!confirmed) return;
```

**Integration points:**
- Plan 07-03 will retrofit existing create/list/update commands
- Commands can use `promptForMissing()` to request required fields
- Delete commands will use `confirmAction()` for safety
- All prompts respect --no-input and --force flags automatically

**Flags behavior:**
- `--no-input`: Disables prompts, throws error if field missing
- `--force`: Skips confirmations, returns true immediately
- Both flags detectable via `process.argv.includes()`

## Success Criteria Met

- [x] @clack/prompts@^1.0.1 installed in package.json
- [x] src/cli/prompts/interactive.ts exists with 3 exported functions
- [x] shouldPrompt() checks --no-input flag and TTY
- [x] promptForMissing() throws error in non-interactive mode
- [x] confirmAction() respects --force flag
- [x] Global --no-input and --force flags in tasks.ts
- [x] No TypeScript errors
- [x] All existing tests still pass (250/250)

## Verification Evidence

```bash
# TypeScript compilation
$ npx tsc --noEmit
✓ No errors

# Test suite
$ npm test
Test Files: 23 passed (23)
Tests: 250 passed (250)

# Dependency installed
$ grep '@clack/prompts' package.json
"@clack/prompts": "^1.0.1"

# Global flags visible
$ npx tsx src/cli/bin/tasks.ts --help
Options:
  --json                 Output as JSON (machine-readable)
  --no-input             Disable interactive prompts (fail on missing required fields)
  --force                Skip confirmation prompts for destructive actions
```

## Commits

1. **7e40869** - `chore(07-02): install @clack/prompts for interactive CLI`
   - Install @clack/prompts@^1.0.1 dependency
   - Enables interactive prompts with TTY detection
   - Supports shouldPrompt, promptForMissing, confirmAction utilities

2. **928a535** - `feat(07-02): add global --no-input and --force flags`
   - Add --no-input flag to disable interactive prompts in scripts
   - Add --force flag to skip confirmation prompts
   - Register flags before subcommands for proper inheritance
   - Flags accessible via program.optsWithGlobals() or process.argv

---

## Self-Check: PASSED

All claimed files and commits verified:
- ✓ src/cli/prompts/interactive.ts exists
- ✓ src/cli/bin/tasks.ts exists
- ✓ package.json exists
- ✓ Commit 7e40869 exists
- ✓ Commit 928a535 exists

---

**Duration:** 3 minutes
**Status:** Complete
**Next Plan:** 07-03 - Retrofit existing commands with --json support and interactive prompts
