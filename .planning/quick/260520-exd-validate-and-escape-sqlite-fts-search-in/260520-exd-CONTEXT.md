---
quick_id: 260520-exd
status: ready_for_planning
---

# Quick Task 260520-exd: Validate and escape SQLite FTS search input - Context

**Gathered:** 2026-05-20
**Status:** Ready for planning

<domain>
## Task Boundary

Validate and escape SQLite FTS search input so that malformed FTS5 syntax over
REST/MCP returns a structured 400 validation response rather than an internal
500 with raw SQLite parser error text.

The task is scoped to the `search` filter on task listing — the only consumer of
`tasks_fts MATCH @search` in `src/repositories/task.repository.ts`.

</domain>

<decisions>
## Implementation Decisions

### Remediation strategy
- **Chosen: Option 3 — catch SQLite FTS5 syntax errors at the repository layer
  and map them to a `ValidationError` with a structured `fieldErrors.search`
  payload.** This is the lowest-risk approach: it preserves the full FTS5 query
  language for legitimate users, requires no changes to the FTS schema, and
  satisfies the acceptance criteria directly (clean 400, no 500, no raw SQLite
  error text).

### Error mapping flow
- Repository: catch SQLite errors with `code === 'SQLITE_ERROR'` whose message
  starts with `fts5:` or matches FTS-specific syntax errors (`unterminated
  string`, `unknown special query`, `syntax error`) and re-throw as a new
  `FtsSyntaxError` (internal class).
- Service: catch `FtsSyntaxError` in `listTasks` / `countTasks` /
  `searchTasks` and convert to `ValidationError` with a sanitized message —
  never the raw SQLite text.
- REST: existing `errorHandler` already maps `ValidationError` → 400 with
  `error: 'VALIDATION_ERROR'` and `details.fieldErrors`. No changes needed.
- MCP: existing `convertToMcpError` already maps `ValidationError` →
  `ErrorCode.InvalidParams`. No changes needed.

### Term-count cap
- Add a soft cap: reject `search` if it contains more than 32 whitespace-
  separated tokens (in addition to the existing 200-char length cap). This is
  applied via the Zod schema as a refinement so it raises a normal
  ValidationError without ever hitting SQLite.

### Sanitized client-facing message
- On FTS syntax error, client receives:
  `{ error: 'VALIDATION_ERROR', message: 'Validation failed',
     details: { fieldErrors: { search: ['Invalid search syntax. The search
     query must be a valid SQLite FTS5 expression.'] } } }`
- Internal `request.log.error(...)` still logs the original SQLite error for
  debugging — only the client response is sanitized.

### Test placement
- Repository tests (`src/repositories/__tests__/task.repository.test.ts`):
  malformed inputs throw `FtsSyntaxError` (not bare SQLite errors).
- Service tests (`src/services/__tests__/task.service.test.ts`): malformed
  search inputs throw `ValidationError` with the expected `fieldErrors.search`.
- REST tests (new file `src/api/__tests__/tasks-search.test.ts`): malformed
  search returns 400 with sanitized body; no 500; no raw SQLite text.
- MCP tests (new file `src/mcp/__tests__/task-search-validation.test.ts`):
  malformed search returns `McpError` with code `InvalidParams`.

### Claude's Discretion
- Exact list of FTS5 syntax error message patterns to catch — derive from the
  audit's three confirmed cases (`"`, `NEAR(`, `*`) and SQLite's known FTS5
  error format. Any `SQLITE_ERROR` whose message contains `fts5:` is also
  treated as an FTS syntax error.
- File naming for new tests follows the existing convention
  (`tasks-claim.test.ts`, `task-claim-tool.test.ts`).

</decisions>

<specifics>
## Specific Ideas

Confirmed failure cases from the audit (must all return 400, not 500):
- `"` — "unterminated string"
- `NEAR(` — "fts5: syntax error"
- `*` — "unknown special query"
- `foo OR` — unterminated boolean operator
- Unmatched quotes — e.g. `"unterminated phrase`

Valid searches that must continue to work:
- Simple terms: `login`
- Phrase search: `"database migration"`
- Boolean: `login OR auth`
- Prefix: `migr*`

</specifics>

<canonical_refs>
## Canonical References

- `src/repositories/task.repository.ts` — `findByFilters`, `countByFilters`
  (FTS MATCH callsites)
- `src/services/task.service.ts` — `listTasks`, `searchTasks`, `countTasks`
- `src/services/errors.ts` — `ValidationError` class
- `src/api/hooks/error-handler.ts` — REST error mapping
- `src/mcp/errors.ts` — MCP error mapping
- `src/schemas/task.schema.ts` — `TaskFiltersSchema` (Zod cap location)

</canonical_refs>
