---
title: "Verification: Harden API key authentication"
quick_id: 260520-gye
date: 2026-05-20
status: passed
---

# Verification: 260520-gye

## must_haves trace

| Truth | Status | Evidence |
|-------|--------|----------|
| `auth-plugin` (single canonical plugin) | passed | `grep -n "validKeys" src/api/server.ts` → no matches (inline removed). `src/api/server.ts` imports `authPlugin from './plugins/auth.js'` and registers via `api.register(authPlugin)`. `src/api/plugins/auth.ts` is the only file emitting a `preHandler` for auth. |
| `production-validation` | passed | `validateApiKeysForProduction` defined in `src/api/plugins/auth.ts`, invoked at register-time when `process.env.NODE_ENV === 'production'`. Throws synchronously on each failure mode; Fastify bubbles the throw out of `register()` → `createServer` rejects. Asserted by `src/api/__tests__/auth-production.test.ts` (7 tests, all pass). |
| `constant-time` | passed | `hashedKeys` array of 32-byte SHA-256 buffers computed at register-time; `crypto.timingSafeEqual(h, suppliedHash)` for each candidate. Equal-length buffers (always 32 bytes) — never throws. Verified in `src/api/plugins/__tests__/auth.test.ts` (`hashKey` tests, 5/5 pass). |
| `rate-limit` | passed | `@fastify/rate-limit` registered globally before `/health`. `allowList: req => req.url === '/health' || req.url.startsWith('/health/')`. `errorResponseBuilder` returns an Error with `statusCode=429`, `code='TOO_MANY_REQUESTS'`. The project's error handler maps to JSON response. Asserted by `src/api/__tests__/rate-limit.test.ts` (3 tests, all pass). |
| `logging` | passed | `request.log.warn({ ip, route }, '...')` in `src/api/plugins/auth.ts` — supplied key NEVER passed to logger. Redact paths applied in all envs (no NODE_ENV ternary). `LOGGER_REDACT_CONFIG` exported from `server.ts`. Asserted by `src/api/__tests__/auth-logging.test.ts` (4 tests, all pass). |

## Artifacts

| Artifact | Status | Notes |
|----------|--------|-------|
| `src/api/plugins/auth.ts` (rewritten) | exists | 178 lines; default export wrapped in fastify-plugin. |
| `src/api/server.ts` (modified) | exists | Inline auth removed, plugin registered, rate-limit registered, redact moved. |
| `package.json` (+ deps) | exists | `@fastify/rate-limit ^10.3.0`, `fastify-plugin ^5.1.0` in deps; `pino ^10.3.1` in devDeps. |
| `src/api/plugins/__tests__/auth.test.ts` | exists | 21 tests. |
| `src/api/__tests__/auth-production.test.ts` | exists | 7 tests. |
| `src/api/__tests__/rate-limit.test.ts` | exists | 3 tests. |
| `src/api/__tests__/auth-logging.test.ts` | exists | 4 tests. |

## Acceptance criteria

1. ✓ Production refuses startup on missing/placeholder/short API_KEYS
2. ✓ Valid strong keys continue to work
3. ✓ Repeated invalid requests receive 429 after the configured threshold
4. ✓ Logs redact `X-API-Key` (verified with log-output test)
5. ✓ Existing auth tests still pass (`src/api/__tests__/auth.test.ts` — 4/4)
6. ✓ All 1769+ tests pass (1804/1804 final count)

## Test run summary

```
Test Files  140 passed (140)
     Tests  1804 passed (1804)
Duration   49.80s
```

- Baseline before changes: 1769 tests across 136 files.
- New tests added: 35 across 4 new files.
- New files: 140 - 136 = 4 (matches expectation).
- Final: 1769 + 35 = 1804 (matches).

## Static checks

- `npx tsc --noEmit` — clean.
- `npm run lint:deps` (knip) — clean.

## Out-of-scope deferrals (handed off)

- `/docs` (Swagger UI) auth coverage — task #185.
- SSE connection caps — task #185.
- `0.0.0.0` HOST binding hardening — task #185.

## Verdict

**passed** — all acceptance criteria met, must_haves verified, full test
suite green.
