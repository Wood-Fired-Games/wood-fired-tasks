---
phase: 07-core-cli-infrastructure
plan: 03
subsystem: cli-commands
tags: [json-output, interactive-prompts, NO_COLOR, cli-ux]
dependency_graph:
  requires: [07-01, 07-02]
  provides: [cli-json-output, cli-interactive-prompts, cli-no-color]
  affects: [create-command, list-command, update-command]
tech_stack:
  added: []
  patterns: [global-option-access, process-argv-detection, conditional-formatting]
key_files:
  created: []
  modified:
    - src/cli/output/formatters.ts
    - src/cli/commands/create.ts
    - src/cli/commands/list.ts
    - src/cli/commands/update.ts
    - src/cli/__tests__/create.test.ts
    - src/cli/__tests__/list.test.ts
    - src/cli/__tests__/update.test.ts
decisions:
  - "Use program.optsWithGlobals() to access global --json flag from subcommands"
  - "NO_COLOR env var checked via process.env.NO_COLOR !== undefined (any value disables colors)"
  - "Combined shouldUseColor() replaces isJsonMode() checks in formatters (NO_COLOR + --json detection)"
  - "Interactive prompts only run when value missing (promptForMissing returns immediately if value provided)"
  - "JSON mode detection also added to shouldUseColor() to avoid duplicate checks"
metrics:
  duration_minutes: 5
  tasks_completed: 3
  files_modified: 7
  tests_added: 5
  total_tests: 255
  commits: 3
completed: 2026-02-13T22:49:23Z
---

# Phase 7 Plan 3: Command Integration and UX Polish Summary

**One-liner:** Retrofitted create/list/update commands with JSON output, interactive prompts, and NO_COLOR support for production-ready CLI UX.

## What Was Built

Integrated Wave 1 infrastructure (Plan 01 JSON output + Plan 02 interactive prompts) into existing CLI commands, adding production-ready features:

1. **NO_COLOR Standard Compliance** - All formatters respect NO_COLOR environment variable
2. **JSON Output Support** - create/list/update commands support --json flag with envelope format
3. **Interactive Prompts** - create command prompts for missing required fields (title, project, created-by)
4. **Comprehensive Testing** - Added 5 new tests covering JSON output and interactive prompting

### Task 1: NO_COLOR Support

**Files modified:** `src/cli/output/formatters.ts`

Added `shouldUseColor()` helper function that returns false when:
- `NO_COLOR` environment variable is set (any value, per https://no-color.org standard)
- `--json` flag is present (JSON mode never uses colors)

Updated all formatter functions to use `shouldUseColor()`:
- `formatStatus()` - returns plain status strings when colors disabled
- `formatPriority()` - returns plain priority strings when colors disabled
- `formatTaskTable()` - disables header bold and border colors when colors disabled
- `formatTaskDetail()` - disables label bold styling when colors disabled

**Commit:** `30dcedb` - feat(07-03): add NO_COLOR environment variable support

### Task 2: JSON Output and Interactive Prompts

**Files modified:** `src/cli/commands/create.ts`, `src/cli/commands/list.ts`, `src/cli/commands/update.ts`

**create.ts changes:**
- Changed `-t, --title`, `-p, --project`, `-c, --created-by` from `requiredOption()` to `option()` (enables prompting)
- Added imports: `jsonOutput`, `promptForMissing`
- Added `program.optsWithGlobals()` call to check global `--json` flag
- Added interactive prompting for missing title/project/created-by fields
- Added conditional output: JSON envelope to stdout (--json mode) or formatted detail (terminal mode)

**list.ts changes:**
- Added imports: `jsonOutput`, `messageOutput`
- Added `program.optsWithGlobals()` call to check global `--json` flag
- Added conditional output: JSON envelope with count metadata (--json mode) or formatted table (terminal mode)

**update.ts changes:**
- Added imports: `jsonOutput`
- Added `program.optsWithGlobals()` call to check global `--json` flag
- Added conditional output: JSON envelope with task metadata (--json mode) or formatted detail (terminal mode)

**Commit:** `078fb29` - feat(07-03): retrofit commands with JSON output and interactive prompts

### Task 3: Test Coverage

**Files modified:** `src/cli/__tests__/create.test.ts`, `src/cli/__tests__/list.test.ts`, `src/cli/__tests__/update.test.ts`

Added mocks for `json-output` and `prompts` modules to all test files.

Updated test setup to register global options (`--json`, `--no-input`, `--force`) in beforeEach hook (mirrors main CLI program setup).

**create.test.ts:**
- Added test: "outputs JSON when --json flag set" - verifies JSON envelope format
- Added test: "prompts for missing title when not provided" - verifies interactive prompting

**list.test.ts:**
- Added test: "outputs JSON when --json flag set" - verifies JSON envelope with count metadata
- Added test: "JSON output is parseable" - verifies JSON structure and parseability

**update.test.ts:**
- Added test: "outputs JSON when --json flag set" - verifies JSON envelope with task metadata

All tests pass (255 total, no regressions).

**Commit:** `3b15556` - test(07-03): add tests for JSON output and interactive prompts

## Deviations from Plan

None - plan executed exactly as written.

## Verification Results

All success criteria met:

- [x] All 3 commands (create, list, update) support --json flag
- [x] JSON output is parseable (valid JSON envelope on stdout only)
- [x] create command prompts for missing required fields when interactive
- [x] All commands respect NO_COLOR environment variable
- [x] Tests updated with coverage for JSON output and prompts (5 new tests)
- [x] No regressions: all 255 tests pass
- [x] TypeScript compiles without errors

**Manual verification:**
1. TypeScript compilation: ✓ PASS
2. All tests pass: ✓ PASS (255 tests)
3. NO_COLOR support: ✓ Implemented (shouldUseColor() checks process.env.NO_COLOR)
4. JSON output: ✓ Implemented (all commands check --json flag)
5. Interactive prompts: ✓ Implemented (create command uses promptForMissing)

## Integration Points

**Consumes from Plan 01:**
- `jsonOutput()` function for JSON envelope output
- `messageOutput()` function for stderr messages
- `isJsonMode()` detection pattern

**Consumes from Plan 02:**
- `promptForMissing()` for interactive field prompting
- `shouldPrompt()` for TTY detection
- `--no-input` and `--force` global flags

**Provides to Phase 8:**
- Pattern for accessing global options via `program.optsWithGlobals()`
- Pattern for conditional output (JSON vs terminal mode)
- Pattern for interactive prompting with validation
- NO_COLOR compliance across all formatters

## Key Decisions

1. **Global option access pattern:** Use `program.optsWithGlobals()` instead of direct `process.argv` checks for better testability
2. **NO_COLOR standard:** Check `process.env.NO_COLOR !== undefined` (any value disables colors, per https://no-color.org)
3. **Unified color detection:** `shouldUseColor()` replaces individual `isJsonMode()` checks, combining NO_COLOR + --json detection
4. **Prompt behavior:** `promptForMissing()` returns immediately if value already provided (no unnecessary prompting)
5. **Test setup:** Register global options in test setup to mirror real CLI structure (enables testing global flag behavior)

## Technical Notes

**Commander.js global options:**
- Global options must be registered at program level before subcommands
- Access via `program.optsWithGlobals()` from subcommand action handlers
- Global flags appear before subcommand name in argv: `tasks --json list` not `tasks list --json`

**NO_COLOR standard compliance:**
- ANY value of NO_COLOR env var disables colors (empty string, "1", "true", etc.)
- Check via `!== undefined` not truthiness
- Affects all ANSI codes: colors, bold, styling, borders

**JSON mode implications:**
- All data to stdout (machine-readable stream)
- All messages to stderr (human-readable stream, ignored by scripts)
- No ANSI codes in output (including table borders)
- Empty results still return valid JSON envelope

**Interactive prompting:**
- Only runs when `!--no-input` AND `process.stdin.isTTY`
- Throws error if field missing and prompts disabled (clear feedback for CI/scripts)
- Validation applied during prompting (e.g., number validation for project ID)

## Self-Check: PASSED

**Created files:** None (all modifications)

**Modified files verified:**
```bash
✓ FOUND: src/cli/output/formatters.ts (shouldUseColor function added)
✓ FOUND: src/cli/commands/create.ts (jsonOutput, promptForMissing imports)
✓ FOUND: src/cli/commands/list.ts (jsonOutput import)
✓ FOUND: src/cli/commands/update.ts (jsonOutput import)
✓ FOUND: src/cli/__tests__/create.test.ts (JSON output tests)
✓ FOUND: src/cli/__tests__/list.test.ts (JSON output tests)
✓ FOUND: src/cli/__tests__/update.test.ts (JSON output tests)
```

**Commits verified:**
```bash
✓ FOUND: 30dcedb (NO_COLOR support)
✓ FOUND: 078fb29 (JSON output and prompts)
✓ FOUND: 3b15556 (test coverage)
```

**Tests verified:**
```bash
✓ All tests pass (255 total)
✓ TypeScript compiles without errors
✓ No regressions detected
```

## Impact

**Immediate:**
- Users can pipe CLI output to jq: `tasks list --json | jq '.data[].title'`
- Users can disable colors: `NO_COLOR=1 tasks list` (screenshot-friendly)
- Users can create tasks interactively: `tasks create` (no flags needed)
- Scripts can disable prompts: `tasks create --no-input` (CI-friendly)

**For Phase 8 (CLI Expansion):**
- All 16 new commands can follow same patterns for JSON output
- All destructive commands can use `confirmAction()` pattern
- All create commands can use `promptForMissing()` pattern
- All formatters respect NO_COLOR automatically

**For Phase 9 (MCP Expansion):**
- No direct impact (MCP is separate interface)

**For Phase 10 (Testing):**
- Establishes testing patterns for global options
- Demonstrates mock setup for json-output and prompts modules

## Next Steps

1. **Phase 7 Plan 4:** Create comprehensive CLI integration test suite (if planned)
2. **Phase 8:** Implement 16 new CLI commands using these patterns
3. **Documentation:** Update CLI README with --json examples and NO_COLOR note

---

**Duration:** 5 minutes
**Completed:** 2026-02-13T22:49:23Z
**Commits:** 3 (30dcedb, 078fb29, 3b15556)
**Files modified:** 7
**Tests added:** 5
**Total tests:** 255
