/**
 * MCP boot-time actor identity resolver (Phase 31 Plan 03, Task 1).
 *
 * The local MCP server (`src/mcp/index.ts`) runs as a stdio subprocess and
 * does NOT go through Fastify — there is no `request.user`. Every MCP write
 * still needs an actor `user.id` so the parallel FK columns introduced by
 * migration 009 (`tasks.created_by_user_id`, `tasks.assignee_user_id`,
 * `task_comments.author_user_id`) are populated alongside the legacy TEXT
 * columns.
 *
 * Resolution precedence — mirrors the auth chain (PAT first, then legacy):
 *
 *   1. `WFT_API_KEY` starts with `wft_pat_` → SHA-256 hash + lookup in
 *      `api_tokens`. The token MUST be unrevoked, unexpired, AND owned by
 *      a non-disabled user (matches REST PAT strategy). Otherwise the
 *      resolver fails closed unless `WFT_MCP_ALLOW_BAD_PAT=1` is set, in
 *      which case it falls back to mcp-bot with a distinguishing path tag
 *      (`pat-revoked-fallback`, `pat-unknown-fallback`,
 *      `pat-expired-fallback`, or `pat-user-disabled-fallback`).
 *
 *   2. `WFT_API_KEY` is any other non-empty string → treat as a legacy key.
 *      SHA-256-compare its hash against every entry from `parseApiKeyEntries(
 *      API_KEYS)`. On a match, look up the legacy `users` row by
 *      `display_name = entry.label` (`is_legacy = 1`). On a miss, or if the
 *      resolved user is disabled, fall through to the service-account
 *      fallback.
 *
 *   3. No `WFT_API_KEY` set → resolve the seeded `mcp-bot` service-account
 *      row via `userRepository.findServiceAccountByName('mcp-bot')`.
 *
 * If even the service-account fallback fails (mcp-bot not seeded), the
 * function throws. That should never happen post-Phase-31-01 — the seeder
 * runs inside `createApp` before this resolver is called — and a thrown
 * error here is the right boot-time failure (MCP cannot operate without an
 * actor identity).
 *
 * Fail-closed PAT default (Phase 31 review WR-02): when WFT_API_KEY is a
 * PAT but the token is unknown/revoked/expired or its owning user is
 * disabled, the resolver throws by default. Operators wanting the legacy
 * silent fallback (e.g. to keep an MCP subprocess alive during a deliberate
 * key rotation) opt back in by setting `WFT_MCP_ALLOW_BAD_PAT=1`. This
 * prevents a revoked PAT from being silently demoted to mcp-bot and
 * masking a kill-signal.
 *
 * The resolver is intentionally PURE and SYNCHRONOUS:
 *   - All DB I/O is via the better-sqlite3 prepared statements on the
 *     repositories (sync by design).
 *   - No env reads inside the function — the caller passes
 *     `process.env.WFT_API_KEY` and the parsed `API_KEYS` entries (and
 *     optionally pre-computed `hashedEntries` from `precomputeHashedEntries`,
 *     plus the `allowBadPat` opt-in flag).
 *   - No log writes. The boot path in `src/mcp/index.ts` logs the resolved
 *     identity via `console.error` (stderr) ONCE after this returns.
 *
 * Pitfall 5 (stdio compliance): never `console.log` here. The MCP server
 * speaks JSON-RPC over stdout; any stdout output during boot corrupts the
 * protocol stream. See `src/mcp/__tests__/stdio-compliance.test.ts` and the
 * dedicated assertion in `identity-resolution.test.ts`.
 */
import { timingSafeEqual } from 'node:crypto';
import type { ApiTokenRepository } from '../repositories/api-token.repository.js';
import type { UserRepository } from '../repositories/user.repository.js';
import type { ApiKeyEntry } from '../config/env.js';
import { hashKey, precomputeHashedEntries } from '../api/plugins/auth/keys.js';
import { hashToken, PAT_PREFIX } from '../services/pat-hash.js';
import { isPatScope, type PatScope } from '../schemas/pat-scope.schema.js';

export interface ResolveActorUserIdInput {
  /** Raw `process.env.WFT_API_KEY`, possibly undefined. */
  apiKey: string | undefined;
  apiTokenRepo: ApiTokenRepository;
  userRepo: UserRepository;
  /**
   * Pre-parsed `API_KEYS` entries (caller calls `parseApiKeyEntries(
   * process.env.API_KEYS)` once at boot). Passing them in keeps the
   * resolver pure and lets tests inject fixtures without touching
   * `process.env`.
   *
   * Mutually exclusive with `hashedEntries`; pass one or the other.
   * `apiKeyEntries` is the simpler shape and matches what tests already
   * construct; `hashedEntries` is the pre-computed form the production
   * boot path uses to avoid re-hashing every legacy key on every call
   * (WR-06 mitigation — mirrors the REST legacy strategy's pattern).
   */
  apiKeyEntries?: ApiKeyEntry[];
  /**
   * Pre-computed SHA-256 hashes of every configured API_KEYS entry. The
   * boot path computes this once via `precomputeHashedEntries` and passes
   * it in so the resolver never re-hashes per call (matches the REST
   * legacy strategy in `src/api/plugins/auth/strategies/legacy.ts`).
   *
   * When both `hashedEntries` and `apiKeyEntries` are supplied,
   * `hashedEntries` wins. When neither is supplied, no legacy keys are
   * configured and the legacy path always falls through.
   */
  hashedEntries?: Array<{ hash: Buffer; label: string }>;
  /**
   * WR-02 opt-in: when `true`, an unknown/revoked/expired PAT or a PAT
   * for a disabled user falls back to mcp-bot instead of throwing. When
   * `false` (default), those classes throw so a revoked PAT cannot
   * silently be demoted to the mcp-bot service account.
   *
   * Source in production: `process.env.WFT_MCP_ALLOW_BAD_PAT === '1'`,
   * read once by the caller and passed in.
   */
  allowBadPat?: boolean;
}

/**
 * Discriminated tag for which resolution path produced the actor. Used by
 * the MCP boot wrapper to emit a single INFO line at startup so operators
 * can see which credential class is in play without leaking the key value.
 *
 * The `pat-*-fallback` variants are only producible when `allowBadPat` is
 * set; without it the resolver throws for those classes (WR-02).
 */
export type ResolutionPath =
  | 'pat'
  | 'pat-revoked-fallback'
  | 'pat-unknown-fallback'
  | 'pat-expired-fallback'
  | 'pat-user-disabled-fallback'
  | 'legacy'
  | 'legacy-unmatched-fallback'
  | 'service-account-fallback';

/**
 * Why a PAT was rejected. Internal — used to decide which fallback path
 * tag to emit and which error message to throw when `allowBadPat` is
 * false.
 */
type PatRejectReason = 'unknown' | 'revoked' | 'expired' | 'user-disabled';

/**
 * The boot-resolved MCP actor identity.
 *
 * `scopes` (Security Audit finding M1 — task #1631) carries the PAT grant
 * forward so the per-tool gate in `src/mcp/scope-gate.ts` can enforce it.
 * Semantics deliberately match `request.scopes` in the REST chain
 * (`src/types/fastify.d.ts`), so the SAME `grantSatisfiesScope` predicate
 * interprets both:
 *
 *   - `PatScope[]` — the validated grant from `api_tokens.scopes`, produced
 *     ONLY on the `'pat'` path. May be `[]` for a token minted before the
 *     #1620 taxonomy existed; `grantSatisfiesScope` treats `[]` as full-tier
 *     (the explicit legacy rule).
 *   - `null` — the actor authenticated via a credential class that carries no
 *     PAT scope restriction at all: a legacy `API_KEYS` hash match, the
 *     `mcp-bot` service-account fallback, or any `pat-*-fallback` path (where
 *     the PAT was REJECTED, so its scopes must not be honoured — the actor is
 *     mcp-bot, not the token's owner). Full-tier, mirroring how the REST
 *     chain treats session auth.
 */
export interface ResolvedMcpActor {
  actorUserId: number;
  path: ResolutionPath;
  scopes: PatScope[] | null;
  /**
   * `api_tokens.id` of the PAT that authenticated this process (Security Audit
   * finding M5 — task #1632), or `null` for every other credential class.
   *
   * Threaded into `McpServerContext.tokenId` so the MCP audit producer can
   * fill `audit_events.token_id` with the SAME value the REST chain writes
   * from `request.tokenId` — without it, a token-scoped audit query would see
   * only the REST half of a principal's activity.
   *
   * Non-null on the `'pat'` path ONLY: on a `pat-*-fallback` the token was
   * REJECTED and the resolved actor is mcp-bot, not the token's owner, so
   * attributing rows to that token id would be a lie.
   */
  tokenId: number | null;
}

/**
 * Parse the `api_tokens.scopes` JSON-array column into a validated
 * `PatScope[]`.
 *
 * Deliberately mirrors the private `parseScopes` helper in the REST PAT
 * strategy (`src/api/plugins/auth/strategies/pat.ts`), including its
 * lenient failure mode: non-array JSON, unparseable JSON, and unrecognised
 * scope strings are DROPPED rather than thrown. `assertKnownScopes` at the
 * repository write boundary already rejects unknown scopes before a token is
 * persisted, so this is defense-in-depth against a hand-edited DB, not a
 * validation path.
 *
 * NOTE the security consequence of that leniency, which is identical on both
 * surfaces: a garbage `scopes` column degrades to `[]`, which
 * `grantSatisfiesScope` reads as the legacy FULL-TIER case. That is the
 * deliberate #1620/#1621 trade-off (never silently 403 a pre-taxonomy token)
 * and is why the write boundary, not this reader, is the enforcement point
 * for scope validity.
 *
 * Exported so tests can exercise the column-parsing contract directly.
 */
export function parseGrantedScopes(scopesJson: string): PatScope[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(scopesJson);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed.filter((s): s is PatScope => typeof s === 'string' && isPatScope(s));
}

/**
 * Resolve the active MCP actor user.id from the supplied environment.
 *
 * @throws Error if the service-account fallback is reached but `mcp-bot` is
 *   not seeded. This is treated as a fatal boot error by the caller.
 */
export function resolveActorUserId(input: ResolveActorUserIdInput): number {
  return resolveActorUserIdWithPath(input).actorUserId;
}

/**
 * Variant of `resolveActorUserId` that also returns the resolution path
 * taken plus the PAT grant. The path drives the MCP boot wrapper's one-line
 * INFO log so operators can see at a glance which credential class
 * authenticated this process; the grant (`scopes`, task #1631) is threaded
 * into `McpServerContext` so `src/mcp/scope-gate.ts` can gate mutating tools.
 *
 * Throws the same boot-fatal error as `resolveActorUserId` when the
 * service-account fallback is reached but `mcp-bot` is not seeded, or
 * when a PAT is supplied but is invalid/revoked/expired/owned by a
 * disabled user AND `allowBadPat` is false (the default — see WR-02).
 */
export function resolveActorUserIdWithPath(input: ResolveActorUserIdInput): ResolvedMcpActor {
  const {
    apiKey,
    apiTokenRepo,
    userRepo,
    apiKeyEntries,
    hashedEntries: hashedEntriesArg,
    allowBadPat = false,
  } = input;

  // Path 1: PAT.
  if (apiKey && apiKey.startsWith(PAT_PREFIX)) {
    const row = apiTokenRepo.findByHash(hashToken(apiKey));
    let reject: PatRejectReason | null = null;
    if (row === null) {
      reject = 'unknown';
    } else if (row.revoked_at !== null) {
      reject = 'revoked';
    } else if (row.expires_at !== null) {
      // Mirror src/api/plugins/auth/strategies/pat.ts:100-118: fail closed
      // on unparseable timestamps (NaN < now is false, so without the
      // NaN check a hand-edited DB row with `expires_at = 'soon'` would
      // be treated as still valid).
      const expiresMs = new Date(row.expires_at).getTime();
      if (Number.isNaN(expiresMs) || expiresMs < Date.now()) {
        reject = 'expired';
      }
    }
    // CR-02: require non-disabled user. Mirror pat.ts:120-126's collapse
    // of "user missing" and "user.disabled_at set" into one reasonCode
    // (`user_disabled`) — both fail the same way at this boundary.
    if (reject === null && row !== null) {
      const user = userRepo.findById(row.user_id);
      if (user === null || user.disabled_at !== null) {
        reject = 'user-disabled';
      }
    }

    if (reject === null && row !== null) {
      // #1631: the ONLY path that carries a PAT grant forward. Every other
      // path resolves a DIFFERENT principal (legacy user or mcp-bot) whose
      // authority is not described by this token's scopes, so they return
      // null (= no PAT restriction).
      return {
        actorUserId: row.user_id,
        path: 'pat',
        scopes: parseGrantedScopes(row.scopes),
        // #1632: the ONLY path carrying a token id — see ResolvedMcpActor.
        tokenId: row.id,
      };
    }

    // Rejected. Either throw (default — WR-02 fail-closed) or fall back
    // to mcp-bot with a path tag that identifies the rejection class.
    const fallbackPath: ResolutionPath =
      reject === 'unknown'
        ? 'pat-unknown-fallback'
        : reject === 'revoked'
          ? 'pat-revoked-fallback'
          : reject === 'expired'
            ? 'pat-expired-fallback'
            : 'pat-user-disabled-fallback';
    if (!allowBadPat) {
      throw new Error(
        `MCP boot: WFT_API_KEY is a PAT but the token is ${reject} ` +
          `(${fallbackPath}). Refusing fallback to mcp-bot. ` +
          `Either rotate the PAT, unset WFT_API_KEY, or override with ` +
          `WFT_MCP_ALLOW_BAD_PAT=1.`,
      );
    }
    return {
      actorUserId: resolveMcpBotOrThrow(userRepo),
      path: fallbackPath,
      // The PAT was REJECTED — the resolved actor is mcp-bot, not the
      // token's owner, so neither the token's scopes nor its id may be
      // honoured here (#1632).
      scopes: null,
      tokenId: null,
    };
  }

  // Path 2: legacy hash match. Same constant-time-friendly comparison the
  // legacy strategy at `src/api/plugins/auth/strategies/legacy.ts` uses:
  // hash the supplied key once, then `timingSafeEqual` against EVERY
  // configured hash. Match position is irrelevant for the resolver (we
  // just need the label) but the loop preserves the existing timing
  // discipline so the helper is safe to copy into other boot paths later.
  //
  // WR-06: prefer pre-computed `hashedEntries` (matches the REST legacy
  // strategy's pattern); fall back to hashing on the fly if only
  // `apiKeyEntries` was supplied (tests use this shape).
  if (apiKey && apiKey.length > 0) {
    const hashedEntries =
      hashedEntriesArg !== undefined
        ? hashedEntriesArg
        : apiKeyEntries !== undefined
          ? precomputeHashedEntries(apiKeyEntries)
          : [];
    const suppliedHash = hashKey(apiKey);
    let matchedLabel: string | undefined;
    for (const entry of hashedEntries) {
      if (timingSafeEqual(entry.hash, suppliedHash)) {
        matchedLabel = entry.label;
        // Do NOT break — keep comparison count fixed.
      }
    }
    if (matchedLabel !== undefined) {
      const user = userRepo.findLegacyByDisplayName(matchedLabel);
      // CR-02: also reject if the legacy user is disabled (mirrors REST
      // legacy strategy at strategies/legacy.ts:100-102).
      if (user !== null && user.disabled_at === null) {
        // Legacy API_KEYS entries carry no scope metadata at all — null (=
        // full tier), mirroring how the REST chain treats session auth.
        return { actorUserId: user.id, path: 'legacy', scopes: null, tokenId: null };
      }
    }
    return {
      actorUserId: resolveMcpBotOrThrow(userRepo),
      path: 'legacy-unmatched-fallback',
      scopes: null,
      tokenId: null,
    };
  }

  // Path 3: WFT_API_KEY unset (or empty). Fall back unconditionally.
  return {
    actorUserId: resolveMcpBotOrThrow(userRepo),
    path: 'service-account-fallback',
    scopes: null,
    tokenId: null,
  };
}

function resolveMcpBotOrThrow(userRepo: UserRepository): number {
  const bot = userRepo.findServiceAccountByName('mcp-bot');
  if (!bot) {
    throw new Error(
      "MCP boot identity resolution failed: 'mcp-bot' service-account row " +
        'is not seeded. createApp must run identity-seeder before the MCP ' +
        'server boots (Phase 31 Plan 01).',
    );
  }
  return bot.id;
}
