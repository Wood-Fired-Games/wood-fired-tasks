---
quick_id: 260520-exd
mode: quick-full
description: Validate and escape SQLite FTS search input
must_haves:
  truths:
    - "Malformed FTS5 inputs (e.g. `\"`, `NEAR(`, `*`, `foo OR`, unmatched quotes) must NEVER cause a 500 over REST or an InternalError over MCP."
    - "Repository-layer FTS syntax errors are caught and converted to a typed `FtsSyntaxError` before crossing the repository boundary."
    - "Service layer maps `FtsSyntaxError` to `ValidationError` with `fieldErrors.search` populated."
    - "Client responses never contain raw SQLite error text (no `fts5:`, no `unterminated string`, etc.)."
    - "Valid FTS5 queries (simple terms, phrases, boolean, prefix) continue to return tasks correctly."
    - "Existing 200-character cap and a new 32-term cap are enforced before SQLite sees the query."
  artifacts:
    - src/repositories/errors.ts
    - src/repositories/task.repository.ts
    - src/services/task.service.ts
    - src/schemas/task.schema.ts
    - src/api/routes/tasks/index.ts
    - src/repositories/__tests__/task.repository.test.ts
    - src/services/__tests__/task.service.test.ts
    - src/api/__tests__/tasks-search.test.ts
    - src/mcp/__tests__/task-search-validation.test.ts
  key_links:
    - "src/repositories/task.repository.ts:286 — first FTS MATCH callsite"
    - "src/repositories/task.repository.ts:431 — second FTS MATCH callsite"
    - "src/services/errors.ts — ValidationError class"
    - "src/api/hooks/error-handler.ts:17 — ValidationError → 400 mapping (unchanged)"
    - "src/mcp/errors.ts:15 — ValidationError → InvalidParams mapping (unchanged)"
---

# Quick Task 260520-exd: Validate and escape SQLite FTS search input

## Goal

Catch SQLite FTS5 syntax errors at the repository boundary and surface them
as structured 400 (REST) / InvalidParams (MCP) validation responses, instead
of bubbling raw SQLite parser errors into a generic 500 / InternalError.
Add a term-count cap on the validated input.

## Tasks

### Task 1: Add `FtsSyntaxError` and wrap FTS MATCH queries

**Files:**
- `src/repositories/errors.ts` (new)
- `src/repositories/task.repository.ts`

**Action:**
1. Create `src/repositories/errors.ts` exporting `FtsSyntaxError extends Error`
   plus an `isSqliteFtsSyntaxError(e: unknown): boolean` detector that
   matches `SQLITE_ERROR` whose message contains any of: `fts5:`,
   `unterminated string`, `unknown special query`, `unterminated phrase`.
2. In `task.repository.ts`, extract a private helper
   `executeFilterQuery(query, params, hasSearchFilter)` that calls
   `.all(params)` (or `.get(params)` for count) inside a `try`. If the catch
   detects an FTS syntax error AND `hasSearchFilter` is true, throw
   `new FtsSyntaxError(originalMessage)`. Otherwise rethrow.
3. Use the helper in both `findByFilters` and `countByFilters`.

**Verify:**
- `tsc --noEmit` passes
- `pnpm test src/repositories/__tests__/task.repository.test.ts` passes
- Existing FTS happy-path tests still pass

**Done:**
- `FtsSyntaxError` exists and is thrown for the audit's three confirmed
  malformed inputs.

---

### Task 2: Map `FtsSyntaxError` to `ValidationError` in the service layer

**Files:**
- `src/services/task.service.ts`

**Action:**
1. Import `FtsSyntaxError` from `../repositories/errors.js`.
2. In `listTasks`, wrap the `this.taskRepo.findByFilters(...)` call in a
   `try/catch`. On `FtsSyntaxError`, throw:
   ```ts
   throw new ValidationError({
     search: ['Invalid search syntax. The search query must be a valid SQLite FTS5 expression.'],
   });
   ```
3. Apply the same wrap to `countTasks`.
4. `searchTasks` delegates to `listTasks`, so it inherits behavior — no
   direct change needed.

**Verify:**
- `tsc --noEmit` passes
- `pnpm test src/services/__tests__/task.service.test.ts` passes
- New service-layer tests (added in Task 4) pass

**Done:**
- Service-level malformed search throws `ValidationError` with
  `fieldErrors.search`.

---

### Task 3: Add 32-term cap to schemas

**Files:**
- `src/schemas/task.schema.ts`
- `src/api/routes/tasks/index.ts`

**Action:**
1. In `TaskFiltersSchema.search`, chain `.refine((s) => s.trim().split(/\s+/).filter(Boolean).length <= 32, { message: 'Search query must contain at most 32 terms.' })`.
2. Mirror the same refinement in `QueryTaskFiltersSchema.search` in
   `src/api/routes/tasks/index.ts`.

**Verify:**
- `tsc --noEmit` passes
- A 33-term search is rejected by both REST and service entry points.

**Done:**
- Term cap enforced before SQLite sees the input.

---

### Task 4: Tests — repository, service, REST, MCP

**Files:**
- `src/repositories/__tests__/task.repository.test.ts` (extend)
- `src/services/__tests__/task.service.test.ts` (extend)
- `src/api/__tests__/tasks-search.test.ts` (new)
- `src/mcp/__tests__/task-search-validation.test.ts` (new)

**Action:**

**Repository tests** — append a `describe('FTS syntax errors', ...)` block:
- For each of `"`, `NEAR(`, `*`, `foo OR`, `"unterminated`:
  - `expect(() => taskRepo.findByFilters({ search: <input> })).toThrow(FtsSyntaxError)`
  - Same for `countByFilters`.
- Verify that a valid prefix search (`migr*`) still returns the expected
  task (proves prefix wasn't broken by the catch wrapping).

**Service tests** — append a `describe('search validation', ...)` block:
- For each malformed input, assert
  `expect(() => taskService.listTasks({ search: <input> })).toThrow(ValidationError)`.
- Catch the error and assert `error.fieldErrors.search` contains the
  sanitized message.
- Assert the error message does NOT contain `fts5:` or `SQLITE`.
- Add one test: 33-term search throws `ValidationError` with `fieldErrors.search`.

**REST tests** (new file) — using `server.inject({ method: 'GET', url:
'/api/v1/tasks?project_id=<id>&search=<malformed>' })`:
- For each malformed input, assert `response.statusCode === 400` and the
  body matches `{ error: 'VALIDATION_ERROR', message: 'Validation failed',
  details: { fieldErrors: { search: [<sanitized>] } } }`.
- Assert response body string does NOT contain `fts5`, `SQLITE`, or
  `unterminated`.
- Assert a valid search still returns 200 with matching tasks.

**MCP tests** (new file) — using the existing MCP in-memory test harness
(see `task-tools.test.ts` pattern):
- For each malformed input, call `client.callTool({ name: 'list_tasks',
  arguments: { search: <input> } })` and assert it throws `McpError` with
  `code === ErrorCode.InvalidParams`.
- Assert the error data contains `fieldErrors.search` with the sanitized
  message.
- Assert the error message does NOT leak raw SQLite text.

**Verify:**
- All four test files run green: `pnpm test`
- Total new assertion count: ~25-30

**Done:**
- All acceptance criteria from task #183 are exercised by automated tests.

---

## Risks / Notes
- The `executeFilterQuery` helper must NOT swallow non-FTS SQLite errors —
  it only converts when both (a) the detector matches and (b) the filter
  set actually included a `search` term. Otherwise the original error
  propagates unchanged.
- The Zod refinement runs on the service path (`TaskFiltersSchema`) AND
  the REST path (`QueryTaskFiltersSchema`). Both are required because the
  REST schema coerces query-string types separately.
- No changes to MCP error mapping or REST error handler are needed — both
  already correctly handle `ValidationError`. This minimizes blast radius.
