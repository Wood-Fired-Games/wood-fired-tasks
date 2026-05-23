// Phase 28 Fastify module augmentations.
//
// This file is the central declaration of the typed surface area for the auth
// chain plugin and its dependents. It augments three ambient interfaces from
// the `fastify` module:
//
//   - FastifyRequest        — adds `user`, `authMethod`, `tokenId` decorators.
//   - FastifyContextConfig  — adds per-route opt-outs (`skipAuth`,
//                              `sessionOnly`).
//   - FastifyInstance       — adds the auth-chain's repository decorations.
//
// The MIGR-01 `apiKeyLabel?: string` augmentation is declared here (was
// previously coupled to the shim at `src/api/plugins/auth.ts` — moved in
// WR-04 fix so the chain module at `src/api/plugins/auth/index.ts` no
// longer depends on import-side-effects from the shim to see its own
// FastifyRequest fields. A future refactor that imports the chain
// module directly (e.g. a standalone test, or removal of the shim once
// `apiKeyLabel` is retired) will now compile cleanly.
//
// `user`, `authMethod`, and `tokenId` are declared NON-optional intentionally:
// the Phase 28 auth plugin calls `fastify.decorateRequest('user', null)` (and
// peers) at plugin load, so every route handler always sees a defined slot
// (either `null` before auth runs, or the populated principal after).

import type { AuthenticatedUser, AuthMethod } from './identity.js';

declare module 'fastify' {
  interface FastifyRequest {
    user: AuthenticatedUser | null;
    authMethod: AuthMethod | null;
    tokenId: number | null;
    /**
     * MIGR-01 legacy compat slot. Populated by the legacy strategy with the
     * derived display-name label of the matched API_KEYS entry (e.g.
     * `key_test-key`). Stays `undefined` on PAT and session matches.
     * Read by `routes/events.ts` SSE fingerprinting; central declaration
     * moved here in WR-04 so the chain module at
     * `src/api/plugins/auth/index.ts` does not silently depend on the
     * shim's import side effects to see this field.
     */
    apiKeyLabel?: string;
  }

  interface FastifyContextConfig {
    /**
     * When `true`, the auth-chain preHandler short-circuits before strategy
     * iteration — the route is reachable without any credentials. Reserved
     * for routes inside the `authPlugin` scope that must remain anonymous
     * (e.g. future Phase 29 `/auth/login`, `/auth/callback`). The existing
     * `/health` exemption uses a scope split and does NOT rely on this flag.
     */
    skipAuth?: boolean;

    /**
     * When `true`, the auth-chain preHandler still runs every strategy, but
     * AFTER a successful match it returns 403 `{ error: 'session_required' }`
     * unless `request.authMethod === 'session'`. Applied to all three
     * `/me/tokens` routes: PATs cannot mint, list, or revoke PATs.
     */
    sessionOnly?: boolean;
  }

  interface FastifyInstance {
    /**
     * Repository decoration registered by the Phase 28 auth plugin. The
     * dynamic `import('...')` form keeps this declaration file free of
     * top-level value imports so it stays a pure declaration unit.
     */
    userRepository: import('../repositories/user.repository.js').UserRepository;

    /**
     * Repository decoration registered by the Phase 28 auth plugin (PAT
     * lifecycle). Insert/revoke/touchLastUsed methods land in Plan 28-04.
     */
    apiTokenRepository: import('../repositories/api-token.repository.js').ApiTokenRepository;
  }
}

// Phase 29 (Plan 29-04): SessionData augmentation for @fastify/secure-session.
//
// The upstream module declares `interface SessionData {}` with no fields; we
// merge per-key types here so call sites get inferred shapes from
// `request.session.get(key)` without casts. Every key is optional — the
// cookie is empty for unauthenticated callers and is populated piecewise as
// the OIDC handshake progresses (`oidc.handshake` → `user` → `idToken`).
declare module '@fastify/secure-session' {
  interface SessionData {
    /**
     * Authenticated user identity, set after a successful OIDC callback.
     * Mirrors AuthenticatedUser (src/types/identity.ts).
     */
    user: {
      id: number;
      displayName: string;
      email: string | null;
      isLegacy: boolean;
      isServiceAccount: boolean;
    };
    /** Epoch milliseconds of the most recent successful sign-in. */
    authenticatedAt: number;
    /**
     * Transient OIDC handshake state, cleared on successful callback.
     * Survives the Google redirect via the cookie.
     */
    'oidc.handshake': {
      pkceVerifier: string;
      state: string;
      nonce?: string;
      redirectAfterLogin: string;
    };
    /**
     * Raw ID token string stashed so /auth/logout can populate
     * `id_token_hint` for RP-initiated logout (29-RESEARCH.md Pitfall 6).
     * ~1 KB; well under the 4 KB cookie cap.
     */
    idToken: string;
    /**
     * One-shot minted-token payload. Set by POST /me/tokens (HTML path);
     * read + cleared by GET /me/tokens via `getFlashAndClear`.
     */
    mintedToken: { id: number; token: string };
    /**
     * Per-session CSRF token (Plan 29-06 generates on first GET, Plan 29-07
     * embeds in forms, Plan 29-06 validates on POST).
     */
    csrf: string;
  }
}
