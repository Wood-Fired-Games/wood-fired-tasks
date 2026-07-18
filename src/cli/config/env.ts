import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import path from 'path';
import { readCredentials } from '../auth/credentials.js';

// Resolve path to .env file at project root (3 levels up from src/cli/config/)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '../../..');
const envPath = path.join(projectRoot, '.env');

// Load environment variables from .env file. dotenv only fills keys that are
// NOT already set on process.env, so a real shell export always wins over a
// checked-out .env — and either way the value lands in process.env before
// resolveBaseUrl() below ever reads it, making the two indistinguishable
// (and equally authoritative) from that getter's perspective.
dotenv.config({ path: envPath, quiet: true });

/**
 * Resolve the REST API base URL the CLI / API client talks to.
 *
 * Precedence (highest wins):
 *   1. An explicit CLI flag override — no root-level `--base-url`/`--server`
 *      flag exists on the `tasks` program today, so this tier is currently a
 *      no-op. When one is added, resolve it in the caller and short-circuit
 *      before this function (or extend it to accept the flag value) so it
 *      keeps outranking everything below.
 *   2. `API_BASE_URL` environment variable, INCLUDING a repo-root `.env`
 *      (loaded above) — an explicit env source, so it outranks the
 *      credentials file even though the credentials file is "more recent"
 *      state. A checked-out `.env` is a conscious override (e.g. a
 *      dev pointing at a local server); it should not be silently shadowed
 *      by whatever server `tasks login`/`tasks setup --remote` last wrote.
 *   3. `credentials.active.server` — the base URL recorded for the
 *      currently active login. Reading this closes the split-brain bug:
 *      before this tier existed, `tasks whoami` (identity, sourced from
 *      credentials.active.server) and the data-plane client (only
 *      API_BASE_URL/default) could report two different servers after a
 *      `tasks setup --local`/`--remote` mode conversion.
 *   4. The hardcoded default, `http://localhost:3000`.
 *
 * Credential-file read errors (insecure permissions, malformed TOML) are
 * swallowed here and treated as "no credentials" for URL-resolution
 * purposes — `resolveAuth()` in `credentials.ts` re-reads the same file for
 * the Bearer token and is the correct place for that error to surface
 * loudly; base-URL resolution should degrade to the default rather than
 * throw before auth even runs.
 */
function resolveBaseUrl(): string {
  const fromEnv = process.env['API_BASE_URL'];
  if (fromEnv && fromEnv.length > 0) return fromEnv;

  try {
    const creds = readCredentials();
    if (creds && creds.active.server.length > 0) return creds.active.server;
  } catch {
    // Insecure permissions / malformed TOML — fall through to the default.
  }

  return 'http://localhost:3000';
}

// Plan 30-05: API_KEY is no longer required at env-load time. The CLI now
// authenticates via the precedence chain in src/cli/auth/credentials.ts —
// --token flag > credentials file > env.API_KEY > NotAuthenticatedError.
// The "no credentials" branch is enforced by resolveAuth (which throws
// NotAuthenticatedError), not here. Returning '' from the getter keeps the
// type narrow and lets resolveAuth's `apiKey.length > 0` check decide.
export const env = {
  // Getter (see resolveBaseUrl above) so callers re-resolve on each access —
  // important for tests that mutate env/credentials between calls, and for
  // long-lived processes where `tasks login`/`tasks setup` can change the
  // active credentials mid-run.
  get API_BASE_URL(): string {
    return resolveBaseUrl();
  },
  // Getter so callers re-read process.env.API_KEY on each access — important
  // for tests that mutate env between calls.
  get API_KEY(): string {
    return process.env['API_KEY'] ?? '';
  },
};
