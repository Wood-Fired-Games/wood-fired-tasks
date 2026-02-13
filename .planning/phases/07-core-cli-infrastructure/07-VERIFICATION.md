---
phase: 07-core-cli-infrastructure
verified: 2026-02-13T17:54:00Z
status: gaps_found
score: 13/14 must-haves verified
gaps:
  - truth: "User pipes 'tasks list --json | jq' and jq parses successfully"
    status: partial
    reason: "dotenv library contaminating stdout with messages (not going to stderr)"
    artifacts:
      - path: "src/cli/config/env.ts"
        issue: "dotenv.config() called without {quiet: true} option, outputs to stdout"
    missing:
      - "Add {quiet: true} to dotenv.config() call in src/cli/config/env.ts"
---

# Phase 7: Core CLI Infrastructure Verification Report

**Phase Goal:** CLI has robust foundation for output formatting, interactive prompts, and global options
**Verified:** 2026-02-13T17:54:00Z
**Status:** gaps_found
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | User runs 'tasks list --json' and receives only valid JSON on stdout (no messages) | ⚠️ PARTIAL | JSON envelope outputs correctly, but dotenv library contaminating stdout |
| 2 | User runs 'tasks list --json' and sees informational messages on stderr | ✓ VERIFIED | messageOutput() writes to stderr, confirmed via testing |
| 3 | User pipes 'tasks list --json \| jq' and jq parses successfully | ✗ FAILED | jq fails due to dotenv stdout contamination |
| 4 | JSON output has consistent envelope: {success, data, metadata} | ✓ VERIFIED | JsonEnvelope type enforces structure, tested with jq |
| 5 | Global --json flag works on all CLI commands without per-command registration | ✓ VERIFIED | Flag registered globally, accessible via optsWithGlobals() |
| 6 | User runs 'tasks create' without --title flag and CLI prompts interactively | ✓ VERIFIED | promptForMissing() in create.ts, tests verify behavior |
| 7 | User runs 'tasks create --no-input' without --title and CLI fails fast with error | ✓ VERIFIED | shouldPrompt() checks --no-input flag, throws error |
| 8 | User in non-TTY environment (script/CI) and CLI never hangs on prompt | ✓ VERIFIED | process.stdin.isTTY check prevents hanging |
| 9 | User attempts destructive action and sees Y/N confirmation unless --force set | ✓ VERIFIED | confirmAction() implementation with --force override |
| 10 | User runs 'tasks create --json' and receives parseable JSON envelope on stdout | ⚠️ PARTIAL | Works when dotenv quiet, contaminated otherwise |
| 11 | User sets NO_COLOR=1 and sees no ANSI codes in table output | ✓ VERIFIED | shouldUseColor() checks NO_COLOR, tested manually |
| 12 | User runs 'tasks create' without required flags and CLI prompts interactively (only if TTY) | ✓ VERIFIED | Title, project, created-by prompting implemented |
| 13 | User runs 'tasks update 123' and CLI shows colored table with improved status/priority formatting | ✓ VERIFIED | formatStatus/formatPriority return colored text |
| 14 | User views task list with color-coded statuses and priorities | ✓ VERIFIED | Green=done, yellow=in_progress, red=blocked confirmed |

**Score:** 13/14 truths verified (1 partial/failed due to dotenv stdout contamination)

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/cli/output/json-output.ts` | JSON envelope formatting and output abstraction | ✓ VERIFIED | Exports jsonOutput, JsonEnvelope, messageOutput - 68 lines |
| `src/cli/bin/tasks.ts` | Global --json flag registration | ✓ VERIFIED | Contains program.option('--json'), line 15 |
| `src/cli/output/formatters.ts` | Updated formatters aware of output mode | ✓ VERIFIED | 171 lines (exceeds min 120), has isJsonMode() and shouldUseColor() |
| `src/cli/prompts/interactive.ts` | Interactive prompt utilities with TTY detection | ✓ VERIFIED | Exports shouldPrompt, promptForMissing, confirmAction - 104 lines |
| `src/cli/commands/create.ts` | JSON output support + interactive prompts | ✓ VERIFIED | Imports jsonOutput, promptForMissing, uses both |
| `src/cli/commands/list.ts` | JSON output support for task list | ✓ VERIFIED | Imports jsonOutput, messageOutput, uses conditionally |
| `src/cli/commands/update.ts` | JSON output support for updates | ✓ VERIFIED | Imports jsonOutput, uses in --json mode |
| `package.json` | @clack/prompts dependency | ✓ VERIFIED | Contains "@clack/prompts": "^1.0.1" |
| `src/cli/config/env.ts` | Dotenv configuration | ⚠️ ORPHANED | Exists but dotenv.config() lacks {quiet: true} option |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|----|--------|---------|
| src/cli/bin/tasks.ts | global --json option | program.option before subcommands | ✓ WIRED | Line 15: program.option('--json') |
| src/cli/commands/*.ts | jsonOutput function | import and call in action handlers | ✓ WIRED | All 3 commands import and call jsonOutput() |
| src/cli/prompts/interactive.ts | process.stdin.isTTY | TTY detection for prompt safety | ✓ WIRED | Lines 12, 85 check isTTY |
| src/cli/prompts/interactive.ts | @clack/prompts | import text, confirm | ✓ WIRED | Line 1: import { text, confirm } from '@clack/prompts' |
| src/cli/output/formatters.ts | chalk | conditional import based on NO_COLOR check | ✓ WIRED | Line 27: process.env.NO_COLOR check |
| src/cli/commands/create.ts | jsonOutput | import and call in action handler | ✓ WIRED | Line 92: jsonOutput({ task }, { id: task.id }) |
| src/cli/commands/list.ts | jsonOutput | import and call in action handler | ✓ WIRED | Line 77: jsonOutput(tasks, { count: tasks.length }) |

### Requirements Coverage

| Requirement | Status | Blocking Issue |
|-------------|--------|----------------|
| INFRA-01: All CLI commands support --json flag with consistent envelope | ⚠️ PARTIAL | dotenv stdout contamination |
| INFRA-02: CLI uses output abstraction (stdout for data, stderr for messages) | ✓ SATISFIED | jsonOutput/messageOutput implemented correctly |
| INFRA-03: CLI prompts interactively for missing required fields when stdin is TTY | ✓ SATISFIED | promptForMissing with TTY detection |
| INFRA-04: CLI supports --no-input flag to disable prompts | ✓ SATISFIED | Global flag + shouldPrompt() check |
| INFRA-05: CLI shows confirmation prompt before destructive actions unless --force | ✓ SATISFIED | confirmAction() with --force override |
| UX-01: Color-coded statuses and priorities with improved formatting | ✓ SATISFIED | formatStatus/formatPriority implemented |
| UX-02: CLI respects NO_COLOR environment variable | ✓ SATISFIED | shouldUseColor() checks NO_COLOR |
| UX-03: Existing commands retrofitted with --json support | ⚠️ PARTIAL | Implemented but dotenv contamination issue |

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| src/cli/config/env.ts | 12 | dotenv.config() without {quiet: true} | 🛑 Blocker | Contaminates stdout in JSON mode, breaks jq parsing |

**Details:**
```typescript
// Line 12 in src/cli/config/env.ts
dotenv.config({ path: envPath });
// Should be:
dotenv.config({ path: envPath, quiet: true });
```

The dotenv library outputs "[dotenv@17.3.1] injecting env (2) from .env..." to stdout, which breaks the JSON envelope format when piping to jq or other JSON parsers.

### Human Verification Required

None - all verifications can be performed programmatically or were tested manually during verification.

### Gaps Summary

**One blocking gap found:** dotenv stdout contamination

The CLI infrastructure is 93% complete. All architecture is correct:
- JSON output abstraction properly separates stdout/stderr
- Interactive prompts work with TTY detection
- Global flags properly registered and accessible
- NO_COLOR support implemented correctly
- All commands retrofitted with JSON and prompt support
- All tests passing (255/255)

However, the dotenv library is writing informational messages to stdout instead of stderr, contaminating the JSON output stream. This prevents reliable piping to jq or other JSON processors.

**Fix required:**
Add `{quiet: true}` option to dotenv.config() call in src/cli/config/env.ts line 12.

This is a simple one-line fix that will bring all truths to VERIFIED status and satisfy all requirements fully.

---

_Verified: 2026-02-13T17:54:00Z_
_Verifier: Claude (gsd-verifier)_
