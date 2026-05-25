/**
 * Phase 28 (Plan 28-04) — unified auth chain plugin.
 *
 * Replaces the legacy single-strategy plugin at `src/api/plugins/auth.ts`
 * with a three-strategy chain (PAT → session-stub → legacy API_KEYS). The
 * file at `src/api/plugins/auth.ts` survives as a thin re-export shim so
 * existing `import authPlugin from './plugins/auth.js'` callers (server.ts,
 * auth-logging.test.ts) keep working without churn.
 *
 * Plugin responsibilities:
 *   1. Decorate `FastifyRequest` with `user`, `authMethod`, `tokenId`,
 *      `apiKeyLabel` at plugin load (Fastify requires decoration before any
 *      route registers).
 *   2. Validate `process.env.API_KEYS` in production (throws synchronously,
 *      which Fastify bubbles up to createServer → exits with non-zero).
 *   3. Pre-compute SHA-256 hashes of every configured API_KEYS entry once
 *      at register time; feed the result into the legacy strategy on every
 *      request so it never re-hashes.
 *   4. Register a `preHandler` hook that:
 *      a. Short-circuits when `request.routeOptions.config.skipAuth === true`.
 *      b. Walks PAT → session-stub → legacy. First match wins. PAT failure
 *         does NOT fall through to legacy — see `enforceSessionOnly` /
 *         strategy-fail short-circuit below.
 *      c. On a successful match, populates `request.user`, `request.authMethod`,
 *         `request.tokenId` (and `request.apiKeyLabel` for legacy), re-childs
 *         the request logger with `{ user_id, token_id, auth_method,
 *         apiKeyLabel }` so every downstream log line carries audit fields,
 *         and enforces `config.sessionOnly` post-auth.
 *      d. On a strategy `fail` outcome, emits one `auth.failure` warn log via
 *         the Phase 27 `logAuthFailure` helper and returns a uniform 401
 *         (the distinct `reasonCode` lives ONLY in the audit log — never in
 *         the response body).
 *      e. On total fall-through (every strategy returned `skip`), emits a
 *         catch-all `auth.failure` log tagged `strategy: 'legacy'`,
 *         `reasonCode: 'missing_credential'` (per Plan-04 Decision Q6).
 *
 * Side-effect contracts:
 *   - PAT match schedules `setImmediate(() => apiTokenRepository.touchLastUsed(
 *     tokenId))`. The 10-minute Map debounce required by REQUIREMENTS PAT-03
 *     lands in Plan 28-06; this plan ships the naive every-request write.
 *   - The chain NEVER logs successful auth (no `auth.success` line); the
 *     re-childed request logger is the canonical audit trail.
 *
 * fp() wrap with `{ name: 'wft-auth', fastify: '5.x' }` is non-negotiable —
 * without it, sibling routes registered in the same parent scope (the
 * `/api/v1` block in server.ts) bypass the hook entirely. Existing
 * rate-limit.test.ts would catch a regression, but the comment block at the
 * bottom of this file (and at the bottom of the legacy auth.ts) is the
 * primary defence against a reflexive refactor.
 */
import type {
  FastifyPluginAsync,
  FastifyRequest,
  FastifyReply,
} from 'fastify';
import fp from 'fastify-plugin';
import {
  parseApiKeyEntries,
  config,
  type ApiKeyEntry,
} from '../../../config/env.js';
import { hashKey, validateApiKeysForProduction } from './keys.js';
import {
  logAuthFailure,
  type AuthFailureReason,
} from '../../../services/auth-audit.js';
import type {
  AuthenticatedUser,
  AuthResult,
} from '../../../types/identity.js';
import { tryAuth as tryPat, type PatDeps } from './strategies/pat.js';
import { tryAuth as trySession } from './strategies/session.js';
import {
  tryAuth as tryLegacy,
  precomputeHashedEntries,
} from './strategies/legacy.js';
import { shouldTouchLastUsed } from '../../../services/pat-touch-debounce.js';

/**
 * Throws if `preHandler` has not run yet (or if `skipAuth` was set). Use in
 * route handlers / tool helpers that need a non-null `request.user`. The
 * type narrowing is the entire point — once `requireUser` returns, the
 * caller has an `AuthenticatedUser` without further null checks.
 *
 * CR-01 (Phase 30 review) — belt-and-suspenders: check for BOTH `null`
 * (the initialized default via `decorateRequest('user', null)`) AND
 * `undefined` (the value the slot holds when the route was registered
 * OUTSIDE any scope that ran the auth-chain plugin — e.g. a top-level
 * device-flow route mounted as a sibling of the `/api/v1` scope). The
 * scope-wiring fix in server.ts addresses the production wiring, but
 * leaving the guard narrow would silently re-open the bug if a future
 * refactor moved a sessionOnly route outside the chain again.
 */
export function requireUser(
  request: FastifyRequest,
): AuthenticatedUser {
  if (request.user === null || request.user === undefined) {
    throw new Error(
      'requireUser: request.user is null/undefined — auth preHandler did ' +
        'not run, or the route is registered with config.skipAuth=true, ' +
        'or the route is outside any scope that registered the auth chain.',
    );
  }
  return request.user;
}

/**
 * Apply a successful strategy outcome to the request: populate principal
 * slots, then re-child the request logger so every subsequent
 * `request.log.*()` call carries audit fields.
 *
 * `apiKeyLabel` is passed through into the bindings even on non-legacy paths
 * (where it stays `undefined`). This matches the codebase precedent at
 * the pre-split auth.ts:215-216 and the RESEARCH §8 pattern.
 */
function applyPrincipal(
  request: FastifyRequest,
  result: AuthResult,
  apiKeyLabel?: string,
): void {
  request.user = result.user;
  request.authMethod = result.authMethod;
  request.tokenId = result.tokenId;
  if (apiKeyLabel !== undefined) {
    request.apiKeyLabel = apiKeyLabel;
  }
  request.log = request.log.child({
    user_id: result.user.id,
    token_id: result.tokenId,
    auth_method: result.authMethod,
    apiKeyLabel: request.apiKeyLabel,
  });
}

/**
 * Post-auth gate: if the matched route declares `config.sessionOnly: true`
 * AND the active auth method is NOT 'session', return 403. This is the only
 * place "PATs cannot mint PATs" is enforced — Plan 5 registers the
 * `/me/tokens` routes with the flag set.
 *
 * Returns `true` when the gate fired and the reply has been sent; the caller
 * MUST stop processing.
 */
function enforceSessionOnly(
  request: FastifyRequest,
  reply: FastifyReply,
): boolean {
  if (
    request.routeOptions.config.sessionOnly === true &&
    request.authMethod !== 'session'
  ) {
    reply.code(403).send({
      error: 'session_required',
      message:
        'This endpoint cannot be called with a Personal Access Token.',
    });
    return true;
  }
  return false;
}

/**
 * Schedule the best-effort `last_used_at` update for a freshly-matched PAT.
 *
 * Plan 28-06 gates the write through the in-process debounce module
 * (`pat-touch-debounce.ts`) so each token id triggers at most one SQL UPDATE
 * per 10-minute window — satisfying REQUIREMENTS.md PAT-03's
 * "≤ 1 write / 10 min / token" cap. No-op for non-PAT matches
 * (tokenId === null) or when the gate returns `false` (recent write within
 * window).
 *
 * better-sqlite3 is synchronous, so `touchLastUsed` returns `void` — wrap in
 * try/catch (no `.catch(...)` on a void return). Errors are warn-logged but
 * NEVER bubble up.
 */
function scheduleLastUsedTouch(
  fastify: { apiTokenRepository: { touchLastUsed: (id: number) => void } },
  tokenId: number | null,
  log: FastifyRequest['log'],
): void {
  if (tokenId === null) return;
  if (!shouldTouchLastUsed(tokenId)) return;
  setImmediate(() => {
    try {
      fastify.apiTokenRepository.touchLastUsed(tokenId);
    } catch (err) {
      log.warn({ err, tokenId }, 'touchLastUsed failed');
    }
  });
}

/**
 * Send a uniform 401 response after emitting the categorical audit log.
 *
 * Returns `void` so callers `return sendUnauthorized(...)` cleanly from the
 * preHandler hook. The body is intentionally minimal — Threat T-28-04-02
 * keeps `reasonCode` off the wire so callers can't probe distinct failure
 * modes.
 */
function sendUnauthorized(
  request: FastifyRequest,
  reply: FastifyReply,
  strategy: 'pat' | 'session' | 'legacy',
  reasonCode: AuthFailureReason,
): void {
  logAuthFailure(request.log, {
    strategy,
    reasonCode,
    requestId: request.id,
    peerIp: request.ip,
  });
  reply.code(401).send({
    error: 'UNAUTHORIZED',
    message: 'Authentication required',
  });
}

/**
 * Strategy chain threw (DB locked, connection lost, prepared-statement
 * compile error from a runtime migration, etc.). Surface as a categorical
 * 500 — explicitly NOT a 401, because pretending auth failed would
 * mis-route operators and make a degraded DB indistinguishable from a
 * brute-force probe. Two log lines:
 *
 *   1. `auth.error` (request.log.error) — carries the underlying `err`
 *      object for postmortem.
 *   2. `auth.failure` warn line via logAuthFailure — keeps the audit feed
 *      aware that an authentication attempt did NOT succeed during the
 *      outage window. Reuses the Phase 27 AuthFailureReason enum
 *      ('unknown_token') so we don't widen the enum just to carry an
 *      operational signal; the `auth.error` line above is where the
 *      diagnostics live.
 *
 * Response body is `{ error: 'INTERNAL_ERROR' }` — no `reasonCode`, no
 * stack, no token-shaped data. Threat T-28-04-02 still applies.
 *
 * WR-01 (Phase 28 review).
 */
function sendInternalError(
  request: FastifyRequest,
  reply: FastifyReply,
  err: unknown,
): void {
  request.log.error({ err, requestId: request.id }, 'auth.error');
  logAuthFailure(request.log, {
    strategy: 'legacy',
    reasonCode: 'unknown_token',
    requestId: request.id,
    peerIp: request.ip,
  });
  reply.code(500).send({ error: 'INTERNAL_ERROR' });
}

const authChainImpl: FastifyPluginAsync = async (fastify) => {
  // Parse and (in production) validate API_KEYS at register time so a
  // misconfigured prod boot fails fast. Same fail-fast semantics as the
  // pre-split plugin — `validateApiKeysForProduction` throws synchronously
  // and Fastify bubbles the error up to createServer which closes the
  // server and disposes the App (server.ts:345-363 catch).
  const entries: ApiKeyEntry[] = parseApiKeyEntries(process.env.API_KEYS);
  const keys = entries.map((e) => e.key);
  if (process.env.NODE_ENV === 'production') {
    validateApiKeysForProduction(keys);
  } else if (entries.length === 0) {
    fastify.log.warn(
      'No API keys configured in API_KEYS env var. All API requests will be rejected.',
    );
  }
  const hashedEntries = precomputeHashedEntries(entries);

  // Decorators MUST land before any route registers in this scope. The fp()
  // wrap below lifts these into the parent scope so sibling /api/v1/* routes
  // see populated slots after a successful preHandler run.
  fastify.decorateRequest('user', null);
  fastify.decorateRequest('authMethod', null);
  fastify.decorateRequest('tokenId', null);
  // MIGR-01 compat: `apiKeyLabel` decoration retained so existing
  // routes/tests (events.ts SSE fingerprinting, auth-logging.test.ts) keep
  // working. Default `undefined` matches the pre-split contract.
  fastify.decorateRequest('apiKeyLabel', undefined);

  const patDeps: PatDeps = {
    apiTokenRepository: fastify.apiTokenRepository,
    userRepository: fastify.userRepository,
  };

  fastify.addHook(
    'preHandler',
    async (request: FastifyRequest, reply: FastifyReply) => {
      // 0. Route-level skipAuth opt-out (defined but unused in Phase 28 —
      // Plan 4 ships the flag for future Phase 29 /auth/login etc.).
      if (request.routeOptions.config.skipAuth === true) {
        return;
      }

      // WR-01 (Phase 28 review) — wrap the entire chain walk so that a
      // throwing strategy (e.g. `apiTokenRepository.findByHash` raising
      // because the DB is locked) becomes a categorical 500 with an
      // `auth.error` log AND an `auth.failure` audit line, rather than
      // a generic Fastify 500 that the audit aggregator never sees. We
      // deliberately do NOT downgrade to 401 — a degraded DB should not
      // look like a brute-force probe.
      try {
        // 1. PAT
        const patOutcome = await tryPat(request, patDeps);
        if (patOutcome.kind === 'fail') {
          return sendUnauthorized(
            request,
            reply,
            'pat',
            patOutcome.reasonCode,
          );
        }
        if (patOutcome.kind === 'match') {
          applyPrincipal(request, patOutcome.result);
          scheduleLastUsedTouch(
            fastify,
            patOutcome.result.tokenId,
            request.log,
          );
          if (enforceSessionOnly(request, reply)) return;
          return;
        }

        // 2. Session (Phase 29 — real implementation reads
        // request.session.get('user') and re-validates against
        // userRepository.findById; returns 'skip' when no session backend
        // is registered (OIDC-disabled mode) so the legacy strategy still
        // gets a chance.
        const sessionOutcome = await trySession(request, {
          userRepository: fastify.userRepository,
        });
        if (sessionOutcome.kind === 'fail') {
          // Defensive — Phase 28 stub never returns fail. Keep the branch so
          // Phase 29's swap doesn't need to add it.
          return sendUnauthorized(
            request,
            reply,
            'session',
            sessionOutcome.reasonCode,
          );
        }
        if (sessionOutcome.kind === 'match') {
          applyPrincipal(request, sessionOutcome.result);
          if (enforceSessionOnly(request, reply)) return;
          return;
        }

        // 3. Legacy API_KEYS
        const legacyOutcome = await tryLegacy(request, {
          userRepository: fastify.userRepository,
          hashedEntries,
        });
        if (legacyOutcome.kind === 'fail') {
          return sendUnauthorized(
            request,
            reply,
            'legacy',
            legacyOutcome.reasonCode,
          );
        }
        if (legacyOutcome.kind === 'match') {
          applyPrincipal(request, legacyOutcome.result, legacyOutcome.label);
          // Plan 31-05 (MIGR-02): emit one warn log per legacy-authed request
          // so operators can grep their log feed for sunset-readiness reporting
          // (`event: 'legacy_auth_used'`). The onSend hook below stamps the
          // RFC 8594 Deprecation/Sunset headers; this line is the canonical
          // audit signal — the headers are advisory to the client, the log
          // is the operator-side source of truth.
          request.log.warn(
            {
              event: 'legacy_auth_used',
              userId: legacyOutcome.result.user.id,
              apiKeyLabel: legacyOutcome.label,
              requestId: request.id,
              requestUrl: request.url,
              sunset: config.LEGACY_AUTH_SUNSET_DATE,
            },
            'legacy_auth_used',
          );
          if (enforceSessionOnly(request, reply)) return;
          return;
        }

        // 4. Catch-all — no strategy saw a credential. Per Plan-04 Decision
        // Q6, the audit log records `strategy: 'legacy', reasonCode:
        // 'missing_credential'` so the failure mode matches the pre-split
        // plugin's "missing X-API-Key" branch.
        return sendUnauthorized(
          request,
          reply,
          'legacy',
          'missing_credential',
        );
      } catch (err) {
        return sendInternalError(request, reply, err);
      }
    },
  );

  // Plan 31-05 (MIGR-02): RFC 8594 Deprecation + Sunset response headers
  // for every legacy-X-API-Key-authed request. Gated strictly on
  // `request.authMethod === 'legacy'` so PAT, session, anonymous (skipAuth),
  // and failed-auth responses NEVER carry the headers (Pitfall 4 in
  // 31-RESEARCH §Common Pitfalls).
  //
  // Callback-style (4-arg) signature is used INTENTIONALLY rather than async
  // — registering an async onSend hook inside this fp()-wrapped plugin
  // delays `reply.sent` from becoming true synchronously when the preHandler
  // calls `reply.send()` (e.g. from `enforceSessionOnly`'s 403). The
  // me-tokens session-only tests then see the route handler run after the
  // 403 reply was queued. The synchronous callback form keeps reply.send()
  // synchronous, preserving the Phase 28 sessionOnly invariant.
  fastify.addHook(
    'onSend',
    (request, reply, payload, done) => {
      if (request.authMethod === 'legacy') {
        reply.header('Deprecation', 'true');
        reply.header('Sunset', config.LEGACY_AUTH_SUNSET_DATE);
      }
      done(null, payload);
    },
  );
};

/**
 * Wrap with fastify-plugin to escape the encapsulated scope. Without `fp()`
 * the preHandler hook only fires for routes registered INSIDE this plugin —
 * every sibling under `/api/v1/*` would bypass auth entirely. The
 * `{ name: 'wft-auth', fastify: '5.x' }` options match the pre-split
 * plugin's identity so any downstream `fastify.hasPlugin('wft-auth')`
 * checks keep working.
 */
const authChain = fp(authChainImpl, {
  name: 'wft-auth',
  fastify: '5.x',
});

export default authChain;
