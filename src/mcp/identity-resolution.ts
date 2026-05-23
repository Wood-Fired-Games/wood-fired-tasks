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
 *   1. `WFB_API_KEY` starts with `wfb_pat_` → SHA-256 hash + lookup in
 *      `api_tokens`. If the row exists AND is not revoked, return its
 *      `user_id`. Otherwise fall through to the service-account fallback.
 *
 *   2. `WFB_API_KEY` is any other non-empty string → treat as a legacy key.
 *      SHA-256-compare its hash against every entry from `parseApiKeyEntries(
 *      API_KEYS)`. On a match, look up the legacy `users` row by
 *      `display_name = entry.label` (`is_legacy = 1`). On a miss, fall
 *      through to the service-account fallback.
 *
 *   3. No `WFB_API_KEY` set → resolve the seeded `mcp-bot` service-account
 *      row via `userRepository.findServiceAccountByName('mcp-bot')`.
 *
 * If even the service-account fallback fails (mcp-bot not seeded), the
 * function throws. That should never happen post-Phase-31-01 — the seeder
 * runs inside `createApp` before this resolver is called — and a thrown
 * error here is the right boot-time failure (MCP cannot operate without an
 * actor identity).
 *
 * The resolver is intentionally PURE and SYNCHRONOUS:
 *   - All DB I/O is via the better-sqlite3 prepared statements on the
 *     repositories (sync by design).
 *   - No env reads inside the function — the caller passes
 *     `process.env.WFB_API_KEY` and the parsed `API_KEYS` entries.
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
import { hashKey } from '../api/plugins/auth/keys.js';
import { hashToken, PAT_PREFIX } from '../services/pat-hash.js';

export interface ResolveActorUserIdInput {
  /** Raw `process.env.WFB_API_KEY`, possibly undefined. */
  apiKey: string | undefined;
  apiTokenRepo: ApiTokenRepository;
  userRepo: UserRepository;
  /**
   * Pre-parsed `API_KEYS` entries (caller calls `parseApiKeyEntries(
   * process.env.API_KEYS)` once at boot). Passing them in keeps the
   * resolver pure and lets tests inject fixtures without touching
   * `process.env`.
   */
  apiKeyEntries: ApiKeyEntry[];
}

/**
 * Discriminated tag for which resolution path produced the actor. Used by
 * the MCP boot wrapper to emit a single INFO line at startup so operators
 * can see which credential class is in play without leaking the key value.
 */
export type ResolutionPath =
  | 'pat'
  | 'pat-revoked-fallback'
  | 'pat-unknown-fallback'
  | 'legacy'
  | 'legacy-unmatched-fallback'
  | 'service-account-fallback';

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
 * taken. Useful for the MCP boot wrapper's one-line INFO log so operators
 * can see at a glance which credential class authenticated this process.
 *
 * Throws the same boot-fatal error as `resolveActorUserId` when the
 * service-account fallback is reached but `mcp-bot` is not seeded.
 */
export function resolveActorUserIdWithPath(
  input: ResolveActorUserIdInput,
): { actorUserId: number; path: ResolutionPath } {
  const { apiKey, apiTokenRepo, userRepo, apiKeyEntries } = input;

  // Path 1: PAT.
  if (apiKey && apiKey.startsWith(PAT_PREFIX)) {
    const row = apiTokenRepo.findByHash(hashToken(apiKey));
    if (row !== null && row.revoked_at === null) {
      return { actorUserId: row.user_id, path: 'pat' };
    }
    return {
      actorUserId: resolveMcpBotOrThrow(userRepo),
      path: row === null ? 'pat-unknown-fallback' : 'pat-revoked-fallback',
    };
  }

  // Path 2: legacy hash match. Same constant-time-friendly comparison the
  // legacy strategy at `src/api/plugins/auth/strategies/legacy.ts` uses:
  // hash the supplied key once, then `timingSafeEqual` against EVERY
  // configured hash. Match position is irrelevant for the resolver (we
  // just need the label) but the loop preserves the existing timing
  // discipline so the helper is safe to copy into other boot paths later.
  if (apiKey && apiKey.length > 0) {
    const suppliedHash = hashKey(apiKey);
    let matchedLabel: string | undefined;
    for (const entry of apiKeyEntries) {
      const entryHash = hashKey(entry.key);
      if (timingSafeEqual(entryHash, suppliedHash)) {
        matchedLabel = entry.label;
        // Do NOT break — keep comparison count fixed.
      }
    }
    if (matchedLabel !== undefined) {
      const user = userRepo.findLegacyByDisplayName(matchedLabel);
      if (user !== null) {
        return { actorUserId: user.id, path: 'legacy' };
      }
    }
    return {
      actorUserId: resolveMcpBotOrThrow(userRepo),
      path: 'legacy-unmatched-fallback',
    };
  }

  // Path 3: WFB_API_KEY unset (or empty). Fall back unconditionally.
  return {
    actorUserId: resolveMcpBotOrThrow(userRepo),
    path: 'service-account-fallback',
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
