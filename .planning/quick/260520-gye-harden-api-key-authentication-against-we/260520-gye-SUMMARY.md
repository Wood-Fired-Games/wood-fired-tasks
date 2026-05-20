---
title: "Harden API key authentication against weak keys and brute force"
quick_id: 260520-gye
date: 2026-05-20
status: complete
commit: 747d3f5
test_count: 1804
test_files: 140
new_tests: 35
---

# Quick Task 260520-gye: Summary

Resolved security-audit task #182. API authentication was a static
comma-separated key check duplicated across inline `src/api/server.ts` and
unused `src/api/plugins/auth.ts`. It accepted placeholder keys, leaked timing,
had no rate limiting, and exposed a full mutation surface on `0.0.0.0`.

## Result

- 1 consolidated auth plugin replaces 2 duplicated paths.
- Production-mode validation refuses startup on weak, short, or placeholder
  keys.
- Constant-time comparison via `crypto.timingSafeEqual` on SHA-256 hashes
  eliminates the timing side channel and length-leak.
- Global rate limiting via `@fastify/rate-limit` returns HTTP 429 after
  configurable threshold; `/health` is allow-listed.
- Logger redact applies in EVERY environment so `x-api-key` never appears in
  request logs.
- All 1804 tests pass (1769 baseline + 35 new).

## Files modified

- `src/api/plugins/auth.ts` — rewritten as the canonical auth plugin
  (exports default `authPlugin` and named `validateApiKeysForProduction`,
  `hashKey`). Wrapped with `fastify-plugin` so the preHandler hook applies
  to sibling routes in `/api/v1`.
- `src/api/server.ts` — removed inline auth block; registers
  `authPlugin` inside the `/api/v1` scope, registers `@fastify/rate-limit`
  globally before `/health`, moves redact out of production-only branch,
  exports `LOGGER_REDACT_CONFIG` for tests.
- `package.json` + `package-lock.json`:
  - `+ @fastify/rate-limit ^10.3.0` (dep)
  - `+ fastify-plugin ^5.1.0` (dep — used directly by our plugin)
  - `+ pino ^10.3.1` (devDep — used by log-redaction test)

## Files added (tests)

- `src/api/plugins/__tests__/auth.test.ts` — 21 unit tests for
  `validateApiKeysForProduction` rules (empty, short, placeholder phrases,
  exact placeholders, repeated chars) and `hashKey` properties.
- `src/api/__tests__/auth-production.test.ts` — 7 integration tests proving
  `createServer` with `NODE_ENV=production` refuses startup for each
  failure mode and accepts strong 32-char keys.
- `src/api/__tests__/rate-limit.test.ts` — 3 tests proving 429 after
  threshold, brute-force defence (repeated bad auth hits 429), and
  `/health` exemption.
- `src/api/__tests__/auth-logging.test.ts` — 4 tests proving the redact
  config censors `x-api-key`/`authorization`/`cookie`/`password`/`secret`/
  `apiKey`/`token`, and that the auth plugin's warn-on-failure log never
  includes the supplied key.

## Acceptance criteria

1. **`NODE_ENV=production` refuses startup with missing/placeholder/short
   `API_KEYS`** — verified in `auth-production.test.ts:27-60` (empty,
   change-me placeholder, short, repeated-char, example phrase, ANY of
   multiple keys failing).
2. **Valid strong keys continue to work** — verified in
   `auth-production.test.ts:69-93` (32-char mixed key starts server, 200
   on valid auth, 401 on wrong key).
3. **Repeated invalid requests receive 429 after the configured threshold**
   — verified in `rate-limit.test.ts:33-59` (4th of 3-max returns 429; bad
   auth hits 429 before reaching auth check). `/health` is exempt
   (`rate-limit.test.ts:61-67`).
4. **Logs redact `X-API-Key`** — verified in `auth-logging.test.ts:25-95`
   (pino + `LOGGER_REDACT_CONFIG` produces `[REDACTED]`, never the raw
   key; the auth plugin's warn-on-failure log never contains the supplied
   key).
5. **Existing auth tests still pass + All 1769+ tests** — verified via
   `npm test`: 140 test files, 1804 tests, 0 failures.

## Commit

- `97a2806` — `docs(260520-gye): pre-dispatch plan for ...`
- `747d3f5` — `fix(security): harden API key auth against weak keys + brute force (task 182)`

## Notes for task #185 (next wave)

- `src/api/plugins/auth.ts` exports `default authPlugin` (fastify-plugin
  wrapped). Reuse for `/docs` by registering inside the Swagger scope.
- `@fastify/rate-limit` is globally registered; per-route overrides via
  `config.rateLimit` on the route definition (Fastify 5 idiom).
- Logger redact applies in all envs — do not narrow back to production-only.
- Tunables exposed via env: `RATE_LIMIT_MAX` (default 1000),
  `RATE_LIMIT_TIME_WINDOW` (default `'1 minute'`).
