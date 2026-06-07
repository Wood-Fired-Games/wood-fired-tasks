/**
 * `tasks db mint-token` — bootstrap admin command for Personal Access Tokens.
 *
 * This is the ONLY path to mint the first PAT in v1.6: Phase 28's
 * `POST /api/v1/me/tokens` route is session-only (PAT-04), and browser
 * sessions don't land until Phase 29. The command opens the DB directly
 * via `initDatabase` — no HTTP, no auth chain, no Fastify. The token is
 * printed once on stdout and cannot be retrieved later.
 *
 * Output format (28-CONTEXT.md §"tasks db mint-token CLI Command"):
 *   Token: wft_pat_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
 *   Id: 17
 *   User: 1 (legacy-key)
 *   Scopes: [admin, reader]
 *   Expires: 2027-05-22T00:00:00Z
 *
 * `Scopes` is always printed (empty list as `[]`). `Expires` is omitted
 * entirely when `--expires-at` was not supplied.
 *
 * Threat-model notes (28-07-PLAN.md):
 *   T-28-07-01: never registered as a Fastify route — CLI binary only.
 *   T-28-07-03: ISO format checked by strict regex + Date.parse BEFORE
 *               any DB write; bad input exits 1 cleanly.
 *   T-28-07-04: "User '<arg>' not found." is the single failure message
 *               for all three resolution paths — no oracle on which
 *               lookup missed.
 *   T-28-07-05: runMigrations is invoked before insert; idempotent on
 *               a current schema, surfaces a clear error against a
 *               pre-Phase-27 DB.
 */
import { Command } from 'commander';
import { initDatabase } from '../../db/database.js';
import { runMigrations } from '../../db/migrate.js';
import { resolveDbPath } from '../../config/db-path.js';
import { UserRepository } from '../../repositories/user.repository.js';
import { ApiTokenRepository } from '../../repositories/api-token.repository.js';
import { generateToken } from '../../services/pat-hash.js';
import type { User } from '../../types/identity.js';
import '../config/env.js';

/**
 * Strict ISO-8601 with explicit time + zone designator.
 *
 * Accepts: 2027-05-22T00:00:00Z, 2027-05-22T00:00:00.123Z,
 *          2027-05-22T00:00:00+02:00, 2027-05-22T00:00:00-05:00.
 *
 * Rejects: bare dates (`2027-05-22`), missing TZ (`2027-05-22T00:00:00`),
 * shorthand like `2027` that Date.parse would silently accept. Strict
 * matching prevents `--expires-at 2099` from becoming midnight UTC.
 */
const ISO8601_STRICT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function validateIso(s: string): void {
  if (!ISO8601_STRICT.test(s)) {
    throw new Error(`invalid ISO-8601 timestamp '${s}' (expected e.g. 2027-05-22T00:00:00Z)`);
  }
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`invalid ISO-8601 timestamp '${s}' (Date.parse rejected it)`);
  }
}

/**
 * Resolve `--user <arg>` to a `users` row by trying, in order:
 *   1. Numeric → findById
 *   2. Looks like an email (contains '@') → findByEmail (case-insensitive)
 *   3. Legacy display_name → findLegacyByDisplayName
 *
 * First match wins. Returns null on no match — caller surfaces a single
 * unified error (T-28-07-04).
 */
function resolveUser(repo: UserRepository, arg: string): User | null {
  const trimmed = arg.trim();

  // 1. Numeric — `parseInt('1abc')` would happily return 1, so guard by
  // ensuring the trimmed string round-trips through Number → String.
  const n = Number(trimmed);
  if (Number.isInteger(n) && n > 0 && String(n) === trimmed) {
    const byId = repo.findById(n);
    if (byId) return byId;
  }

  // 2. Email shape — `userRepository.findByEmail` throws on null/empty,
  // so only call it once we know the arg looks like an address.
  if (trimmed.includes('@')) {
    const byEmail = repo.findByEmail(trimmed);
    if (byEmail) return byEmail;
  }

  // 3. Legacy display_name fallback.
  const legacy = repo.findLegacyByDisplayName(trimmed);
  if (legacy) return legacy;

  // 4. Service-account display_name (e.g. `slack-bot` / `mcp-bot`). After the
  // v2.0 auth cutover (#801) removed legacy API_KEYS seeding, service accounts
  // are the only display-name-addressable seeded rows — and the documented
  // no-OIDC bootstrap (docs/SETUP.md §8) mints the first PAT against one of
  // them via `tasks db mint-token --user <displayName>`.
  return repo.findServiceAccountByName(trimmed);
}

function parseScopes(csv: string | undefined): string[] {
  if (!csv) return [];
  return csv
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export const dbMintTokenCommand = new Command('mint-token')
  .description(
    'Mint a Personal Access Token by direct DB access. Bootstrap path for the first PAT before browser sessions land in Phase 29. The token is displayed exactly once.',
  )
  .requiredOption(
    '--user <id|email|displayName>',
    'User identifier — numeric id, email (case-insensitive), or legacy/service-account display_name',
  )
  .requiredOption('--name <name>', 'Human-readable token label')
  .option('--scopes <list>', 'Comma-separated scope list (advisory in v1.6; not enforced)')
  .option('--expires-at <iso>', 'ISO-8601 expiry timestamp (e.g. 2027-05-22T00:00:00Z)')
  .action(async (opts: { user: string; name: string; scopes?: string; expiresAt?: string }) => {
    const dbPath = resolveDbPath();
    const db = initDatabase(dbPath);
    try {
      // Idempotent on a current DB; surfaces a clear error against a
      // pre-Phase-27 schema (T-28-07-05).
      await runMigrations(db);

      const userRepo = new UserRepository(db);
      const apiTokenRepo = new ApiTokenRepository(db);

      const user = resolveUser(userRepo, opts.user);
      if (!user) {
        console.error(`User '${opts.user}' not found.`);
        process.exitCode = 1;
        return;
      }

      // Validate expires-at BEFORE generating a token / writing a row.
      if (opts.expiresAt !== undefined) {
        try {
          validateIso(opts.expiresAt);
        } catch (err) {
          console.error(`--expires-at: ${(err as Error).message}`);
          process.exitCode = 1;
          return;
        }
      }

      const scopes = parseScopes(opts.scopes);
      const { token, prefix, suffix, hash } = generateToken();
      const row = apiTokenRepo.insert({
        userId: user.id,
        name: opts.name,
        prefix,
        suffix,
        hash,
        scopes: JSON.stringify(scopes),
        expiresAt: opts.expiresAt ?? null,
      });

      console.log(`Token: ${token}`);
      console.log(`Id: ${row.id}`);
      console.log(`User: ${user.id} (${user.display_name})`);
      console.log(`Scopes: [${scopes.join(', ')}]`);
      if (opts.expiresAt) {
        console.log(`Expires: ${opts.expiresAt}`);
      }
    } finally {
      db.close();
    }
  });
