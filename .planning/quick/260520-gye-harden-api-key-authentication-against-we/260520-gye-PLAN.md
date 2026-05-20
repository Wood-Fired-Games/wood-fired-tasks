---
title: "Harden API key authentication against weak keys and brute force"
quick_id: 260520-gye
date: 2026-05-20
mode: quick-full
must_haves:
  truths:
    - "auth-plugin": "A single Fastify plugin at src/api/plugins/auth.ts is the only auth path. The inline preHandler block in src/api/server.ts is removed."
    - "production-validation": "When NODE_ENV=production, missing/empty/short/placeholder/repeated-char API_KEYS cause createServer/loadConfig to throw before listen() completes."
    - "constant-time": "Supplied keys are compared against configured keys using crypto.timingSafeEqual on SHA-256 hashes of fixed length (32 bytes)."
    - "rate-limit": "@fastify/rate-limit is registered globally. Requests exceeding the limit receive HTTP 429. /health is exempt."
    - "logging": "Invalid auth attempts log at warn level with ip and route, but NEVER the supplied key. Fastify logger redact applies in ALL envs to x-api-key, authorization, cookie, apiKey, secret, password, token paths."
  artifacts:
    - "src/api/plugins/auth.ts (rewritten — single canonical auth plugin)"
    - "src/api/server.ts (inline auth removed, plugin registered, rate-limit registered, redact moved out of prod-only branch)"
    - "package.json (+ @fastify/rate-limit)"
    - "src/api/plugins/__tests__/auth.test.ts (new — plugin unit tests)"
    - "src/api/__tests__/auth-production.test.ts (new — production startup validation tests)"
    - "src/api/__tests__/rate-limit.test.ts (new — 429 after threshold)"
    - "src/api/__tests__/auth-logging.test.ts (new — log redaction)"
  key_links:
    - "src/api/server.ts:169-219 (current inline auth — replace)"
    - "src/api/plugins/auth.ts (existing duplicate — rewrite)"
    - "src/api/__tests__/auth.test.ts (existing tests — must continue to pass)"
---

# Quick Task 260520-gye: Harden API key authentication against weak keys and brute force

## Description

Bugs task #182 (urgent, security). API authentication is a static comma-separated
API key check duplicated across `src/api/server.ts` (inline) and
`src/api/plugins/auth.ts` (unused). It accepts placeholders, leaks timing,
has no rate limiting, and exposes a full mutation surface on `0.0.0.0`.

## Tasks

### Task 1 — Rewrite auth plugin with hardening + add rate-limit dep

**Files:**
- `src/api/plugins/auth.ts` (rewrite)
- `package.json` (add `@fastify/rate-limit`)

**Action:**
1. Run `npm install @fastify/rate-limit@^10` (Fastify 5 compatible).
2. Rewrite `src/api/plugins/auth.ts` to export both a default plugin and a
   named `validateApiKeysForProduction(keys)` helper.
   - Read `process.env.API_KEYS` at register-time, parse comma-separated.
   - If `NODE_ENV === 'production'`, call `validateApiKeysForProduction(keys)`;
     throws on:
     - empty list,
     - any key < 32 chars,
     - any key containing placeholder substring
       (`change-me-to-a-real-key`, `changeme`, `placeholder`, `example`),
     - any key whose lowercased value is exactly `test`, `dev`, or
       `placeholder`,
     - any key that is a single character repeated.
     Error message lists every failing key (by index, never logs key value).
   - Pre-compute `hashedKeys` = each configured key SHA-256-hashed.
   - `preHandler` hook: read `x-api-key` header; if missing → 401 with
     `Missing API key`. Else hash supplied key, compare each `hashedKeys[i]`
     via `crypto.timingSafeEqual` (both 32-byte buffers — never throws).
     If no match → 401 with `Invalid API key`.
   - Log every auth failure at `warn` with `{ ip, route }` — never the key.

**Verify:**
- `node -e "require('@fastify/rate-limit')"` succeeds (dep installed).
- `grep -n "validateApiKeysForProduction\|timingSafeEqual\|sha256" src/api/plugins/auth.ts` shows all three.
- `grep -n "validKeys.has" src/api/plugins/auth.ts` returns 0 lines (old logic gone).

**Done when:**
- Plugin file rewritten with the new logic.
- `@fastify/rate-limit` listed in `dependencies` of `package.json`.

---

### Task 2 — Consolidate server.ts: remove inline auth, register plugin + rate-limit, broaden redact

**Files:**
- `src/api/server.ts`

**Action:**
1. Remove the inline auth block inside the `/api/v1` scope (current lines
   172-201): the `apiKeysRaw` parsing, `validKeys` Set, the `if (validKeys.size === 0)`
   warn, and the `addHook('preHandler', ...)` block.
2. Inside the `/api/v1` scope, add `await api.register(authPlugin);` BEFORE
   route registrations (and after the scope opens).
3. Import `authPlugin` from `./plugins/auth.js`.
4. Register `@fastify/rate-limit` at the top-level (before `/health`):
   ```ts
   await server.register(rateLimit, {
     max: Number(process.env.RATE_LIMIT_MAX ?? 1000),
     timeWindow: process.env.RATE_LIMIT_TIME_WINDOW ?? '1 minute',
     allowList: (req) => req.url === '/health' || req.url.startsWith('/health/'),
     errorResponseBuilder: (_req, ctx) => ({
       error: 'TOO_MANY_REQUESTS',
       message: `Rate limit exceeded, retry in ${ctx.after}`,
     }),
   });
   ```
   Default `max` of 1000 is chosen so the existing test suite (many `server.inject`
   from 127.0.0.1) won't accidentally trip the limiter. Real production deploys
   override via env. A dedicated rate-limit test creates a server with
   `RATE_LIMIT_MAX=3` to exercise the 429 path.
5. Move the logger `redact` config out of the `NODE_ENV === 'production'`
   ternary so it applies in ALL environments (paths stay the same).
6. Keep `transport: pino-pretty` ONLY in `development`.

**Verify:**
- `grep -n "validKeys" src/api/server.ts` returns 0 (inline auth gone).
- `grep -n "@fastify/rate-limit\|fastifyRateLimit\|rateLimit" src/api/server.ts` shows the import and registration.
- `grep -n "redact:" src/api/server.ts | wc -l` is 1 (single redact block, not gated).

**Done when:**
- Inline auth removed, plugin registered, rate-limit registered, redact applied everywhere.

---

### Task 3 — Add tests: production validation, rate-limit, log redaction, plugin unit

**Files:**
- `src/api/plugins/__tests__/auth.test.ts` (new)
- `src/api/__tests__/auth-production.test.ts` (new)
- `src/api/__tests__/rate-limit.test.ts` (new)
- `src/api/__tests__/auth-logging.test.ts` (new)

**Action:**
1. **Plugin unit tests** (`src/api/plugins/__tests__/auth.test.ts`):
   - `validateApiKeysForProduction([])` throws.
   - `validateApiKeysForProduction(['short'])` throws (length).
   - `validateApiKeysForProduction(['change-me-to-a-real-key-xxxxxxxxxx'])` throws (placeholder, even at 32+ chars).
   - `validateApiKeysForProduction(['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'])` throws (repeated char).
   - `validateApiKeysForProduction(['Z'.repeat(32)])` throws (repeated char).
   - `validateApiKeysForProduction(['k1a2b3c4d5e6f7g8h9i0j1k2l3m4n5o6'])` does NOT throw (32 chars, mixed).
2. **Production startup tests** (`src/api/__tests__/auth-production.test.ts`):
   - Save & restore `process.env.NODE_ENV` and `process.env.API_KEYS` around each test.
   - Set `NODE_ENV=production`; set `API_KEYS=change-me-to-a-real-key`; expect
     `createServer({ dbPath: ':memory:' })` to reject with message containing
     "API_KEYS validation failed".
   - Set `NODE_ENV=production`; unset `API_KEYS` (use `''`); expect rejection.
   - Set `NODE_ENV=production`; set `API_KEYS='short'`; expect rejection.
   - Set `NODE_ENV=production`; set `API_KEYS='k1a2b3c4d5e6f7g8h9i0j1k2l3m4n5o6'`
     (32 mixed chars); expect server to start successfully and return 200 for
     valid X-API-Key.
3. **Rate-limit test** (`src/api/__tests__/rate-limit.test.ts`):
   - Set `RATE_LIMIT_MAX=3`, `RATE_LIMIT_TIME_WINDOW='1 minute'`, then create server.
   - Send 4 GETs to `/api/v1/tasks` (with valid key); the 4th returns 429.
   - Send 4 GETs to `/health`; all succeed (rate-limit allowList).
   - Reset env after test.
4. **Log redaction test** (`src/api/__tests__/auth-logging.test.ts`):
   - Use a custom pino stream (or `pino-test`-style capture) when constructing
     server. Simpler: replace `server.log` with a captured logger by passing
     `logger` option... actually `createServer` builds its own logger.
     Approach: spawn server with `LOG_LEVEL=info`, intercept `process.stdout` /
     pino destination via a writable stream. Use Fastify's `loggerInstance`
     override path by exporting a test helper.
   - Simpler-still approach: assert via `vi.spyOn(process.stdout, 'write')`,
     capture every chunk, then send a request with `x-api-key: 'test-key'`,
     assert the captured output contains `[REDACTED]` and does NOT contain
     `'test-key'` in any header field.

**Verify:**
- `npm test -- src/api/plugins/__tests__/auth.test.ts` passes.
- `npm test -- src/api/__tests__/auth-production.test.ts` passes.
- `npm test -- src/api/__tests__/rate-limit.test.ts` passes.
- `npm test -- src/api/__tests__/auth-logging.test.ts` passes.

**Done when:**
- All four new test files pass.

---

### Task 4 — Final regression: full test suite

**Files:** none (verification only).

**Action:**
- Run `npm test`.

**Verify:**
- All 1769+ tests pass (1769 baseline + new tests).
- No errors, no failed suites.

**Done when:**
- Test runner output shows passing test count >= 1769 + new tests.

---

## Out of scope (handed off to task #185)

- `/docs` (Swagger UI) auth coverage.
- SSE connection caps.
- `HOST` binding hardening.
- Removal of the `0.0.0.0` default.

## Notes for #185 agent (recorded in commit message)

- `src/api/plugins/auth.ts` now exports `default authPlugin` and named
  helper `validateApiKeysForProduction`. Reuse the plugin for `/docs` by
  registering it in the Swagger scope.
- `@fastify/rate-limit` is registered globally; per-route overrides via
  `config.rateLimit` on the route definition (Fastify 5 idiom).
- Logger redact applies in all envs — do not narrow it back to production-only.
