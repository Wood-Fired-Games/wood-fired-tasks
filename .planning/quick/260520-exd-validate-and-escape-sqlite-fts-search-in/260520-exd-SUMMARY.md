---
quick_id: 260520-exd
status: complete
description: Validate and escape SQLite FTS search input
verification_status: passed
---

# Quick Task 260520-exd: Summary

## What was done

Catch SQLite FTS5 syntax errors at the repository boundary and map them to a
structured `ValidationError` in the service layer, so the existing REST and
MCP error handlers surface them as a clean 400 / InvalidParams response
without leaking raw SQLite parser text. Added a 32-term cap alongside the
existing 200-character cap on the `search` filter.

## Files modified

### Source
- `src/repositories/errors.ts` (new) — `FtsSyntaxError` class + `isSqliteFtsSyntaxError` detector
- `src/repositories/task.repository.ts` — wrap `findByFilters` and `count` FTS5 MATCH executions; re-throw as `FtsSyntaxError` only when caller passed `filters.search`
- `src/services/task.service.ts` — catch `FtsSyntaxError` in `listTasks` and `countTasks`, re-throw as `ValidationError({ search: [sanitized message] })`
- `src/schemas/task.schema.ts` — add 32-term refinement on `TaskFiltersSchema.search`
- `src/api/routes/tasks/index.ts` — mirror the 32-term refinement on `QueryTaskFiltersSchema.search`

### Tests
- `src/repositories/__tests__/task.repository.test.ts` — new `FTS5 search syntax errors` describe block: 7 syntax-failure assertions + happy-path prefix/phrase/boolean
- `src/services/__tests__/task.service.test.ts` — new `FTS5 search validation` describe block: 15 service-layer assertions including sanitization, term-count cap, and happy path
- `src/api/__tests__/tasks-search.test.ts` (new file) — 8 REST assertions: 400-not-500 for each malformed input, sanitized body, term cap, happy path
- `src/mcp/__tests__/task-search-validation.test.ts` (new file) — 8 MCP assertions: structured validation envelope, no internal-error leak, term cap, happy path

## Test results

- TypeScript: clean (`tsc --noEmit`)
- Full vitest suite: 909 passed, 0 failed (69 files)
- 4 new/extended test files all green

## Design notes

- **Option chosen:** catch SQLite FTS5 syntax errors at the repository boundary
  and re-throw as a typed `FtsSyntaxError`, then map to `ValidationError` in
  the service. Preserves the full FTS5 query language for legitimate users
  (phrase, boolean, prefix all still work). Lowest blast radius.
- **Detector scope:** only `SQLITE_ERROR` whose message contains
  `fts5:`, `unterminated string`, `unknown special query`,
  `unterminated phrase`, `parse error`, or `no such column`.
- **Repo-side guard:** the try/catch only re-throws as `FtsSyntaxError` when
  `filters.search !== undefined`, so unrelated SQLITE_ERRORs from other
  query paths propagate unchanged.
- **Client-side message:** fixed sanitized string. Raw SQLite text is
  preserved on `FtsSyntaxError.originalMessage` for repository-side debugging
  but never crosses the service boundary.
- **No changes to REST `errorHandler` or MCP `convertToMcpError`** — both
  already correctly map `ValidationError`. This keeps the diff minimal.

## Acceptance criteria

All four criteria from task #183 are satisfied with automated coverage:
1. Valid searches still return expected tasks
2. Malformed inputs return a structured 400 over REST
3. Clean MCP validation error returned for same inputs
4. No 500 status; no raw SQLite error text exposed to clients
