// Row-shape interfaces for the identity tables introduced by migration 008.
// Field names are snake_case to match the SQLite column names exactly — the
// repository row-mapper boundary returns rows as-is (see src/repositories/row-mapper.ts).
// SQLite booleans land as INTEGER (0|1), so we model them as `number`.

import type { PatScope } from '../schemas/pat-scope.schema.js';

export interface User {
  id: number;
  oidc_sub: string | null;
  oidc_provider: string | null;
  email: string | null;
  display_name: string;
  slack_user_id: string | null;
  is_legacy: number;
  is_service_account: number;
  created_at: string;
  disabled_at: string | null;
}

export interface ApiToken {
  id: number;
  user_id: number;
  name: string;
  prefix: string;
  suffix: string;
  hash: string;
  scopes: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
  expires_at: string | null;
  /**
   * Optional project binding (Security Audit finding M1 — task #1635,
   * migration 020). `null` ⇒ unbound: the token may reach every project,
   * which is the pre-#1635 behaviour and the state of every token minted
   * before the column existed. A project id confines the token to that one
   * project; see `bindingSatisfiesProjects`
   * (`src/schemas/pat-scope.schema.ts`).
   */
  project_id: number | null;
}

/**
 * The camelCase boundary projection of a `users` row, produced by the auth
 * chain (Phase 28) after a strategy successfully matches the request.
 *
 * Excludes provisioning / privacy fields (`oidc_sub`, `oidc_provider`,
 * `disabled_at`, `slack_user_id`) — only the fields safe for downstream log
 * lines and route handler use are projected here.
 *
 * Field semantics:
 * - `id` — primary key into `users`; matches `User.id`.
 * - `displayName` — human label; always populated (NOT NULL on the row).
 * - `email` — optional contact address; `null` for legacy + service accounts.
 * - `isLegacy` — `true` iff the row corresponds to a pre-Phase-27 API_KEYS
 *   legacy identity (`users.is_legacy = 1`).
 * - `isServiceAccount` — `true` iff `users.is_service_account = 1`.
 */
export interface AuthenticatedUser {
  id: number;
  displayName: string;
  email: string | null;
  isLegacy: boolean;
  isServiceAccount: boolean;
}

/**
 * Discriminator identifying which auth strategy matched the request.
 *
 * - `'pat'` — Personal Access Token (`Authorization: Bearer wft_pat_...`).
 * - `'session'` — encrypted session cookie (Phase 29; stub returns null in
 *   Phase 28).
 * - `'legacy'` — pre-Phase-27 `X-API-Key` (MIGR-01 break-glass).
 */
export type AuthMethod = 'pat' | 'session' | 'legacy';

/**
 * The shape every strategy returns on a successful match.
 *
 * `tokenId` carries the matching `api_tokens.id` for PAT matches; it is
 * `null` for legacy and session matches (those do not have an associated
 * token row).
 *
 * `scopes` (Security Audit finding M1 — task #1621) is the resolved PAT
 * scope grant for enforcement via `grantSatisfiesScope`
 * (`src/schemas/pat-scope.schema.ts`):
 *   - `null` for session (and legacy) matches — no PAT scope restriction
 *     applies, so these are treated as full-tier.
 *   - the parsed `api_tokens.scopes` array for PAT matches. An empty array
 *     means the token was minted before the taxonomy existed (task #1620)
 *     and is, by explicit legacy rule, also treated as full-tier.
 *
 * `projectId` (Security Audit finding M1 — task #1635) is the second
 * authorization dimension: the token's optional project binding, enforced via
 * `bindingSatisfiesProjects` (`src/schemas/pat-scope.schema.ts`).
 *   - `null` for session and legacy matches, and for any PAT whose
 *     `api_tokens.project_id` is NULL — no project restriction applies.
 *   - a project id for a bound PAT.
 */
export interface AuthResult {
  user: AuthenticatedUser;
  authMethod: AuthMethod;
  tokenId: number | null;
  scopes: PatScope[] | null;
  projectId: number | null;
}

/**
 * Input for `UserRepository.insert` — the just-in-time provisioning shape
 * the OIDC callback hands to the upsert service. `provider` and `sub` are
 * required AND non-empty (the composite UNIQUE on (oidc_provider, oidc_sub)
 * is the OIDC identity key); `email` may be null for providers that
 * decline to share it; `displayName` is required because `users.display_name`
 * is NOT NULL — the upsert service falls back to `email` when the IdP omits
 * a `name` claim.
 */
export interface UserUpsertInput {
  provider: string;
  sub: string;
  email: string | null;
  displayName: string;
}
