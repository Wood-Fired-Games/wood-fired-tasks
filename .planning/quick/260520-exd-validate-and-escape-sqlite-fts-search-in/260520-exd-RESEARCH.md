---
quick_id: 260520-exd
status: research_complete
---

# Quick Task 260520-exd: Research

## Findings

### better-sqlite3 error shape
- `better-sqlite3` throws a JS `Error` whose `.code` is set to the SQLite
  extended error code string (e.g. `SQLITE_ERROR`) and whose `.message`
  contains the raw SQLite text (e.g. `fts5: syntax error near "NEAR("`).
- The error instance is a plain `Error` — there is no dedicated
  `SqliteError` subclass exported, but `instanceof Error` plus a `code`
  string is the documented detection pattern.
- We therefore detect via duck typing:
  ```ts
  function isFtsSyntaxError(e: unknown): e is Error & { code: string } {
    if (!(e instanceof Error)) return false;
    const code = (e as { code?: unknown }).code;
    if (code !== 'SQLITE_ERROR') return false;
    const msg = e.message ?? '';
    return (
      msg.includes('fts5:') ||
      msg.includes('unterminated string') ||
      msg.includes('unknown special query') ||
      msg.includes('unterminated phrase')
    );
  }
  ```

### SQLite FTS5 known error texts (audit-confirmed)
- `"` → `unterminated string`
- `NEAR(` → `fts5: syntax error near "NEAR("`
- `*` → `fts5: unknown special query: *`
- `foo OR` → typically `fts5: syntax error near "<EOF>"`
- Unmatched quotes → `unterminated phrase`

All three audit-confirmed cases and the two extra acceptance-criteria cases
match the `isFtsSyntaxError` check above.

### Where to catch
- Both `findByFilters` and `countByFilters` issue FTS5 MATCH queries via
  `this.db.prepare(query).all(params)` and `.get(params)` respectively.
- Wrapping a single `try/catch` around each `.all()` / `.get()` call
  localizes the conversion. Alternative: extract a helper
  `runFtsAwareQuery(...)` to avoid duplication. Decision: extract the helper
  because both callsites are identical.

### Error class location
- Introduce `FtsSyntaxError` as an *internal* repository-layer error in a new
  file `src/repositories/errors.ts`. It is NOT exported through `services/errors.ts`
  because no consumer outside the repository needs to know about it — the
  service maps it to `ValidationError` immediately.

### Term-count cap implementation
- Zod refinement on the `search` field:
  ```ts
  search: z.string().min(1).max(200).refine(
    (s) => s.trim().split(/\s+/).filter(Boolean).length <= 32,
    { message: 'Search query must contain at most 32 terms.' }
  )
  ```
- Applied in BOTH `src/schemas/task.schema.ts` (`TaskFiltersSchema`) and
  `src/api/routes/tasks/index.ts` (`QueryTaskFiltersSchema`) so REST coerced
  query strings and service-level filters both enforce the cap.

### Pitfalls
- Do NOT rewrite or escape the search string before passing to MATCH — that
  would change the meaning of legitimate FTS queries (phrases, boolean,
  prefix). Catch+map is strictly additive.
- Do NOT log only the sanitized message — the original SQLite error must
  still hit `request.log.error(...)` so operators can debug.
- Better-sqlite3 statements are synchronous, so a regular `try/catch` works;
  no async error propagation concerns.
- The `searchTasks` convenience method delegates to `listTasks`, so it
  inherits the validation behavior automatically — no separate handling
  needed.

### Integration points
- `src/api/hooks/error-handler.ts` — already maps `ValidationError` → 400.
  No change needed.
- `src/mcp/errors.ts` — already maps `ValidationError` → `InvalidParams`.
  No change needed.
- Existing tests in `task.repository.test.ts`, `task.service.test.ts`,
  `tasks.test.ts`, `task-tools.test.ts` continue to pass because the
  happy-path FTS5 behavior is unchanged.

## Approach summary
1. New `src/repositories/errors.ts` exports `FtsSyntaxError` + detector.
2. `task.repository.ts` wraps FTS MATCH queries; on detection, throws
   `FtsSyntaxError(originalMessage)`.
3. `task.service.ts` `listTasks` catches `FtsSyntaxError` and re-throws as
   `ValidationError({ search: ['Invalid search syntax. The search query
   must be a valid SQLite FTS5 expression.'] })`. `countTasks` mirrors.
4. `schemas/task.schema.ts` and `api/routes/tasks/index.ts` add the 32-term
   refinement.
5. Four test files added/extended (repo, service, REST, MCP).
