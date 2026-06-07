/**
 * Shared test-auth helper for the v2.0 Bearer/PAT contract.
 *
 * The legacy `X-API-Key` auth strategy was removed in the v2.0 auth cutover
 * (#799 server-side, #802 client-side), so test harnesses can no longer
 * bootstrap auth via `process.env.API_KEYS` + an `X-API-Key` header. This helper
 * mints a real Personal Access Token directly in the DB (a plain user row + a
 * non-revoked, non-expiring `api_tokens` row) and returns the `Authorization:
 * Bearer <pat>` header the PAT strategy accepts.
 *
 * Mechanism mirrors the proven `mintPatRow` pattern in `auth-chain.test.ts`.
 * Pure DB seeding — no network, no env.
 */
import type Database from 'better-sqlite3';
import { generateToken } from '../../../services/pat-hash.js';

export interface SeededAuth {
  /** The raw PAT string (only returned for tests that assert on it). */
  token: string;
  /** The api_tokens row id. */
  tokenId: number;
  /** The owning users row id. */
  userId: number;
  /** Ready-to-spread request headers authenticating as the seeded user. */
  headers: { Authorization: string };
}

export interface SeedAuthOptions {
  /** Display name for the seeded owner user (default 'test-user'). */
  displayName?: string;
  /** Name for the api_tokens row (default 'test-token'). */
  name?: string;
}

/**
 * Seed a user + a valid PAT into `db` and return its Bearer auth material.
 * Use `.headers` for the request; the other fields are for assertions.
 */
export function seedAuth(db: Database.Database, opts: SeedAuthOptions = {}): SeededAuth {
  const userInfo = db
    .prepare(`INSERT INTO users (display_name) VALUES (?)`)
    .run(opts.displayName ?? 'test-user');
  const userId = Number(userInfo.lastInsertRowid);

  const { token, prefix, suffix, hash } = generateToken();
  const tokenInfo = db
    .prepare(
      `INSERT INTO api_tokens (user_id, name, prefix, suffix, hash, scopes, revoked_at, expires_at)
       VALUES (?, ?, ?, ?, ?, '[]', NULL, NULL)`,
    )
    .run(userId, opts.name ?? 'test-token', prefix, suffix, hash);

  return {
    token,
    tokenId: Number(tokenInfo.lastInsertRowid),
    userId,
    headers: { Authorization: `Bearer ${token}` },
  };
}

/**
 * Convenience for the common case: seed a PAT and return only the Bearer
 * headers (drop-in replacement for the old `{ 'X-API-Key': key }`).
 */
export function authHeaders(
  db: Database.Database,
  opts?: SeedAuthOptions,
): { Authorization: string } {
  return seedAuth(db, opts).headers;
}
