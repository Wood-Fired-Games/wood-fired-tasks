---
title: "Harden API key authentication against weak keys and brute force - Context"
quick_id: 260520-gye
date: 2026-05-20
status: ready_for_planning
---

# Quick Task 260520-gye: Harden API key authentication against weak keys and brute force - Context

**Gathered:** 2026-05-20
**Status:** Ready for planning

<domain>
## Task Boundary

Bugs DB security-audit task #182. API authentication is a static comma-separated
API key check implemented inline in `src/api/server.ts` and duplicated in
unused `src/api/plugins/auth.ts`. Weaknesses to fix:

- Accepts any non-empty `API_KEYS` value (placeholders like
  `change-me-to-a-real-key` are not rejected).
- Compares secrets with normal `Set.has` lookup (timing-leaky).
- No rate limiting for repeated invalid keys.
- API binds to `0.0.0.0` by default in production examples, so weak keys are a
  full mutation surface.

Scope:
- Touch only auth-related code paths: `src/api/server.ts` (inline auth hook
  block), `src/api/plugins/auth.ts` (existing duplicate plugin), and any new
  helpers / tests required.
- Do NOT touch Swagger registration order, SSE plugin, `/health`, or other
  routes — task #185 will handle those.

</domain>

<decisions>
## Implementation Decisions

### Plugin consolidation
- Single Fastify plugin at `src/api/plugins/auth.ts` is the canonical auth path.
- Delete the inline duplicate auth check inside `src/api/server.ts` and replace
  it with a `fastify.register(authPlugin)` registration.
- Keep `/health` exempt from auth (current behavior preserved).

### Production key validation
- Triggered when `NODE_ENV === "production"`.
- Reject startup with a clear `Error` (caught at boot — process exits with
  non-zero) when any key fails the rules below.
- Rules:
  - At least one key must be present (non-empty `API_KEYS`).
  - Minimum 32 characters per key.
  - Reject known placeholder substrings (case-insensitive):
    `change-me-to-a-real-key`, `test`, `dev`, `placeholder`, `changeme`,
    `example`.
  - Reject keys that are a single character repeated (entropy floor).
  - Reject empty / whitespace-only entries.
- Non-production (`NODE_ENV !== "production"`, includes dev, test, undefined):
  warn on weak keys but allow startup so dev/test workflows are not blocked.

### Constant-time comparison
- Normalize each configured key to a `Buffer` at boot.
- On request, hash the supplied key with SHA-256 and compare against
  pre-computed SHA-256 buffers of the configured keys using
  `crypto.timingSafeEqual`.
- Comparing hashes (fixed length) avoids the length-leak that
  `timingSafeEqual` exposes when input buffers differ in length.

### Rate limiting
- Use `@fastify/rate-limit` (canonical Fastify rate limiter).
- Already in dependency tree? Check `package.json`; add only if absent.
- Two-tier model:
  - **Global limit** for all routes: 100 requests / minute / IP (sane default,
    overridable via env `RATE_LIMIT_MAX` / `RATE_LIMIT_TIME_WINDOW`).
  - **Auth-failure penalty**: when the auth plugin rejects a request, return
    `401`; rely on the global limiter to throttle repeated bad requests from
    the same IP. The global limiter naturally produces `429` after the
    threshold.
- Exclude `/health` from rate limiting so liveness probes don't burn budget.

### Logging
- Log invalid auth attempts at `warn` level with: IP, route, timestamp.
- NEVER log the supplied key value.
- Redact `x-api-key` / `X-API-Key` headers in Fastify request logs via the
  `redact` option on the logger so even successful-request logs don't leak.

</decisions>

<specifics>
## Specific Ideas

- Constant-time helper: `src/api/plugins/auth.ts` exports a `timingSafeEqualHex`
  internal helper that takes two hex digests and returns boolean.
- Production validation: `validateApiKeysForProduction(keys: string[]): void`
  throws with a multiline error message listing all failures.
- Tests live next to the plugin: `src/api/plugins/__tests__/auth.test.ts` (new)
  and existing `src/api/__tests__/*` auth-related tests must continue to pass.
- Verify with a single `npm test` run at the end — must show all 1769+ tests
  passing.

</specifics>

<canonical_refs>
## Canonical References

- Fastify 5.x plugin guide: https://fastify.dev/docs/latest/Reference/Plugins/
- `@fastify/rate-limit` v10 (Fastify 5 compatible): https://github.com/fastify/fastify-rate-limit
- Node.js `crypto.timingSafeEqual`: https://nodejs.org/api/crypto.html#cryptotimingsafeequala-b
- Bugs task #182 (this task)
- Bugs task #185 (next wave — SSE caps and `/docs` auth, will also touch
  `src/api/server.ts`)

</canonical_refs>
