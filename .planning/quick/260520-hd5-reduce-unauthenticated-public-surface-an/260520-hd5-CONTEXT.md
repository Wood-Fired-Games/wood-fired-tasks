---
quick_id: 260520-hd5
status: ready
date: 2026-05-20
---

# Quick Task 260520-hd5: Reduce unauthenticated public surface and bound long-lived connections - Context

**Gathered:** 2026-05-20
**Status:** Ready for planning

<domain>
## Task Boundary

Three exposure points to tighten before open-sourcing:
1. Swagger UI/spec `/docs` and `/docs/json` are reachable without API auth (Swagger is registered before the `/api/v1` auth scope).
2. `/health` returns internal component stats (SSE client count, uptime) — leaks internals.
3. Authenticated SSE endpoint has no per-key/IP/global connection caps — long-lived connection exhaustion vector.

This is task #185 — the last security-audit task before open-source release.
</domain>

<decisions>
## Implementation Decisions

### A. Swagger
- In `NODE_ENV=production`, disable `/docs` and `/docs/json` by default.
- Operator opt-in via explicit `ENABLE_SWAGGER_IN_PRODUCTION=true` flag — when set in production, the canonical auth plugin (`src/api/plugins/auth.ts`, fastify-plugin wrapped) is registered to gate `/docs` and `/docs/json`.
- In non-production (`development`, `test`), `/docs` remains unauthenticated for developer convenience (no regression).

### B. Health
- Default `GET /health` to minimal response: `{ status, timestamp, version }` (no `checks`, no `stats`).
- Add `GET /health/detailed` — same payload as today's `/health` (all `checks` + `stats`). Gated by the **same canonical auth plugin** used for `/api/v1`.
- `/health` (minimal) stays in the `@fastify/rate-limit` allowList for liveness probes. `/health/detailed` is also allow-listed (auth gates it; ops monitoring shouldn't be rate-limited).

### C. SSE caps
- New env tunables on `src/config/env.ts`:
  - `SSE_MAX_CONNECTIONS_PER_KEY` (default `4`)
  - `SSE_MAX_CONNECTIONS_PER_IP` (default `8`)
  - `SSE_MAX_CONNECTIONS` (default `200`)
- Track per-connection: `apiKey` (the supplied X-API-Key value), `ip` (request.ip), in addition to existing fields.
- When a new SSE connection would exceed ANY cap, reject with **HTTP 429** + `Retry-After: 30` header. JSON body `{ error: 'TOO_MANY_CONNECTIONS', message: ... }`.
- Graceful cleanup: existing connections that are closed (raw 'close'/'error') already trigger `removeConnection`. The cap check runs **before** registering the new connection, so no half-open state.
- Cap rejection happens in the `events.ts` route (synchronous SSEManager method `canAccept(apiKey, ip)`), not inside `addConnection`, so the route can shape the HTTP response properly with `Retry-After`.

### Claude's Discretion
- All public health response shape: keep current "status: healthy" string verbatim for /health/detailed; for minimal /health use the same string for compatibility with existing liveness checks (returns 200 unless database is down → 503).
- Test API key value for SSE cap tests: distinct keys via comma-separated `API_KEYS` env so per-key cap can be exercised independent of per-IP cap.
- Retry-After value: 30 seconds (consistent with typical reconnect timing of SSE clients).
- Rate-limit allowList expansion: include `/health/detailed` so authenticated ops monitoring is never throttled (mirrors current `/health` exemption).

</decisions>

<specifics>
## Specific Ideas

- Reuse `src/api/plugins/auth.ts` (default export is fastify-plugin wrapped — survives Fastify scope encapsulation). Register inside the Swagger scope when production + opt-in, and as the gate for `/health/detailed`.
- Mirror task #182 patterns: env var defaults via `process.env.X ?? <default>`, narrow no-leak logging, 401 response shape `{ error: 'UNAUTHORIZED', message: ... }`.
- 429 response shape mirrors `@fastify/rate-limit` errorResponseBuilder pattern: `{ error: 'TOO_MANY_CONNECTIONS', message: ... }`.

</specifics>

<canonical_refs>
## Canonical References

- `src/api/plugins/auth.ts` — canonical auth plugin (default export, fastify-plugin wrapped, task #182).
- `src/api/server.ts` — server composition; rate-limit registered globally with `/health` allowList.
- `src/api/routes/health.ts` — current monolithic health route to be split.
- `src/api/routes/events.ts` — SSE route to gate.
- `src/events/sse-manager.ts` — connection registry to extend with caps.
- `src/config/env.ts` — Zod-validated config schema to extend.

</canonical_refs>
