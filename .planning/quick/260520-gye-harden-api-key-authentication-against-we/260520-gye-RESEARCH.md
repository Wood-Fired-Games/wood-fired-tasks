---
title: "Harden API key authentication - Research"
quick_id: 260520-gye
date: 2026-05-20
---

# Research: Harden API key authentication

## 1. Current state

### Inline auth (src/api/server.ts lines 169-219)
- The `/api/v1` scope registers a `preHandler` hook that:
  - Reads `process.env.API_KEYS` on every server boot.
  - Splits on comma, trims, drops empties → `Set<string>`.
  - On request: 401 with `Missing API key` if header absent; 401 `Invalid API key` if `validKeys.has(apiKey) === false`.
- Comparison: `Set.has(...)` — timing-leaky string equality.
- No production validation, no rate limiting, no audit logging beyond Fastify's default access log.

### Duplicate plugin (src/api/plugins/auth.ts)
- Identical logic to the inline block. Never registered anywhere in the codebase
  (confirmed by repo grep — no `import authPlugin`, no `register(authPlugin)`).
- Effectively dead code.

### Logger redaction (src/api/server.ts lines 70-84)
- Production logger already redacts `req.headers["x-api-key"]` and a handful of
  other secret-bearing fields. This is preserved — we just need to verify it
  survives the consolidation.
- In non-production envs (dev/test) redact is `undefined`. The task asks logs
  to redact `x-api-key` in tests as well. Solution: apply redact in ALL envs,
  retain dev's `pino-pretty` transport. Test logs go to NODE_ENV=test which
  doesn't have transport — redact still applies.

### Tests already in place
- `src/api/__tests__/auth.test.ts` — 4 tests for missing key, invalid key, valid key, POST 401.
- ~7 other test files set `process.env.API_KEYS = 'test-key'` before importing server.

## 2. Library decisions

### @fastify/rate-limit
- **Not currently in package.json.** Verified by inspecting deps & devDeps.
- Latest version `^10.x` is Fastify 5.x compatible (we're on `fastify@^5.8.5`).
- API surface (Fastify 5 idiomatic):
  ```ts
  await server.register(import('@fastify/rate-limit'), {
    max: 100,
    timeWindow: '1 minute',
    keyGenerator: (req) => req.ip,
    skipOnError: false,
    errorResponseBuilder: (req, ctx) => ({
      error: 'TOO_MANY_REQUESTS',
      message: `Rate limit exceeded, retry in ${ctx.after}`,
    }),
  });
  ```
- Returns `429` automatically with `Retry-After` header.
- Plugin registration must happen BEFORE routes for global limit to apply.
- Can be scoped per-route via `config.rateLimit` on a route definition; we want
  global default + skip on `/health`.

### crypto.timingSafeEqual
- Requires `Buffer` inputs of identical length.
- Different lengths throws `RangeError` — guard with length check first.
- Best practice: hash both sides with SHA-256 (32 bytes deterministic) and
  compare hashes. Eliminates length-leak and avoids storing raw secrets in
  memory.

## 3. Implementation sketch

### Plugin (src/api/plugins/auth.ts)
```ts
import { createHash, timingSafeEqual } from 'crypto';
import type { FastifyPluginAsync } from 'fastify';

const PLACEHOLDER_PATTERNS = [
  'change-me-to-a-real-key',
  'changeme',
  'placeholder',
  'example',
  // 'test' / 'dev' rejected by exact match below, not substring, to avoid
  // false-positives on legitimate keys containing those characters
];

function hashKey(key: string): Buffer {
  return createHash('sha256').update(key, 'utf8').digest();
}

export function validateApiKeysForProduction(keys: string[]): void {
  const errors: string[] = [];
  if (keys.length === 0) errors.push('API_KEYS env var must contain at least one key');
  for (const [i, k] of keys.entries()) {
    if (k.length === 0) { errors.push(`key #${i + 1}: empty`); continue; }
    if (k.length < 32) errors.push(`key #${i + 1}: must be at least 32 characters (got ${k.length})`);
    const lower = k.toLowerCase();
    for (const p of PLACEHOLDER_PATTERNS) {
      if (lower.includes(p)) errors.push(`key #${i + 1}: contains placeholder pattern "${p}"`);
    }
    if (['test', 'dev', 'placeholder'].includes(lower)) {
      errors.push(`key #${i + 1}: is a placeholder value`);
    }
    if (k.length > 0 && new Set(k).size === 1) {
      errors.push(`key #${i + 1}: single character repeated (no entropy)`);
    }
  }
  if (errors.length > 0) {
    throw new Error(
      `API_KEYS validation failed for production:\n  - ${errors.join('\n  - ')}\n` +
      `Set API_KEYS to comma-separated values of at least 32 characters each.`
    );
  }
}

const authPlugin: FastifyPluginAsync = async (fastify) => {
  const raw = process.env.API_KEYS || '';
  const keys = raw.split(',').map(k => k.trim()).filter(k => k.length > 0);

  if (process.env.NODE_ENV === 'production') {
    validateApiKeysForProduction(keys);  // throws → boot fails fast
  } else if (keys.length === 0) {
    fastify.log.warn('No API keys configured in API_KEYS env var. All API requests will be rejected.');
  }

  const hashedKeys = keys.map(hashKey);

  fastify.addHook('preHandler', async (request, reply) => {
    const supplied = request.headers['x-api-key'];
    if (typeof supplied !== 'string' || supplied.length === 0) {
      request.log.warn({ ip: request.ip, route: request.url }, 'Auth failure: missing X-API-Key');
      return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'Missing API key. Provide X-API-Key header.' });
    }
    const suppliedHash = hashKey(supplied);
    const matched = hashedKeys.some(h => timingSafeEqual(h, suppliedHash));
    if (!matched) {
      request.log.warn({ ip: request.ip, route: request.url }, 'Auth failure: invalid X-API-Key');
      return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'Invalid API key.' });
    }
  });
};

export default authPlugin;
export { hashKey };
```

### Server consolidation (src/api/server.ts)
- Remove the inline `preHandler` block (lines 184-201).
- Register `authPlugin` inside the `/api/v1` scope: `await api.register(authPlugin);`
- Register `@fastify/rate-limit` globally BEFORE the health route registration
  so health is auto-skipped (we'll configure it to skip `/health`).
- Apply log redaction in all envs (move redact out of the production-only
  branch).

### Tests
- New plugin tests: `src/api/plugins/__tests__/auth.test.ts`
  - validateApiKeysForProduction throws on: empty, short, placeholders, repeated chars
  - validateApiKeysForProduction accepts: 32-char random key
  - Constant-time helper integration: valid key passes, wrong key fails
- New production startup tests: `src/api/__tests__/auth-production.test.ts`
  - createServer with NODE_ENV=production + bad keys → rejects
  - createServer with NODE_ENV=production + strong key → succeeds
  - Reset NODE_ENV after each test
- New rate-limit test: `src/api/__tests__/rate-limit.test.ts`
  - Repeated 401s eventually 429 from same IP
- New log-redaction test: `src/api/__tests__/auth-logging.test.ts`
  - Capture log stream, assert `x-api-key` value not present, key replaced with `[REDACTED]`

## 4. Pitfalls

1. **Module-load-time config read** — Tests set `process.env.API_KEYS` BEFORE
   importing server. The auth plugin reads env at register-time (not boot
   time), so the test ordering works as-is.
2. **`@fastify/rate-limit` and `server.inject`** — `inject()` sets `request.ip`
   to `127.0.0.1`; rate-limit uses `req.ip` by default. Multiple injects from
   the same test will share the same IP "key", so a long-running test file
   could trip the limiter. Mitigation: use a high `max` (e.g. 1000) for the
   global limit so tests don't trigger it; the rate-limit-specific test
   creates a server with a low `max`.
3. **Production keys in CI** — CI sets `NODE_ENV=test`, so validation skipped.
   ✓ Safe.
4. **Logger redaction in test env** — pino with `redact` works without a
   transport. Just need to apply the `redact` config regardless of env.
5. **Existing test keys** — `'test-key'` is 8 chars, contains "test". It would
   FAIL production validation. We must gate validation by NODE_ENV=production,
   so 'test-key' continues to work in test/dev. ✓
6. **Backwards compat for already-deployed installs** — Operators with weak
   prod keys will see a startup failure on upgrade. This is the intended
   behaviour per acceptance criteria. Document the rationale in the commit.

## 5. Integration points

- `src/api/server.ts` — single touch site for plugin registration and rate-limit
- `src/api/plugins/auth.ts` — full rewrite
- `package.json` — add `@fastify/rate-limit`
- Tests — additive, no changes to existing test files unless they break
- Docs/installer scripts — out of scope (task #184 already handled installer
  side of placeholder rejection per latest commits)

## 6. Notes for task #185 (next wave)

- The auth plugin is now exported as `authPlugin` from
  `src/api/plugins/auth.ts`. Task #185 needs `/docs` auth — it can call
  `await server.register(authPlugin)` inside its `/docs` scope or import the
  hashing/constant-time helper.
- Rate-limit is now globally registered with health-skip. Task #185's SSE caps
  can either piggy-back on this (passing `config.rateLimit = { max: ... }` per
  route) or use a separate plugin instance for the SSE endpoint specifically.
- Logger redact paths now applied in all envs; do not remove the production-
  only gate in #185 unless intended.
