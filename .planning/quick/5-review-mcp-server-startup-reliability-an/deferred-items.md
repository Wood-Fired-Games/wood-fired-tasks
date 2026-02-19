# Deferred Items — Quick Task 5

## Pre-existing TypeScript Build Error (out of scope)

**File:** `src/api/server.ts` line 142

**Error:**
```
error TS2345: Argument of type 'FastifyBaseLogger' is not assignable to parameter of type 'Logger'.
  Property 'msgPrefix' is missing in type 'FastifyBaseLogger' but required in type 'BaseLogger'.
```

**Status:** Pre-existed before this task's changes (confirmed via git stash check). Not caused by changes to `migrate.ts` or `mcp/index.ts`. TypeScript `tsc` does not emit `dist/` output when this error exists.

**Impact:** `npm run build` fails but `npm test` passes (839 tests, Vitest uses tsx directly). The MCP server runs via `node --import tsx/esm` in development.

**Action needed:** Fix Fastify logger type mismatch in `src/api/server.ts` in a separate task.
