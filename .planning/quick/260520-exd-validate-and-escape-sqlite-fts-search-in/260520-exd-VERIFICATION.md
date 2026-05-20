---
quick_id: 260520-exd
status: passed
---

# Quick Task 260520-exd: Verification

## Goal
Validate and escape SQLite FTS search input so malformed FTS5 syntax surfaces
as a structured 400 (REST) / InvalidParams (MCP) instead of a 500 with raw
SQLite parser text.

## Must-haves trace

| # | Truth | Evidence | Status |
|---|-------|----------|--------|
| 1 | Malformed FTS5 inputs never cause 500/InternalError | `src/api/__tests__/tasks-search.test.ts` asserts `statusCode === 400` for all 5 audit-confirmed inputs; `src/mcp/__tests__/task-search-validation.test.ts` asserts `isError === true` with `'validation'` text and **no** 'internal error' text | passed |
| 2 | Repository-layer FTS errors caught and converted to `FtsSyntaxError` | `src/repositories/errors.ts` defines the class; `src/repositories/__tests__/task.repository.test.ts` `FTS5 search syntax errors` block asserts `expect(...).toThrow(FtsSyntaxError)` for all 5 inputs across both `findByFilters` and `count` | passed |
| 3 | Service maps `FtsSyntaxError` → `ValidationError` with `fieldErrors.search` populated | `src/services/task.service.ts` listTasks/countTasks try/catch; `src/services/__tests__/task.service.test.ts` `FTS5 search validation` block asserts `instanceof ValidationError` and `fieldErrors.search` defined for all 5 inputs across listTasks/countTasks/searchTasks | passed |
| 4 | Client responses never contain raw SQLite error text | All four test files assert response body string does NOT contain `fts5:`, `SQLITE`, `unterminated string`, or `parse error` | passed |
| 5 | Valid FTS5 queries still return tasks correctly | Repo tests: `valid FTS5 prefix search continues to work`, `phrase`, `boolean`. Service test: `valid simple search still returns results`. REST: `returns 200 with matching tasks for a valid search` + prefix. MCP: `succeeds for a valid simple search` + prefix | passed |
| 6 | 200-character cap + new 32-term cap enforced | `src/schemas/task.schema.ts` + `src/api/routes/tasks/index.ts` both have `.refine(s => ...tokens.length <= 32)`. Service test `rejects search with more than 32 terms via Zod refinement` asserts the 32-term cap; the 200-char cap is preserved by the unchanged `.max(200)` clause | passed |

## Test results

- `npx tsc --noEmit` — clean
- `npx vitest run --root .` — **909 passed, 0 failed** (69 test files)
- Direct REST repro confirms response shape:
  ```json
  {
    "error": "VALIDATION_ERROR",
    "message": "Validation failed",
    "details": {
      "search": ["Invalid search syntax. The search query must be a valid SQLite FTS5 expression."]
    }
  }
  ```

## Acceptance-criteria mapping (task #183)

| Criterion | Verified by |
|-----------|-------------|
| Valid searches still return expected tasks | repo / service / REST / MCP happy-path tests |
| Malformed inputs return structured 400 over REST for `"`, `NEAR(`, `*`, `foo OR`, unmatched quotes | `tasks-search.test.ts` parameterized for-loop |
| Clean MCP validation error for same inputs | `task-search-validation.test.ts` parameterized for-loop |
| No 500 status | explicit `expect(...).not.toBe(500)` and `not.toContain('internal error')` checks |
| No raw SQLite text exposed to clients | explicit string-not-contains assertions in REST + MCP tests |

## Status: PASSED

All must-haves satisfied with automated test coverage. No human-needed items.
No gaps found.
